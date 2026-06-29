'use strict';
// Normalisierte Content-Endpunkte (Buecher, Kapitel, Seiten) im App-Domain-Shape.
//
// Diese Datei ist nur noch eine duenne HTTP-Schicht: Validierung, Token-Check,
// Logging-Context — die eigentliche Storage-Logik (inkl. Mapper + cleanPageHtml)
// lebt in [lib/content-store.js](../lib/content-store.js).

const express = require('express');
const logger = require('../logger');
const contentStore = require('../lib/content-store');
const pageRevisions = require('../db/page-revisions');
const pagePresence = require('../db/page-presence');
const bookPresence = require('../db/book-presence');
const appUsersDevices = require('../db/app-users-devices');
const bookOrder = require('../db/book-order');
const { toIntId } = require('../lib/validate');
const { setContext, bookParamHandler } = require('../lib/log-context');
const { resolvePageBookId, resolveChapterBookId } = require('../lib/content-ownership');
const { aclParamGuard, requireBookAccess, sendACLError, ACLError } = require('../lib/acl');
const bookAccess = require('../db/book-access');
const { db } = require('../db/connection');
const { localIsoDaysAgo } = require('../lib/local-date');
const editorBundle = require('../lib/editor-bundle');
const macclientI18n = require('../lib/macclient-i18n');
const macclientRelease = require('../lib/macclient-release');
const androidclientRelease = require('../lib/androidclient-release');
const deviceTokens = require('../db/device-tokens');
const { createHash } = require('node:crypto');

const router = express.Router();
router.param('book_id', bookParamHandler);

function _userEmail(req) { return req.session?.user?.email || null; }

// Beschreibt den anfragenden Client fuer Logs. Bei Device-Token-Auth (nativer
// Mac-Client) loest es Geraetename + Plattform aus dem Token auf, sonst "session".
function _clientLabel(req) {
  const u = req.session?.user;
  if (u?.via !== 'device_token') return 'session';
  try {
    const dev = deviceTokens.getDeviceTokenById(u.tokenId);
    if (dev) return `device "${dev.device_name}"${dev.platform ? ` ${dev.platform}` : ''}`;
  } catch { /* Lookup-Fehler nie den Bundle-Download blockieren lassen */ }
  return 'device';
}

// Echter Geraetename aus dem Device-Token (nativer Client), fuer das
// app_users_devices.label → „Zuletzt bearbeitet auf <Geraet>"-Hint. Browser
// (Session-Auth) liefern null → upsertDevice faellt auf das UA-Label zurueck.
function _deviceTokenLabel(req) {
  const u = req.session?.user;
  if (u?.via !== 'device_token' || !u.tokenId) return null;
  try {
    const dev = deviceTokens.getDeviceTokenById(u.tokenId);
    return dev?.device_name?.trim() || null;
  } catch { return null; }
}

function _guardPage(req, res, pageId, minRole) {
  const bookId = resolvePageBookId(pageId);
  if (!bookId) { res.status(404).json({ error_code: 'PAGE_NOT_FOUND' }); return null; }
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return bookId; }
  catch (e) { sendACLError(res, e); return null; }
}

function _guardChapter(req, res, chapterId, minRole) {
  const bookId = resolveChapterBookId(chapterId);
  if (!bookId) { res.status(404).json({ error_code: 'CHAPTER_NOT_FOUND' }); return null; }
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return bookId; }
  catch (e) { sendACLError(res, e); return null; }
}

const jsonBody = express.json({ limit: '10mb' });
const NAME_MAX = 255;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _validDeviceId(s) { return typeof s === 'string' && UUID_RE.test(s); }

function _fail(res, e, opName) {
  const status = e?.status || 500;
  const bodySnippet = e?.bodyText ? ' | body: ' + String(e.bodyText).slice(0, 200) : '';
  logger.warn(`${opName} fehlgeschlagen: ${e.message}${bodySnippet}`);
  res.status(status === 401 ? 502 : status).json({
    error_code: 'CONTENT_FAILED',
    status,
    detail: e.message,
  });
}

// GET /content/books — Liste der fuer den User per book_access sichtbaren
// Buecher. Strikt gefiltert: Admin ohne Share-Row sieht leeres Array.
// Jedes Buch traegt `role` (eigene Buch-Rolle) und `owner_email` als Hint.
router.get('/books', async (req, res) => {
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const accessRows = bookAccess.listBookIdsForUser(email);
  if (accessRows.length === 0) return res.json([]);
  const allowedIds = new Set(accessRows.map(r => r.book_id));
  const roleByBook = new Map(accessRows.map(r => [r.book_id, r.role]));
  try {
    const all = await contentStore.listBooks(req);
    const meta = new Map(
      db.prepare(`
        SELECT b.book_id, b.owner_email, b.category_id, s.buchtyp
        FROM books b
        LEFT JOIN book_settings s ON s.book_id = b.book_id
      `).all().map(r => [r.book_id, {
        owner_email: r.owner_email,
        category_id: r.category_id,
        buchtyp: r.buchtyp,
      }])
    );
    const visible = all
      .filter(b => allowedIds.has(b.id))
      .map(b => ({
        ...b,
        role: roleByBook.get(b.id) || null,
        owner_email: meta.get(b.id)?.owner_email || null,
        category_id: meta.get(b.id)?.category_id ?? null,
        buchtyp: meta.get(b.id)?.buchtyp ?? null,
      }));
    res.json(visible);
  } catch (e) { _fail(res, e, 'GET /content/books'); }
});

