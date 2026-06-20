'use strict';
// Recherche-/Wissensboard pro Buch — geteiltes Archiv fuer Notizen, Links,
// Zitate, Faktensplitter und Bilder. Buchweit GETEILT: alle Editoren des Buchs
// sehen dieselben Schnipsel; `user_email` ist reine Ersteller-Attribution, kein
// Sichtbarkeits-Scope (anders als routes/ideen.js). Rein kuratierend/rueckwaerts-
// gewandt — nie generativ im Buchtext.
//
// Jeder Schnipsel ist optional mit beliebig vielen Buch-Entitaeten verknuepfbar
// (Kapitel/Seite/Figur/Ort/Szene/Plot-Beat, Bridge-Tabelle research_item_links)
// und ueber freie Tags (research_item_tags) filterbar.

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const { prepareCover } = require('../lib/cover-prepare');
const { NOW_ISO_SQL } = require('../db/now');
const searchIndex = require('../lib/search');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();
const rawImage = express.raw({ type: ['image/*'], limit: '12mb' });

const KINDS = new Set(['note', 'link', 'quote', 'fact', 'image']);
const TITLE_MAX = 300;
const BODY_MAX = 20000;
const URL_MAX = 2000;
const SOURCE_MAX = 1000;
const TAG_MAX = 60;
const MAX_TAGS = 20;

// target_kind → { col, table, pk, nameCol } für Validierung + Display-JOIN.
const LINK_TARGETS = {
  chapter:  { col: 'chapter_id',  table: 'chapters',      pk: 'chapter_id', nameCol: 'chapter_name' },
  page:     { col: 'page_id',     table: 'pages',         pk: 'page_id',    nameCol: 'page_name' },
  figure:   { col: 'figure_id',   table: 'figures',       pk: 'id',         nameCol: 'name' },
  location: { col: 'location_id', table: 'locations',     pk: 'id',         nameCol: 'name' },
  scene:    { col: 'scene_id',    table: 'figure_scenes', pk: 'id',         nameCol: 'titel' },
  beat:     { col: 'beat_id',     table: 'plot_beats',    pk: 'id',         nameCol: 'titel' },
};

function userEmailOrNull(req) {
  return req.session?.user?.email || null;
}

function _itemBookId(id) {
  const r = db.prepare('SELECT book_id FROM research_items WHERE id = ?').get(id);
  return r?.book_id || null;
}

function _guard(req, res, bookId, minRole) {
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return true; }
  catch (e) { return !sendACLError(res, e); }
}

