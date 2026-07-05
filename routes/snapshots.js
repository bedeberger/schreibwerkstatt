'use strict';

// Manuskript-Meilensteine: ganze-Buch-Snapshots („Fassung 1/2/3").
// Capture spiegelt den swbook-Export (routes/book-migration.js), legt das
// Ergebnis aber als selbsttragende Zeile in book_snapshots ab statt als ZIP:
//   content_json = buildBookJson({ book, settings, tree })   (Seiten-HTML inline)
//   extras_json  = collectExtras(bookId, { analysis, lektorat })
// v1 ist Lese-/Diff-only: kein ganz-Buch-Restore. extras_json wird gespeichert
// (fuer spaeteren Restore), aber nie an den Client geliefert.

const express = require('express');
const logger = require('../logger');
const contentStore = require('../lib/content-store');
const { getBookSettings, saveBookSettings, setBookEntitiesEnabled } = require('../db/schema');
const { treeToNodes, buildBookJson, validateBookJson, planFromNodes } = require('../lib/book-bundle');
const { collectExtras } = require('../db/book-migration-data');
const { htmlToPlainText } = require('../lib/html-text');
const { snapshotToBundle, snapshotPublication } = require('../lib/snapshot-export');
const { FORMATS } = require('../lib/export-builders');
const { buildExportMeta, sendExportBuffer } = require('../lib/export-send');
const { buildExportFilename } = require('../lib/filenames');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const bookOrder = require('../db/book-order');
const snapshots = require('../db/book-snapshots');

const router = express.Router();

const LABEL_MAX = 120;
const DESC_MAX = 1000;

// Label der automatischen Sicherung, die ein Restore anlegt. Persistiert als
// __i18n:-Marker, damit der spaetere Betrachter die Bezeichnung in seiner
// eigenen Locale sieht (Frontend loest via t() auf).
const AUTO_BACKUP_LABEL = '__i18n:snapshots.autoBackupLabel__';

function _err(code) { const e = new Error(code); e.code = code; return e; }

function _clip(s, max) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// Alle Seiten-Metas (Top-Pages + rekursiv aus Kapiteln) flach einsammeln.
function _collectMetas(tree) {
  const metas = [];
  for (const p of (tree.topPages || [])) metas.push(p);
  (function walk(chapters) {
    for (const c of (chapters || [])) {
      for (const p of (c.pages || [])) metas.push(p);
      walk(c.subchapters || []);
    }
  })(tree.chapters || []);
  return metas;
}

// Kapitel (inkl. Sub-Kapitel) im node-Tree zaehlen.
function _countChapters(nodes) {
  let n = 0;
  (function walk(list) {
    for (const node of (list || [])) {
      if (node && node.type === 'chapter') { n += 1; walk(node.children); }
    }
  })(nodes);
  return n;
}