// GET /content/books/:book_id — Buch-Detail.
router.get('/books/:book_id', aclParamGuard('viewer'), async (req, res) => {
  try {
    const book = await contentStore.loadBook(req.bookId, req);
    res.json({ ...book, role: req.bookRole });
  } catch (e) { _fail(res, e, 'GET /content/books/:id'); }
});

// GET /content/books/:book_id/tree — Hierarchie als `{ chapters, topPages }`.
router.get('/books/:book_id/tree', aclParamGuard('viewer'), async (req, res) => {
  try { res.json(await contentStore.bookTree(req.bookId, req)); }
  catch (e) { _fail(res, e, 'GET /content/books/:id/tree'); }
});

// GET /content/books/:book_id/changes?since=<iso>&device_id=<uuid> — Seiten, die
// seit `since` von einer ANDEREN Partei editiert wurden. „Andere Partei" =
// anderer User ODER ein anderes EIGENES Geraet (z.B. nativer Mac-Focus-Client).
// Nur der Echo des ANFRAGENDEN Geraets (gleiche device_id) wird ausgefiltert.
// Ohne `device_id` (Legacy-Client) faellt der Filter auf reine E-Mail-Exklusion
// zurueck. Polling-Endpoint fuer das Collab-Toast-Signal. Ohne `since` liefert er
// den Server-„jetzt"-Stempel + leeres Array (Baseline-Sync). Cap 200 Rows.
router.get('/books/:book_id/changes', aclParamGuard('viewer'), (req, res) => {
  const email = _userEmail(req);
  const sinceRaw = (req.query?.since || '').toString().trim();
  const nowIso = new Date().toISOString();
  if (!sinceRaw) return res.json({ now: nowIso, changes: [] });
  const since = !Number.isNaN(Date.parse(sinceRaw)) ? sinceRaw : nowIso;
  const reqDeviceId = (req.query?.device_id || '').toString();
  const hasDevice = _validDeviceId(reqDeviceId);
  let rows = [];
  try {
    // Mit device_id: nur ausfiltern, wenn der Edit von DIESEM Geraet stammt —
    // also gleiche E-Mail UND (device == mein Geraet ODER device unbekannt/NULL,
    // z.B. Server-/Job-Write, der weiter wie eigener Edit gilt). Fremde User und
    // eigene Edits von anderen Geraeten (non-NULL, abweichende device_id) bleiben.
    const selfFilter = hasDevice
      ? `AND NOT (p.last_editor_email = ?
                  AND (p.last_editor_device_id IS NULL OR p.last_editor_device_id = ?))`
      : `AND (? IS NULL OR p.last_editor_email <> ?)`;
    const selfArgs = hasDevice ? [email, reqDeviceId] : [email, email];
    rows = db.prepare(`
      SELECT p.page_id, p.page_name, p.chapter_id,
             p.updated_at, p.last_editor_email,
             u.display_name AS last_editor_name
        FROM pages p
        LEFT JOIN app_users u ON u.email = p.last_editor_email
       WHERE p.book_id = ?
         AND p.updated_at > ?
         AND p.last_editor_email IS NOT NULL
         ${selfFilter}
       ORDER BY p.updated_at ASC
       LIMIT 200
    `).all(req.bookId, since, ...selfArgs);
  } catch (e) {
    return _fail(res, e, 'GET /content/books/:id/changes');
  }
  res.json({
    now: nowIso,
    changes: rows.map(r => ({
      page_id: r.page_id,
      page_name: r.page_name || '',
      chapter_id: r.chapter_id || null,
      updated_at: r.updated_at,
      last_editor_email: r.last_editor_email,
      last_editor_name: r.last_editor_name || r.last_editor_email,
    })),
  });
});

