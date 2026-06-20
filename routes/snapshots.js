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
const { getBookSettings } = require('../db/schema');
const { treeToNodes, buildBookJson } = require('../lib/book-bundle');
const { collectExtras } = require('../db/book-migration-data');
const { htmlToPlainText } = require('../lib/html-text');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const snapshots = require('../db/book-snapshots');

const router = express.Router();

const LABEL_MAX = 120;
const DESC_MAX = 1000;

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
      content,
    },
  });
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

  let book, tree;
  try {
    [book, tree] = await Promise.all([
      contentStore.loadBook(bookId, req),
      contentStore.bookTree(bookId, req),
    ]);
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error_code: 'NOT_FOUND' });
    logger.error(`Snapshot-Capture Load fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'CAPTURE_FAILED' });
  }

  const metas = _collectMetas(tree);
  if (!metas.length) return res.status(400).json({ error_code: 'BOOK_EMPTY' });

  let details;
  try {
    details = await contentStore.loadPagesBatch(metas, req, { batchSize: 15, onError: () => null });
  } catch (e) {
    logger.error(`Snapshot-Capture Pages fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'CAPTURE_FAILED' });
  }
  const htmlById = new Map();
  for (const d of details) if (d && d.id) htmlById.set(d.id, d.html || '');

  const nodes = treeToNodes(tree, htmlById);
  const settings = (() => { try { return getBookSettings(bookId); } catch { return null; } })();
  const content = buildBookJson({ book, settings, nodes });

  // Stats aus dem inline-HTML (gleiche Normalisierung wie page_stats).
  let chars = 0; let words = 0;
  for (const html of htmlById.values()) {
    const text = htmlToPlainText(html);
    chars += text.length;
    if (text) words += text.split(/\s+/).filter(Boolean).length;
  }
  const pages = htmlById.size;
  const chapters = _countChapters(nodes);

  // Extras (Analyse + Lektorat) synchron einsammeln — reiner DB-Read, kein KI-Call.
  let extrasJson = null;
  try {
    const extras = collectExtras(bookId, { analysis: true, lektorat: true });
    if (extras && (extras.analysis || extras.lektorat)) extrasJson = JSON.stringify(extras);
  } catch (e) {
    // Extras sind best-effort (fuer spaeteren Restore); Snapshot trotzdem anlegen.
    logger.warn(`Snapshot-Extras fehlgeschlagen (book=${bookId}): ${e.message}`);
  }

  const userEmail = req.session?.user?.email || null;
  let created;
  try {
    created = snapshots.createSnapshot({
      bookId, label, description,
      contentJson: JSON.stringify(content), extrasJson,
      chars, words, pages, chapters, userEmail,
    });
  } catch (e) {
    logger.error(`Snapshot-Insert fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(500).json({ error_code: 'CAPTURE_FAILED' });
  }

  logger.info(`Snapshot «Fassung ${created.seq}» angelegt (book=${bookId}, pages=${pages}, chars=${chars}).`);
  return res.json({
    snapshot: {
      id: created.id, seq: created.seq, label, description,
      chars, words, pages, chapters, user_email: userEmail,
      created_at: new Date().toISOString(), has_extras: extrasJson ? 1 : 0,
    },
  });
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