// Selbsttragende Momentaufnahme des aktuellen Buchstands bauen (content_json +
// extras_json + Stats). Gemeinsame Basis fuer „Fassung speichern" und die
// automatische Sicherung vor einem Restore. Wirft typisierte Fehler:
//   BOOK_EMPTY     — Buch hat keine Seiten
//   CAPTURE_FAILED — Load der Inhalte fehlgeschlagen
async function _buildSnapshotPayload(bookId, req) {
  let book, tree;
  try {
    [book, tree] = await Promise.all([
      contentStore.loadBook(bookId, req),
      contentStore.bookTree(bookId, req),
    ]);
  } catch (e) {
    if (e.status === 404) throw _err('NOT_FOUND');
    throw _err('CAPTURE_FAILED');
  }

  const metas = _collectMetas(tree);
  if (!metas.length) throw _err('BOOK_EMPTY');

  let details;
  try {
    details = await contentStore.loadPagesBatch(metas, req, { batchSize: 15, onError: () => null });
  } catch (e) {
    throw _err('CAPTURE_FAILED');
  }
  const htmlById = new Map();
  for (const d of details) if (d && d.id) htmlById.set(d.id, d.html || '');

  // Manuskript-Bild-BLOBs mitziehen, damit sie einen Restore ueberleben
  // (Restore wiped Seiten → CASCADE loescht page_images, neue page_ids).
  const { collectReferencedImages } = require('../db/page-images');
  const imagesByPage = collectReferencedImages(htmlById);
  const nodes = treeToNodes(tree, htmlById, imagesByPage);
  const settings = (() => { try { return getBookSettings(bookId); } catch { return null; } })();
  const content = buildBookJson({ book, settings, nodes });

  // Stats aus dem inline-HTML (gleiche Normalisierung wie page_stats).
  let chars = 0; let words = 0;
  for (const html of htmlById.values()) {
    const text = htmlToPlainText(html);
    chars += text.length;
    if (text) words += text.split(/\s+/).filter(Boolean).length;
  }

  // Extras (Analyse + Lektorat) synchron einsammeln — reiner DB-Read, kein KI-Call.
  let extrasJson = null;
  try {
    const extras = collectExtras(bookId, { analysis: true, lektorat: true });
    if (extras && (extras.analysis || extras.lektorat)) extrasJson = JSON.stringify(extras);
  } catch (e) {
    logger.warn(`Snapshot-Extras fehlgeschlagen (book=${bookId}): ${e.message}`);
  }

  // Publikations-Metadaten selbsttragend einfrieren (Titelei/epub_*-Optionen +
  // Cover/Autorfoto als base64), damit ein Fassungs-Export den Stand zum Capture-
  // Zeitpunkt nutzt statt der Live-book_publication. Nur wenn eine echte Zeile
  // existiert (getMeta.created_at) — sonst faellt der Export auf die Live-Defaults.
  let publicationJson = null;
  try {
    const bp = require('../db/book-publication');
    const meta = bp.getMeta(bookId);
    if (meta && meta.created_at) {
      const pub = { meta };
      if (meta.has_cover) {
        const c = bp.getCover(bookId);
        if (c && c.image) pub.cover = { b64: c.image.toString('base64'), mime: c.mime || 'image/jpeg' };
      }
      if (meta.has_author_image) {
        const a = bp.getAuthorImage(bookId);
        if (a && a.image) pub.authorImage = { b64: a.image.toString('base64'), mime: a.mime || 'image/jpeg' };
      }
      publicationJson = JSON.stringify(pub);
    }
  } catch (e) {
    logger.warn(`Snapshot-Publikation fehlgeschlagen (book=${bookId}): ${e.message}`);
  }

  return { content, extrasJson, publicationJson, chars, words, pages: htmlById.size, chapters: _countChapters(nodes) };
}

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/:bookId', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  if (!bookId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  try {
    return res.json({ snapshots: snapshots.listSnapshots(bookId) });
  } catch (e) {
    logger.error(`Snapshot-Liste fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(500).json({ error_code: 'LIST_FAILED' });
  }
});

// ── Get (content only, fuer Diff) ──────────────────────────────────────────────
router.get('/:bookId/:id', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });

  let content;
  try { content = JSON.parse(row.content_json); }
  catch { return res.status(500).json({ error_code: 'CORRUPT_SNAPSHOT' }); }

  // extras_json bewusst NICHT mitliefern (v1: kein Restore, Diff nutzt nur Tree).
  return res.json({
    snapshot: {
      id: row.id, seq: row.seq, label: row.label, description: row.description,
      chars: row.chars, words: row.words, pages: row.pages, chapters: row.chapters,
      user_email: row.user_email, created_at: row.created_at,
      has_publication: row.publication_json ? 1 : 0,
      content,
    },
  });
});

// ── Export (Fassung in pdf/html/txt/md/epub/docx) ───────────────────────────────
// Exportiert den selbsttragenden Stand der Fassung — unabhaengig vom aktuellen
// Buchinhalt. PDF laeuft NICHT hier, sondern als Job (routes/jobs/pdf-export.js
// mit snapshotId), wegen Render-Dauer + Profil-Auswahl. Synchroner Pfad wie
// routes/export.js (reiner DB-Read + Build).
router.get('/:bookId/:id/export/:fmt', async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  const fmt = String(req.params.fmt || '').toLowerCase();
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  // PDF laeuft ausschliesslich ueber den Job-Pfad (Custom-Profile) — hier nicht.
  const spec = fmt === 'pdf' ? null : FORMATS[fmt];
  if (!spec) return res.status(400).json({ error_code: 'BAD_FORMAT' });

  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'SNAPSHOT_NOT_FOUND' });

  let bundle;
  try {
    const content = JSON.parse(row.content_json);
    validateBookJson(content);
    bundle = snapshotToBundle(content, { bookId });
    if (!bundle.groups.length) throw _err('CORRUPT_SNAPSHOT');
  } catch (e) {
    logger.error(`Fassungs-Export: Fassung defekt (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' });
  }

  // Eingefrorene Publikation der Fassung bevorzugen (fmt='epub' konsumiert sie);
  // fehlt sie, faellt buildExportMeta auf die Live-book_publication zurueck.
  const publication = snapshotPublication(row.publication_json);
  let buf;
  try {
    buf = await spec.build(bundle, buildExportMeta(bookId, fmt, { publication }));
  } catch (e) {
    logger.error(`Fassungs-Export-Build fehlgeschlagen (book=${bookId}, id=${id}, fmt=${fmt}): ${e.message}`);
    return res.status(502).json({ error_code: 'EXPORT_FAILED' });
  }

  const { resolveSlug } = require('../lib/export-builders/shared');
  const slug = `${resolveSlug(bundle)}-fassung-${row.seq}`;
  const filename = buildExportFilename({ prefix: 'fassung', slug, ext: spec.ext || fmt, date: new Date() });
  const sizeKb = Math.round((Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(buf)) / 1024);
  logger.info(`Fassungs-Export «${filename}» (${sizeKb} KB, book=${bookId}, seq=${row.seq}, fmt=${fmt})`);
  return sendExportBuffer(res, { spec, buf, filename });
});