// GET /content/books/:book_id/sync?since=<iso>&since_id=<n>&limit=<n> —
// Inkrementeller Delta-Pull fuer native Offline-Clients (Mac-Focus-Writer).
// Liefert ALLE seit dem Cursor geaenderten/neuen Seiten des Buchs INKLUSIVE
// eigener Edits, mit vollem HTML, damit der Client seinen lokalen Spiegel
// aktualisieren kann. (Unterschied zu /changes: das ist self-exkludierend +
// ohne HTML, fuer Collab-Toasts.) Ohne `since` = Voll-Pull (Baseline).
//
// Keyset-Cursor (updated_at, page_id): die Antwort traegt `cursor` (Position
// NACH der letzten gelieferten Seite) + `has_more`. Der Client paged mit diesem
// Cursor weiter, bis has_more=false. Push laeuft ueber den bestehenden
// PUT /content/pages/:id (409 PAGE_CONFLICT → Block-Merge clientseitig).
// Geloeschte Seiten: Client reconciled ueber GET /content/books/:id/tree.
const SYNC_PAGE_LIMIT = 200;
router.get('/books/:book_id/sync', aclParamGuard('viewer'), async (req, res) => {
  const sinceRaw = (req.query?.since || '').toString().trim();
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? sinceRaw : null;
  const sinceId = parseInt(req.query?.since_id, 10) || 0;
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || SYNC_PAGE_LIMIT, 1), SYNC_PAGE_LIMIT);
  const nowIso = new Date().toISOString();
  try {
    // limit+1 ziehen, um has_more ohne zweite Query zu erkennen.
    const metas = contentStore.pagesChangedSince(req.bookId, { since, sinceId }, limit + 1);
    const hasMore = metas.length > limit;
    const wanted = metas.slice(0, limit);
    const loaded = (await contentStore.loadPagesBatch(
      wanted.map(m => ({ id: m.id })), req, { onError: () => null }
    )).filter(Boolean);
    const pages = loaded.map(p => ({
      page_id: p.id,
      page_name: p.name,
      chapter_id: p.chapter_id,
      updated_at: p.updated_at,
      html: p.html,
    }));
    const last = wanted.length ? wanted[wanted.length - 1] : null;
    const cursor = last
      ? { since: last.updated_at, since_id: last.id }
      : { since: sinceRaw || null, since_id: sinceId };
    res.json({ now: nowIso, pages, has_more: hasMore, cursor });
  } catch (e) { _fail(res, e, 'GET /content/books/:id/sync'); }
});

// Eigene Sortierung.
//
// GET /content/books/:book_id/order — Tree-Snapshot + Audit-Meta. Auto-init:
// keine Row -> aus aktuellen pages.position/chapters.position bauen; vorhandene
// Row gegen DB-Stand reconcilen (neue/geloeschte Items).
router.get('/books/:book_id/order', aclParamGuard('viewer'), (req, res) => {
  try {
    const data = bookOrder.ensureTree(req.bookId, _userEmail(req));
    res.json(data);
  } catch (e) { _fail(res, e, 'GET /content/books/:id/order'); }
});

// PUT /content/books/:book_id/order — Vollstaendigen Tree speichern. Body:
// `{ order_json: [...] }`. Server validiert (Schema + Vollstaendigkeit +
// Doppel-IDs) und materialisiert chapters.position/pages.position/
// pages.chapter_id in einer Transaction.
router.put('/books/:book_id/order', aclParamGuard('editor'), jsonBody, (req, res) => {
  const tree = req.body?.order_json;
  if (!Array.isArray(tree)) {
    return res.status(400).json({ error_code: 'INVALID_BODY', detail: 'order_json must be array' });
  }
  try {
    const saved = bookOrder.putOrder(req.bookId, tree, _userEmail(req));
    res.json(saved);
  } catch (e) {
    if (e instanceof bookOrder.TreeValidationError) {
      return res.status(400).json({ error_code: 'INVALID_TREE', reason: e.code, detail: e.detail });
    }
    _fail(res, e, 'PUT /content/books/:id/order');
  }
});

// GET /content/chapters/:chapter_id — Kapitel-Detail.
router.get('/chapters/:chapter_id', async (req, res) => {
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  if (_guardChapter(req, res, chapterId, 'viewer') == null) return;
  try { res.json(await contentStore.loadChapter(chapterId, req)); }
  catch (e) { _fail(res, e, 'GET /content/chapters/:id'); }
});

// GET /content/pages/:page_id — Volltext + Metadaten.
router.get('/pages/:page_id', async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (_guardPage(req, res, pageId, 'viewer') == null) return;
  try { res.json(await contentStore.loadPage(pageId, req)); }
  catch (e) { _fail(res, e, 'GET /content/pages/:id'); }
});