function _clean(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

// Tags + Links für eine Menge Items nachladen und nach item_id gruppieren.
function _attachRelations(items) {
  if (!items.length) return items;
  const ids = items.map(i => i.id);
  const ph = ids.map(() => '?').join(',');

  const tagRows = db.prepare(
    `SELECT item_id, tag FROM research_item_tags WHERE item_id IN (${ph}) ORDER BY tag`
  ).all(...ids);
  const tagsByItem = new Map();
  for (const r of tagRows) {
    if (!tagsByItem.has(r.item_id)) tagsByItem.set(r.item_id, []);
    tagsByItem.get(r.item_id).push(r.tag);
  }

  // Links inkl. Display-Label per target_kind-spezifischem JOIN (ein Pass je Kind).
  const linksByItem = new Map();
  for (const [kind, t] of Object.entries(LINK_TARGETS)) {
    const rows = db.prepare(
      `SELECT l.id AS link_id, l.item_id, l.${t.col} AS target_id, e.${t.nameCol} AS label
         FROM research_item_links l
         JOIN ${t.table} e ON e.${t.pk} = l.${t.col}
        WHERE l.item_id IN (${ph}) AND l.target_kind = ?`
    ).all(...ids, kind);
    for (const r of rows) {
      if (!linksByItem.has(r.item_id)) linksByItem.set(r.item_id, []);
      linksByItem.get(r.item_id).push({
        link_id: r.link_id, target_kind: kind, target_id: r.target_id, label: r.label || '',
      });
    }
  }

  for (const it of items) {
    it.tags = tagsByItem.get(it.id) || [];
    it.links = linksByItem.get(it.id) || [];
    it.has_image = !!it.image_mime;
    delete it.image_mime;
  }
  return items;
}

function _emitItem(id) {
  const row = db.prepare(
    `SELECT id, book_id, user_email, kind, title, body, url, source, image_mime,
            pinned, archived, created_at, updated_at
       FROM research_items WHERE id = ?`
  ).get(id);
  if (!row) return null;
  _attachRelations([row]);
  return row;
}

function _replaceTags(itemId, tags) {
  db.prepare('DELETE FROM research_item_tags WHERE item_id = ?').run(itemId);
  if (!Array.isArray(tags)) return;
  const seen = new Set();
  const ins = db.prepare('INSERT OR IGNORE INTO research_item_tags (item_id, tag) VALUES (?, ?)');
  for (const raw of tags.slice(0, MAX_TAGS)) {
    const tag = _clean(String(raw || ''), TAG_MAX);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    ins.run(itemId, tag);
  }
}

// ── Liste + Filter ─────────────────────────────────────────────────────────
// GET /research?book_id=&kind=&tag=&linked=figure:42&q=
router.get('/', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const where = ['ri.book_id = ?'];
  const vals = [bookId];

  const kind = String(req.query.kind || '').trim();
  if (KINDS.has(kind)) { where.push('ri.kind = ?'); vals.push(kind); }

  if (String(req.query.archived || '') !== '1') where.push('ri.archived = 0');

  const tag = _clean(String(req.query.tag || ''), TAG_MAX);
  if (tag) {
    where.push('ri.id IN (SELECT item_id FROM research_item_tags WHERE tag = ?)');
    vals.push(tag);
  }

  // linked=figure:42 → nur Items, die mit dieser Entitaet verknuepft sind.
  const linked = String(req.query.linked || '').trim();
  if (linked) {
    const [lk, lidRaw] = linked.split(':');
    const t = LINK_TARGETS[lk];
    const lid = toIntId(lidRaw);
    if (t && lid) {
      where.push(`ri.id IN (SELECT item_id FROM research_item_links WHERE target_kind = ? AND ${t.col} = ?)`);
      vals.push(lk, lid);
    }
  }

  // q → FTS5-Vorfilter auf research-Kind dieses Buchs.
  const q = String(req.query.q || '').trim();
  if (q) {
    try {
      const hits = searchIndex.query(q, { bookId, kinds: ['research'], limit: 500 });
      const ids = (hits?.hits || []).map(h => h.entity_id).filter(Boolean);
      if (!ids.length) return res.json([]);
      where.push(`ri.id IN (${ids.map(() => '?').join(',')})`);
      vals.push(...ids);
    } catch (e) {
      logger.warn('[research] FTS-Vorfilter fehlgeschlagen: ' + e.message);
    }
  }

  const rows = db.prepare(
    `SELECT ri.id, ri.book_id, ri.user_email, ri.kind, ri.title, ri.body, ri.url,
            ri.source, ri.image_mime, ri.pinned, ri.archived, ri.created_at, ri.updated_at
       FROM research_items ri
      WHERE ${where.join(' AND ')}
      ORDER BY ri.pinned DESC, ri.updated_at DESC`
  ).all(...vals);
  res.json(_attachRelations(rows));
});

// Tag-Pool des Buchs (mit Häufigkeit) für die Filter-Combobox.
router.get('/tags', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;
  const rows = db.prepare(
    `SELECT t.tag AS tag, COUNT(*) AS n
       FROM research_item_tags t JOIN research_items ri ON ri.id = t.item_id
      WHERE ri.book_id = ?
      GROUP BY t.tag ORDER BY n DESC, t.tag ASC`
  ).all(bookId);
  res.json(rows);
});

// Verknüpfbare Entitäten des Buchs für den Link-Picker (book-shared).
router.get('/link-targets', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;
  const userEmail = userEmailOrNull(req);
  const out = {};
  out.chapter = db.prepare(
    'SELECT chapter_id AS id, chapter_name AS label FROM chapters WHERE book_id = ? ORDER BY sort_order, chapter_name'
  ).all(bookId);
  out.page = db.prepare(
    'SELECT page_id AS id, page_name AS label FROM pages WHERE book_id = ? ORDER BY page_name'
  ).all(bookId);
  // user-skopierte Welt-Entitäten: nur die des anfragenden Users anbieten.
  out.figure = db.prepare(
    'SELECT id, name AS label FROM figures WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name'
  ).all(bookId, userEmail);
  out.location = db.prepare(
    'SELECT id, name AS label FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name'
  ).all(bookId, userEmail);
  out.scene = db.prepare(
    'SELECT id, titel AS label FROM figure_scenes WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'
  ).all(bookId, userEmail);
  out.beat = db.prepare(
    'SELECT id, titel AS label FROM plot_beats WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'
  ).all(bookId, userEmail);
  res.json(out);
});