// ── Create (Fassung speichern) ──────────────────────────────────────────────────
router.post('/:bookId', express.json({ limit: '1mb' }), async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  if (!bookId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const label = _clip(req.body?.label, LABEL_MAX);
  const description = _clip(req.body?.description, DESC_MAX);

  let payload;
  try {
    payload = await _buildSnapshotPayload(bookId, req);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (e.code === 'BOOK_EMPTY') return res.status(400).json({ error_code: 'BOOK_EMPTY' });
    logger.error(`Snapshot-Capture fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'CAPTURE_FAILED' });
  }

  const userEmail = req.session?.user?.email || null;
  let created;
  try {
    created = snapshots.createSnapshot({
      bookId, label, description,
      contentJson: JSON.stringify(payload.content), extrasJson: payload.extrasJson,
      publicationJson: payload.publicationJson,
      chars: payload.chars, words: payload.words, pages: payload.pages, chapters: payload.chapters,
      userEmail,
    });
  } catch (e) {
    logger.error(`Snapshot-Insert fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(500).json({ error_code: 'CAPTURE_FAILED' });
  }

  logger.info(`Snapshot «Fassung ${created.seq}» angelegt (book=${bookId}, pages=${payload.pages}, chars=${payload.chars}).`);
  return res.json({
    snapshot: {
      id: created.id, seq: created.seq, label, description,
      chars: payload.chars, words: payload.words, pages: payload.pages, chapters: payload.chapters,
      user_email: userEmail,
      created_at: new Date().toISOString(),
      has_extras: payload.extrasJson ? 1 : 0,
      has_publication: payload.publicationJson ? 1 : 0,
    },
  });
});

// ── Restore (Buch auf eine Fassung zuruecksetzen) ───────────────────────────────
// Destruktiv: ersetzt den GESAMTEN aktuellen Buchinhalt (Kapitel + Seiten) durch
// den Stand der Ziel-Fassung. Vorher wird automatisch eine Sicherung des
// aktuellen Stands als neue Fassung abgelegt → der Schritt ist umkehrbar.
// Synchroner Pfad wie der Capture (reiner DB-Read/-Write, kein KI-/Netz-Call).
router.post('/:bookId/:id/restore', express.json({ limit: '1mb' }), async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  // Ziel-Fassung laden + zu Op-Liste planen.
  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
  let plan;
  try {
    const content = JSON.parse(row.content_json);
    validateBookJson(content);
    plan = planFromNodes(content.tree);
    if (!plan.ops.length) throw _err('CORRUPT_SNAPSHOT');
    plan.settings = content.book?.settings || null;
  } catch (e) {
    logger.error(`Restore: Ziel-Fassung defekt (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' });
  }

  const userEmail = req.session?.user?.email || null;

  // 1) Automatische Sicherung des aktuellen Stands → Restore bleibt umkehrbar.
  //    BOOK_EMPTY (Buch hat gerade keine Seiten) ist ok — dann gibt es nichts zu
  //    sichern. Jeder andere Fehler bricht ab, bevor wir etwas loeschen.
  try {
    const cur = await _buildSnapshotPayload(bookId, req);
    snapshots.createSnapshot({
      bookId, label: AUTO_BACKUP_LABEL, description: null,
      contentJson: JSON.stringify(cur.content), extrasJson: cur.extrasJson,
      publicationJson: cur.publicationJson,
      chars: cur.chars, words: cur.words, pages: cur.pages, chapters: cur.chapters,
      userEmail,
    });
  } catch (e) {
    if (e.code !== 'BOOK_EMPTY') {
      logger.error(`Restore-Sicherung fehlgeschlagen (book=${bookId}): ${e.message}`);
      return res.status(500).json({ error_code: 'BACKUP_FAILED' });
    }
  }

  // 2) Aktuellen Inhalt komplett entfernen. pages.chapter_id und
  //    chapters.parent_chapter_id sind ON DELETE SET NULL → Loeschen eines
  //    Kapitels entfernt weder Seiten noch Sub-Kapitel; darum beides explizit
  //    abraeumen. Order-Overlay loeschen, sonst zeigt es auf alte IDs.
  try {
    for (const p of await contentStore.listPages(bookId, req)) {
      await contentStore.deletePage(p.id, req);
    }
    for (const c of await contentStore.listChapters(bookId, req)) {
      await contentStore.deleteChapter(c.id, req);
    }
    bookOrder.clearOrder(bookId);
  } catch (e) {
    logger.error(`Restore-Wipe fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(500).json({ error_code: 'RESTORE_FAILED' });
  }

  // 3) Inhalt der Ziel-Fassung neu anlegen (gleiche Op-Reihenfolge wie Buch-Import).
  const chapterIdByTemp = new Map();
  let pagesCreated = 0; let chaptersCreated = 0;
  for (const o of plan.ops) {
    const parentChapterId = o.parentTempId == null ? null : (chapterIdByTemp.get(o.parentTempId) ?? null);
    try {
      if (o.op === 'chapter') {
        const ch = await contentStore.createChapter(
          { book_id: bookId, name: o.name || '', parent_chapter_id: parentChapterId }, req);
        chapterIdByTemp.set(o.tempId, ch.id);
        chaptersCreated += 1;
      } else if (o.op === 'page') {
        const created = await contentStore.createPage(
          { book_id: bookId, chapter_id: parentChapterId, name: o.name || '', html: o.html || '' }, req);
        pagesCreated += 1;
        // Mitgefuehrte Bild-BLOBs unter der neuen page_id neu einfuegen + die
        // /content/page-image/<oldId>-Refs im HTML auf die neuen IDs umschreiben.
        if (created?.id && o.images?.length) {
          const { restorePageImages } = require('../db/page-images');
          const rewritten = restorePageImages(created.id, o.html || '', o.images);
          if (rewritten != null) {
            try { await contentStore.savePage(created.id, { html: rewritten, source: 'import' }, req); }
            catch (e) { logger.warn(`Restore Bild-Rewrite «${o.name}» fehlgeschlagen (book=${bookId}): ${e.message}`); }
          }
        }
      }
    } catch (e) {
      logger.warn(`Restore createXxx «${o.name}» fehlgeschlagen (book=${bookId}): ${e.message}`);
    }
  }

  // 4) Buch-Settings der Fassung uebernehmen (best-effort). allow_lektor_book_chat
  //    bewusst 0 lassen — ACL-relevant, nicht Teil der Inhalts-Fassung.
  const s = plan.settings;
  if (s && typeof s === 'object') {
    try {
      saveBookSettings(
        bookId, s.language || 'de', s.region || 'CH', s.buchtyp || null, s.buch_kontext || null,
        s.erzaehlperspektive || null, s.erzaehlzeit || null, s.is_finished ? 1 : 0, 0,
        Number.isFinite(s.daily_goal_chars) ? s.daily_goal_chars : null,
        s.orte_real ? 1 : 0, s.schauplatz_land || null,
      );
      if (s.entities_enabled) setBookEntitiesEnabled(bookId, 1);
    } catch (e) { logger.warn(`Restore-Settings fehlgeschlagen (book=${bookId}): ${e.message}`); }
  }

  // 4b) Eingefrorene Publikation zurueckschreiben (best-effort, Voll-Replace wie
  //     upsertMeta). Cover/Autorfoto auf den Fassungs-Stand setzen — fehlt das
  //     BLOB in der Fassung, wird das Live-Bild geloescht (Restore = auf den
  //     eingefrorenen Stand setzen). Die Auto-Sicherung oben hat den vorherigen
  //     Publikations-Stand mitgefroren → umkehrbar.
  const pub = snapshotPublication(row.publication_json);
  if (pub) {
    try {
      const bp = require('../db/book-publication');
      bp.upsertMeta(bookId, pub.meta);
      if (pub.cover) bp.setCover(bookId, pub.cover.image, pub.cover.mime);
      else bp.clearCover(bookId);
      if (pub.authorImage) bp.setAuthorImage(bookId, pub.authorImage.image, pub.authorImage.mime);
      else bp.clearAuthorImage(bookId);
    } catch (e) { logger.warn(`Restore-Publikation fehlgeschlagen (book=${bookId}): ${e.message}`); }
  }

  // 5) Statistik neu syncen (Tages-Donut, Buch-Stats).
  try {
    const { syncBook } = require('./sync');
    await syncBook(bookId, req);
  } catch (e) { logger.warn(`Restore-Sync fehlgeschlagen (book=${bookId}): ${e.message}`); }

  logger.info(`Buch auf «Fassung ${row.seq}» zurueckgesetzt (book=${bookId}, pages=${pagesCreated}, chapters=${chaptersCreated}).`);
  return res.json({ ok: true, seq: row.seq, pagesCreated, chaptersCreated });
});

// ── Delete ──────────────────────────────────────────────────────────────────────
router.delete('/:bookId/:id', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  try {
    const ok = snapshots.deleteSnapshot(bookId, id);
    if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
    return res.json({ ok: true });
  } catch (e) {
    logger.error(`Snapshot-Delete fehlgeschlagen (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(500).json({ error_code: 'DELETE_FAILED' });
  }
});

module.exports = router;