// PUT /content/pages/:page_id — Free-Edit-Pfad. minRole editor.
// Blockiert durch fremden Page-Lock (lektorat-Session).
router.put('/pages/:page_id', jsonBody, async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const bookId = _guardPage(req, res, pageId, 'editor');
  if (bookId == null) return;
  const email = _userEmail(req);
  const blocking = bookAccess.getBlockingLockFor(pageId, email);
  if (blocking) return res.status(423).json({
    error_code: 'PAGE_LOCKED',
    locked_by_email: blocking.locked_by_email,
    expires_at: blocking.expires_at,
  });
  // Geraet, das den Edit schreibt, vorab registrieren — sonst verletzt das
  // FK-getragene pages.last_editor_device_id die Referenz auf app_users_devices,
  // falls der erste device-ping/presence-Heartbeat noch nicht durch ist.
  if (req.body && req.body.device_id !== undefined) {
    if (_validDeviceId(req.body.device_id)) {
      try {
        // Nativer Client (Device-Token-Auth) liefert seinen echten Geraetenamen
        // ueber device_tokens.device_name — als Label durchreichen, sonst stuende
        // im „Zuletzt bearbeitet"-Hint nur das UA-Label („Unbekanntes Geraet").
        appUsersDevices.upsertDevice(req.body.device_id, email, req.get('user-agent') || '', _deviceTokenLabel(req));
        // Push registriert das schreibende Geraet zugleich als Buch-Praesenz —
        // so erkennt ein paralleler Browser (eigener device-ping) das Zweit-Geraet
        // (z.B. nativer Mac-Client) ueber self_book_device_count und schaltet den
        // Collab-Poll frei, der dann diesen Edit via /changes als Remote-Change
        // einsammelt. Ephemeral (90s-Stale), kein eigener Heartbeat noetig.
        if (email) bookPresence.ping(bookId, email, req.body.device_id, pageId);
      } catch { /* nicht-fatal: savePage faellt auf NULL device zurueck */ }
    } else {
      // Ungueltige device_id verwerfen, damit savePage keine FK-Verletzung schreibt.
      req.body.device_id = null;
    }
  }
  try { res.json(await contentStore.savePage(pageId, req.body || {}, req)); }
  catch (e) {
    if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
    if (e.code === 'PAGE_CONFLICT') return res.status(409).json({
      error_code: 'PAGE_CONFLICT',
      server_updated_at: e.serverUpdatedAt || null,
      server_editor_email: e.serverEditorEmail || null,
      server_editor_name: e.serverEditorDisplay || e.serverEditorEmail || null,
    });
    _fail(res, e, 'PUT /content/pages/:id');
  }
});

// ── Page-Presence ──────────────────────────────────────────────────────────
// Heartbeat-Pings, damit die UI „Alice editiert gerade Seite X" anzeigen kann.
// Client pingt waehrend Edit-Mode alle 30s; Server filtert Stale-Eintraege
// (>90s) bei jedem List-Read.

// POST /content/pages/:page_id/presence — Heartbeat. Min-Role viewer reicht;
// Lese-Rollen koennen auch nur „lesen-da" signalisieren wenn wir das spaeter
// brauchen. Auf editor-Rolle gaten, falls Datenschutz das verlangt — derzeit
// keine Anforderung dafuer.
router.post('/pages/:page_id/presence', jsonBody, async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const bookId = _guardPage(req, res, pageId, 'editor');
  if (bookId == null) return;
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const deviceId = req.body?.device_id;
  if (!_validDeviceId(deviceId)) return res.status(400).json({ error_code: 'INVALID_DEVICE_ID' });
  try {
    appUsersDevices.upsertDevice(deviceId, email, req.get('user-agent') || '');
    pagePresence.ping(pageId, email, bookId, deviceId);
  } catch (e) { return _fail(res, e, 'POST /content/pages/:id/presence'); }
  res.json({ ok: true });
});

// DELETE /content/pages/:page_id/presence — Eigener Edit-Exit (cancel/blur).
// Optional — Stale-Filter wuerde den Eintrag eh nach 90s entfernen, aber
// expliziter Abmelden gibt der UI sofortige Korrektheit.
router.delete('/pages/:page_id/presence', jsonBody, async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const bookId = _guardPage(req, res, pageId, 'viewer');
  if (bookId == null) return;
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  // Body wird bei sendBeacon/keepalive nicht immer geparst; Query als Fallback.
  const deviceId = req.body?.device_id || req.query?.device_id;
  if (!_validDeviceId(deviceId)) return res.status(400).json({ error_code: 'INVALID_DEVICE_ID' });
  try { pagePresence.leave(pageId, email, deviceId); }
  catch (e) { return _fail(res, e, 'DELETE /content/pages/:id/presence'); }
  res.json({ ok: true });
});