// ── Anlegen ──────────────────────────────────────────────────────────────
router.post('/', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const kind = KINDS.has(req.body?.kind) ? req.body.kind : 'note';
  const title = _clean(req.body?.title, TITLE_MAX);
  const body = _clean(req.body?.body, BODY_MAX);
  const url = _clean(req.body?.url, URL_MAX);
  const source = _clean(req.body?.source, SOURCE_MAX);
  if (!title && !body && !url) return res.status(400).json({ error_code: 'EMPTY' });

  const result = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title, body, url, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})`
  ).run(bookId, userEmail, kind, title, body, url, source);
  const id = result.lastInsertRowid;
  _replaceTags(id, req.body?.tags);
  searchIndex.upsertResearch(id);
  logger.info(`[research] create id=${id} kind=${kind}`);
  res.json(_emitItem(id));
});

// ── Aktualisieren (Felder + pinned + archived + Tags optional einzeln) ──────
router.patch('/:id', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const sets = [];
  const vals = [];
  const b = req.body || {};
  if (typeof b.kind !== 'undefined') {
    if (!KINDS.has(b.kind)) return res.status(400).json({ error_code: 'INVALID_KIND' });
    sets.push('kind = ?'); vals.push(b.kind);
  }
  if (typeof b.title !== 'undefined')  { sets.push('title = ?');  vals.push(_clean(b.title, TITLE_MAX)); }
  if (typeof b.body !== 'undefined')   { sets.push('body = ?');   vals.push(_clean(b.body, BODY_MAX)); }
  if (typeof b.url !== 'undefined')    { sets.push('url = ?');    vals.push(_clean(b.url, URL_MAX)); }
  if (typeof b.source !== 'undefined') { sets.push('source = ?'); vals.push(_clean(b.source, SOURCE_MAX)); }
  if (typeof b.pinned !== 'undefined')   { sets.push('pinned = ?');   vals.push(b.pinned ? 1 : 0); }
  if (typeof b.archived !== 'undefined') { sets.push('archived = ?'); vals.push(b.archived ? 1 : 0); }

  const hasTags = typeof b.tags !== 'undefined';
  if (!sets.length && !hasTags) return res.status(400).json({ error_code: 'NO_FIELDS' });

  if (sets.length) {
    sets.push(`updated_at = ${NOW_ISO_SQL}`);
    vals.push(id);
    db.prepare(`UPDATE research_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  if (hasTags) _replaceTags(id, b.tags);
  searchIndex.upsertResearch(id);
  res.json(_emitItem(id));
});

// ── Löschen ────────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  db.prepare('DELETE FROM research_items WHERE id = ?').run(id);
  searchIndex.remove('research', id);
  res.json({ ok: true });
});

// ── Verknüpfung hinzufügen ──────────────────────────────────────────────────
router.post('/:id/links', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const targetKind = String(req.body?.target_kind || '').trim();
  const targetId = toIntId(req.body?.target_id);
  const t = LINK_TARGETS[targetKind];
  if (!t || !targetId) return res.status(400).json({ error_code: 'INVALID_TARGET' });
  // Ziel muss zum Buch gehören.
  const owner = db.prepare(`SELECT book_id FROM ${t.table} WHERE ${t.pk} = ?`).get(targetId);
  if (!owner || owner.book_id !== bookId) return res.status(400).json({ error_code: 'BOOK_MISMATCH' });

  try {
    db.prepare(
      `INSERT INTO research_item_links (item_id, target_kind, ${t.col}, created_at)
       VALUES (?, ?, ?, ${NOW_ISO_SQL})`
    ).run(id, targetKind, targetId);
  } catch (e) {
    // UNIQUE-Verstoß = Verknüpfung existiert bereits → idempotent.
    if (!/UNIQUE/.test(e.message)) throw e;
  }
  res.json(_emitItem(id));
});

// ── Verknüpfung entfernen ────────────────────────────────────────────────────
router.delete('/:id/links/:linkId', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  const linkId = toIntId(req.params.linkId);
  if (!id || !linkId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  db.prepare('DELETE FROM research_item_links WHERE id = ? AND item_id = ?').run(linkId, id);
  res.json(_emitItem(id));
});

// ── Bild hochladen (sharp-normalisiert) ──────────────────────────────────────
router.post('/:id/image', rawImage, async (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = _itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error_code: 'NO_IMAGE' });
  }
  try {
    const { buffer, mime } = await prepareCover(req.body);
    db.prepare(
      `UPDATE research_items SET image = ?, image_mime = ?, kind = 'image', updated_at = ${NOW_ISO_SQL} WHERE id = ?`
    ).run(buffer, mime, id);
    res.json(_emitItem(id));
  } catch (e) {
    logger.warn('[research] Bild-Upload fehlgeschlagen: ' + e.message);
    res.status(400).json({ error_code: 'IMAGE_INVALID' });
  }
});

// Bild ausliefern (BLOB-Stream).
router.get('/:id/image', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const row = db.prepare('SELECT book_id, image, image_mime FROM research_items WHERE id = ?').get(id);
  if (!row || !row.image) return res.status(404).json({ error_code: 'NO_IMAGE' });
  if (!_guard(req, res, row.book_id, 'viewer')) return;
  res.set('Content-Type', row.image_mime || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(row.image);
});

module.exports = router;