// POST /content/books/:book_id/device-ping — leichter Geraete-Heartbeat (Buch
// offen, nicht zwingend Edit-Mode). Bootstrap fuer page-scoped
// Multi-Device-Erkennung: Body traegt die aktuell offene `page_id` (optional),
// Antwort enthaelt `self_page_device_count` (aktive eigene Geraete auf DERSELBEN
// Seite inkl. diesem) UND `self_book_device_count` (eigene Geraete im GANZEN Buch,
// seitenuebergreifend). Der Client startet den vollen Collab-Poll, sobald eine der
// beiden >1 ist — so wird ein eigenes Zweit-Geraet (z.B. nativer Mac-Client) auch
// bei Einzel-Owner-Buechern sichtbar, selbst wenn es eine ANDERE Seite editiert.
// Min-Role viewer.
router.post('/books/:book_id/device-ping', aclParamGuard('viewer'), jsonBody, (req, res) => {
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const deviceId = req.body?.device_id;
  if (!_validDeviceId(deviceId)) return res.status(400).json({ error_code: 'INVALID_DEVICE_ID' });
  // page_id optional. Nur akzeptieren, wenn die Seite zu DIESEM Buch gehoert —
  // sonst null (verhindert fremde page_id im eigenen Praesenz-Zaehler).
  let pageId = toIntId(req.body?.page_id);
  if (pageId && resolvePageBookId(pageId) !== req.bookId) pageId = null;
  try {
    appUsersDevices.upsertDevice(deviceId, email, req.get('user-agent') || '');
    bookPresence.ping(req.bookId, email, deviceId, pageId);
    const selfPageDeviceCount = pageId ? bookPresence.countSelfDevicesOnPage(pageId, email) : 0;
    const selfBookDeviceCount = bookPresence.countSelfDevicesInBook(req.bookId, email);
    res.json({
      ok: true,
      self_page_device_count: selfPageDeviceCount,
      self_book_device_count: selfBookDeviceCount,
    });
  } catch (e) { return _fail(res, e, 'POST /content/books/:id/device-ping'); }
});

// DELETE /content/books/:book_id/device-ping — Buch geschlossen/gewechselt.
// Optional (Stale-Filter raeumt eh nach 90s), aber gibt der Erkennung sofortige
// Korrektheit. device_id auch als Query — keepalive/sendBeacon verschluckt Body.
router.delete('/books/:book_id/device-ping', aclParamGuard('viewer'), jsonBody, (req, res) => {
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const deviceId = req.body?.device_id || req.query?.device_id;
  if (!_validDeviceId(deviceId)) return res.status(400).json({ error_code: 'INVALID_DEVICE_ID' });
  try { bookPresence.leave(req.bookId, email, deviceId); }
  catch (e) { return _fail(res, e, 'DELETE /content/books/:id/device-ping'); }
  res.json({ ok: true });
});

// GET /content/books/:book_id/presence?device_id=… — Liste aktiver Sessions am Buch.
// Filtert die anrufende Session (gleicher User + gleiche device_id) raus. Sessions
// desselben Users auf anderen Geraeten bleiben sichtbar (`is_self: true`), damit
// der User sein eigenes Multi-Device sehen kann.
router.get('/books/:book_id/presence', aclParamGuard('viewer'), (req, res) => {
  const email = _userEmail(req);
  const selfDevice = (req.query?.device_id || '').toString();
  let rows;
  try { rows = pagePresence.listForBook(req.bookId); }
  catch (e) { return _fail(res, e, 'GET /content/books/:id/presence'); }
  const selfEmailLc = email ? String(email).toLowerCase() : null;
  const filtered = rows
    .filter(r => {
      if (!selfEmailLc) return true;
      const sameUser = String(r.user_email).toLowerCase() === selfEmailLc;
      const sameDevice = selfDevice && r.device_id === selfDevice;
      // eigene aktuelle Session droppen; eigene andere Geraete behalten.
      return !(sameUser && sameDevice);
    })
    .map(r => ({
      page_id: r.page_id,
      user_email: r.user_email,
      user_display_name: r.user_display_name || r.user_email,
      device_id: r.device_id,
      device_label: r.device_label || null,
      is_self: selfEmailLc ? String(r.user_email).toLowerCase() === selfEmailLc : false,
      last_ping_at: r.last_ping_at,
    }));
  res.json({ presence: filtered });
});

// ── Page-Revisions ─────────────────────────────────────────────────────────
// Schreib-Hook lebt in der content-store-Facade (jeder erfolgreiche
// savePage → page_revisions-Row). Routen hier sind nur Lese-Pfad + Restore.

// GET /content/pages/:page_id/revisions — Liste (ohne body_html).
router.get('/pages/:page_id/revisions', async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (_guardPage(req, res, pageId, 'viewer') == null) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  res.json({ revisions: pageRevisions.listForPage(pageId, limit) });
});

// GET /content/pages/:page_id/revisions/:rev_id — Voller Body fuer Vorschau.
router.get('/pages/:page_id/revisions/:rev_id', async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  const revId = toIntId(req.params.rev_id);
  if (!pageId || !revId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (_guardPage(req, res, pageId, 'viewer') == null) return;
  const rev = pageRevisions.get(revId);
  if (!rev || rev.page_id !== pageId) return res.status(404).json({ error_code: 'REVISION_NOT_FOUND' });
  res.json({ revision: rev });
});

// POST /content/pages/:page_id/revisions/:rev_id/restore — Body der Revision
// wird via Facade als neue Revision (source='main') zurueckgeschrieben.
// Page-Lock + editor-Rolle wie der normale Save-Pfad.
router.post('/pages/:page_id/revisions/:rev_id/restore', jsonBody, async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  const revId = toIntId(req.params.rev_id);
  if (!pageId || !revId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _guardPage(req, res, pageId, 'editor');
  if (bookId == null) return;
  const email = _userEmail(req);
  const blocking = bookAccess.getBlockingLockFor(pageId, email);
  if (blocking) return res.status(423).json({
    error_code: 'PAGE_LOCKED',
    locked_by_email: blocking.locked_by_email,
    expires_at: blocking.expires_at,
  });
  const rev = pageRevisions.get(revId);
  if (!rev || rev.page_id !== pageId) return res.status(404).json({ error_code: 'REVISION_NOT_FOUND' });
  try {
    const saved = await contentStore.savePage(
      pageId,
      { html: rev.body_html, source: 'main', summary: `restored from #${revId}` },
      req,
    );
    res.json({ ok: true, page: saved, restored_from: revId });
  } catch (e) {
    if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
    _fail(res, e, 'POST /content/pages/:id/revisions/:rev/restore');
  }
});

// POST /content/pages — Neue Seite. Body: { book_id?, chapter_id?, name, html? }.
// Mindestens einer von book_id/chapter_id ist Pflicht. minRole editor.
router.post('/pages', jsonBody, async (req, res) => {
  const bookIdRaw = req.body?.book_id !== undefined ? toIntId(req.body.book_id) : null;
  const chapterIdRaw = req.body?.chapter_id !== undefined ? toIntId(req.body.chapter_id) : null;
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  if (!bookIdRaw && !chapterIdRaw) return res.status(400).json({ error_code: 'BOOK_OR_CHAPTER_REQUIRED' });
  const effBookId = bookIdRaw || resolveChapterBookId(chapterIdRaw);
  if (!effBookId) return res.status(404).json({ error_code: 'BOOK_NOT_FOUND' });
  setContext({ book: effBookId });
  try { requireBookAccess(req, effBookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  try {
    const created = await contentStore.createPage({
      book_id: effBookId,
      chapter_id: chapterIdRaw || undefined,
      name,
      html: req.body?.html,
    }, req);
    res.json(created);
  } catch (e) { _fail(res, e, 'POST /content/pages'); }
});

// DELETE /content/pages/:page_id — Seite in den Papierkorb. minRole editor.
router.delete('/pages/:page_id', async (req, res) => {
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (_guardPage(req, res, pageId, 'editor') == null) return;
  try {
    await contentStore.deletePage(pageId, req);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/pages/:id'); }
});

// POST /content/chapters — Neues Kapitel. Body: { book_id, name, position?, parent_chapter_id? }.
router.post('/chapters', jsonBody, async (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  const name = (req.body?.name || '').toString().trim();
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  try {
    const parentChapterId = Number.isFinite(req.body?.parent_chapter_id) ? req.body.parent_chapter_id : null;
    const created = await contentStore.createChapter({
      book_id: bookId,
      name,
      position: req.body?.position,
      parent_chapter_id: parentChapterId,
    }, req);
    res.json(created);
  } catch (e) { _fail(res, e, 'POST /content/chapters'); }
});

// PUT /content/chapters/:chapter_id — Kapitel-Update (rename / reorder).
router.put('/chapters/:chapter_id', jsonBody, async (req, res) => {
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  const hasName = typeof req.body?.name === 'string';
  const hasPos = Number.isFinite(req.body?.position);
  if (!hasName && !hasPos) {
    return res.status(400).json({ error_code: 'EMPTY_BODY' });
  }
  if (_guardChapter(req, res, chapterId, 'editor') == null) return;
  try { res.json(await contentStore.updateChapter(chapterId, req.body || {}, req)); }
  catch (e) { _fail(res, e, 'PUT /content/chapters/:id'); }
});

// DELETE /content/chapters/:chapter_id — Kapitel + seine Seiten in den Papierkorb.
router.delete('/chapters/:chapter_id', async (req, res) => {
  const chapterId = toIntId(req.params.chapter_id);
  if (!chapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
  if (_guardChapter(req, res, chapterId, 'editor') == null) return;
  try {
    await contentStore.deleteChapter(chapterId, req);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/chapters/:id'); }
});

// PUT /content/books/:book_id — Buch-Update (rename / description). minRole editor.
router.put('/books/:book_id', aclParamGuard('editor'), jsonBody, async (req, res) => {
  const hasName = typeof req.body?.name === 'string';
  const hasDesc = typeof req.body?.description === 'string';
  if (!hasName && !hasDesc) return res.status(400).json({ error_code: 'EMPTY_BODY' });
  const body = { ...req.body };
  if (hasName) {
    const trimmed = body.name.trim();
    if (!trimmed) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
    if (trimmed.length > NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: NAME_MAX } });
    body.name = trimmed;
  }
  try { res.json(await contentStore.updateBook(req.bookId, body, req)); }
  catch (e) { _fail(res, e, 'PUT /content/books/:id'); }
});

// DELETE /content/books/:book_id — Buch loeschen. minRole owner.
router.delete('/books/:book_id', aclParamGuard('owner'), async (req, res) => {
  try {
    await contentStore.deleteBook(req.bookId, req);
    res.json({ ok: true });
  } catch (e) { _fail(res, e, 'DELETE /content/books/:id'); }
});

// GET /content/search?query=…&book_id=… — Volltextsuche, nur Page-Hits.
// Mit book_id: viewer-Guard auf Buch. Ohne book_id: filtert auf
// book_access-Buecher des Users (Cross-Book-Suche).
router.get('/search', async (req, res) => {
  const query = (req.query?.query || '').toString().trim();
  const bookId = req.query?.book_id ? toIntId(req.query.book_id) : null;
  const count = req.query?.count;
  if (query.length < 2) return res.json({ hits: [] });
  if (bookId) {
    setContext({ book: bookId });
    try { requireBookAccess(req, bookId, 'viewer'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }
  const email = _userEmail(req);
  const allowedIds = new Set(bookAccess.listBookIdsForUser(email).map(r => r.book_id));
  try {
    const hits = await contentStore.searchPages(query, { bookId, count }, req);
    const filtered = bookId ? hits : hits.filter(h => !h.book_id || allowedIds.has(h.book_id));
    res.json({ hits: filtered });
  } catch (e) { _fail(res, e, 'GET /content/search'); }
});

// POST /content/books — Neues Buch anlegen. Anleger wird automatisch Owner
// via book_access-Row.
router.post('/books', jsonBody, async (req, res) => {
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const name = (req.body?.name || '').toString().trim();
  const description = (req.body?.description || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  if (name.length > NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: NAME_MAX } });
  try {
    const created = await contentStore.createBook({ name, description }, req);
    setContext({ book: created.id });
    // Owner-Grant + books.owner_email setzen (idempotent).
    try {
      db.prepare(`UPDATE books SET owner_email = COALESCE(owner_email, ?) WHERE book_id = ?`)
        .run(email, created.id);
      bookAccess.grantAccess(created.id, email, 'owner', email);
    } catch (gErr) {
      logger.warn(`Auto-Owner-Grant fuer book=${created.id} fehlgeschlagen: ${gErr.message}`);
    }
    // Baseline-Snapshot Vortag: gibt dem Tages-Donut einen prevChars-Wert,
    // damit erstes Schreiben am Anlege-Tag bereits korrekt als Delta zaehlt.
    try {
      db.prepare(`
        INSERT OR IGNORE INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count)
        VALUES (?, ?, 0, 0, 0, 0, 0, 0)
      `).run(created.id, localIsoDaysAgo(1));
    } catch (sErr) {
      logger.warn(`Baseline-Snapshot fuer book=${created.id} fehlgeschlagen: ${sErr.message}`);
    }
    logger.info(`Buch erstellt id=${created.id} name="${created.name}" owner=${email}`);
    res.json({ ...created, role: 'owner' });
  } catch (e) {
    const status = e?.status || 500;
    let detail = '';
    try {
      const parsed = JSON.parse(e?.bodyText || '{}');
      const validation = parsed?.error?.validation;
      detail = validation && typeof validation === 'object'
        ? Object.values(validation).flat().filter(Boolean).join('; ')
        : (parsed?.error?.message || parsed?.message || '');
    } catch { /* bodyText kein JSON */ }
    logger.warn(`Buch erstellen fehlgeschlagen: ${status} ${detail || e.message}`);
    res.status(status === 401 ? 502 : status).json({
      error_code: 'CREATE_FAILED',
      status,
      detail: detail || e.message,
    });
  }
});

// GET /content/editor-bundle.zip — OTA-Bundle des Focus-Editors fuer den nativen
// macOS-Client (schreibwerkstatt-focuseditor), der die Editor-Assets zur Laufzeit
// zieht und lokal cacht (statt sie zur Build-Zeit aus dem Repo zu kopieren).
//
// Inhalt (strukturerhaltend, Pfade relativ wie unter public/): die transitive
// ES-Modul-Import-Closure ab focus.js / focus/standalone.js /
// shared/editor-host.js / shared/block-merge.js, die Focus-Editor-CSS-Dateien
// und ein bundle-manifest.json ({ sourceCommit, jsFiles[], cssFiles[] }). KEIN
// index.html — das Boot-/Bridge-HTML besitzt der Client. Closure-Logik (SSoT)
// in [lib/editor-bundle.js](../lib/editor-bundle.js).
//
// Auth: greift ueber den globalen Guard (server.js) — Session ODER Device-Token
// (Bearer swd_…) wie alle /content/-Routen; keine zusaetzliche unauthentifizierte
// Flaeche (Editor-JS waere unter public/js zwar ohnehin oeffentlich).
//
// ETag = sha256(sourceCommit + sortierte Datei-Hashes). Bei If-None-Match mit
// passendem ETag → 304 ohne Body, sodass der Client bei jedem Online-Start
// konditional anfragen kann, ohne ein unveraendertes Bundle neu zu laden.
router.get('/editor-bundle.zip', async (req, res) => {
  try {
    const { etag, buffer } = await editorBundle.getBundle();
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
    const client = _clientLabel(req);
    if (req.headers['if-none-match'] === etag) {
      logger.info(`editor-bundle.zip: 304 unveraendert (${client}, etag=${etag.slice(0, 12)})`);
      return res.status(304).end();
    }
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="editor-bundle.zip"');
    logger.info(`editor-bundle.zip: ausgeliefert (${client}, ${(buffer.length / 1024).toFixed(0)} KB, etag=${etag.slice(0, 12)})`);
    res.send(buffer);
  } catch (e) { _fail(res, e, 'GET /content/editor-bundle.zip'); }
});

// GET /content/macclient-i18n.json — OTA-Override der UI-Strings des nativen
// macOS-Clients (schreibwerkstatt-focuseditor). Body: { de: {…}, en: {…} },
// flaches Key→Value je Locale. Der Client liefert dieselben Kataloge gebuendelt
// mit; dieser Endpunkt erlaubt es, einzelne Keys zentral zu ueberschreiben —
// fehlende Keys fallen im Client auf den gebuendelten Stand zurueck. SSoT der
// Server-Overrides: assets/macclient-i18n/{de,en}.json (Details in
// [lib/macclient-i18n.js](../lib/macclient-i18n.js)).
//
// Auth: globaler Guard (server.js) — Session ODER Device-Token, wie alle
// /content/-Routen. ETag = sha256(Body); bei If-None-Match mit passendem ETag →
// 304 ohne Body, sodass der Client konditional anfragen kann.
router.get('/macclient-i18n.json', (req, res) => {
  try {
    const { etag, body } = macclientI18n.getCatalogs();
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
    const client = _clientLabel(req);
    if (req.headers['if-none-match'] === etag) {
      logger.info(`macclient-i18n.json: 304 unveraendert (${client}, etag=${etag.slice(1, 13)})`);
      return res.status(304).end();
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    logger.info(`macclient-i18n.json: ausgeliefert (${client}, ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB, etag=${etag.slice(1, 13)})`);
    res.send(body);
  } catch (e) { _fail(res, e, 'GET /content/macclient-i18n.json'); }
});

// GET /content/macclient/release.json — latest-Release-Metadaten der nativen
// macOS-App (schreibwerkstatt-focuseditor) fuer den Download-Hinweis im Profil.
// Body: { available, version, notes, publishedAt, dmg:{ name, sizeBytes,
// downloadUrl } } bzw. { available:false }. Quelle: GitHub-Public-API ueber
// [lib/macclient-release.js](../lib/macclient-release.js) (In-Memory-Cache).
//
// Die UI verlinkt direkt auf dmg.downloadUrl (GitHub-CDN) — kein Download-Proxy.
// Da das Client-Repo oeffentlich ist, ist die Asset-URL selbst oeffentlich; der
// Download wird nur Eingeloggten *angezeigt* (Anzeige-Gating, kein Hard-Gating).
//
// Auth: globaler Guard (server.js). ETag = sha256(version); bei If-None-Match
// mit passendem ETag → 304 ohne Body.
router.get('/macclient/release.json', async (req, res) => {
  try {
    const rel = await macclientRelease.getLatestRelease();
    const body = JSON.stringify(rel);
    const etag = `"${createHash('sha256').update(`macclient-release:${rel.available ? rel.version : 'none'}`).digest('hex')}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.send(body);
  } catch (e) { _fail(res, e, 'GET /content/macclient/release.json'); }
});

// GET /content/android/release.json — latest-Release-Metadaten der nativen
// Android-App (schreibwerkstatt-mobile) fuer den Download-Hinweis im Profil.
// Body: { available, version, notes, publishedAt, apk:{ name, sizeBytes,
// downloadUrl } } bzw. { available:false }. Quelle: GitHub-Public-API ueber
// [lib/androidclient-release.js](../lib/androidclient-release.js) (In-Memory-Cache).
//
// Die UI verlinkt direkt auf apk.downloadUrl (GitHub-CDN) — kein Download-Proxy.
// Da das Client-Repo oeffentlich ist, ist die Asset-URL selbst oeffentlich; der
// Download wird nur Eingeloggten *angezeigt* (Anzeige-Gating, kein Hard-Gating).
//
// Auth: globaler Guard (server.js). ETag = sha256(version); bei If-None-Match
// mit passendem ETag → 304 ohne Body.
router.get('/android/release.json', async (req, res) => {
  try {
    const rel = await androidclientRelease.getLatestRelease();
    const body = JSON.stringify(rel);
    const etag = `"${createHash('sha256').update(`androidclient-release:${rel.available ? rel.version : 'none'}`).digest('hex')}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.send(body);
  } catch (e) { _fail(res, e, 'GET /content/android/release.json'); }
});

module.exports = router;
