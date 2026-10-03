'use strict';

// Manuskript-Meilensteine: ganze-Buch-Snapshots („Fassung 1/2/3").
// Capture spiegelt den swbook-Export (routes/book-migration.js), legt das
// Ergebnis aber als selbsttragende Zeile in book_snapshots ab statt als ZIP.
// Module:
//   snapshots/payload.js  Momentaufnahme bauen + captureSnapshot (Auto-Fassungen)
//   snapshots/restore.js  Restore (ganzes Buch, einzelne Seite/Kapitel)
// extras_json wird gespeichert, aber nie roh an den Client geliefert.

const express = require('express');
const logger = require('../logger');
const { validateBookJson } = require('../lib/book-bundle');
const { snapshotToBundle, snapshotPublication } = require('../lib/snapshot-export');
const { FORMATS } = require('../lib/export-builders');
const { buildExportMeta, sendExportBuffer } = require('../lib/export-send');
const { buildExportFilename } = require('../lib/filenames');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const snapshots = require('../db/book-snapshots');
const { buildSnapshotPayload, insertPayload, captureSnapshot, extrasSummary } = require('./snapshots/payload');
const { registerRestoreRoutes } = require('./snapshots/restore');

const router = express.Router();

const LABEL_MAX = 120;
const DESC_MAX = 1000;

function _clip(s, max) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/:bookId', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  if (!bookId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  if (!guardBook(req, res, bookId, 'viewer')) return;

  try {
    return res.json({ snapshots: snapshots.listSnapshots(bookId) });
  } catch (e) {
    logger.error(`Snapshot-Liste fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(500).json({ error_code: 'LIST_FAILED' });
  }
});

// ── Drift (lohnt sich eine neue Fassung?) ───────────────────────────────────────
// Vergleicht den aktuellen Buchstand mit der juengsten Fassung, OHNE eine anzulegen:
//   text  — Anteil des editierten Wort-Volumens (0% unveraendert, ~100% Umschrieb)
//   book/publication/settings — geaenderte Titel-/Titelei-/Einstellungs-Felder
// Baut den aktuellen Stand als light-Payload (ohne Bilder/Cover/Extras).
// Muss vor /:bookId/:id stehen, sonst schluckt :id das Literal `drift`.
router.get('/:bookId/drift', async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  if (!bookId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  if (!guardBook(req, res, bookId, 'viewer')) return;

  const baseline = snapshots.getLatestSnapshot(bookId);
  if (!baseline) return res.json({ hasBaseline: false });

  let baselineContent;
  try { baselineContent = JSON.parse(baseline.content_json); }
  catch { return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' }); }
  const basePub = snapshotPublication(baseline.publication_json);

  let payload;
  try {
    payload = await buildSnapshotPayload(bookId, req, { light: true });
  } catch (e) {
    if (e.code === 'BOOK_EMPTY') return res.json({ hasBaseline: false, empty: true });
    logger.error(`Drift-Check fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'DRIFT_FAILED' });
  }

  const { computeDrift } = require('../lib/snapshot-drift');
  const drift = computeDrift({
    baselineContent, currentContent: payload.content,
    baselinePubMeta: basePub ? basePub.meta : null, currentPubMeta: payload.publicationMeta,
    baselineSettings: baselineContent?.book?.settings || null,
    currentSettings: payload.content?.book?.settings || null,
  });

  return res.json({
    hasBaseline: true,
    baseline: {
      id: baseline.id, seq: baseline.seq, label: baseline.label,
      created_at: baseline.created_at,
    },
    drift,
  });
});

// ── Get (content only, fuer Diff) ──────────────────────────────────────────────
router.get('/:bookId/:id', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  if (!guardBook(req, res, bookId, 'viewer')) return;

  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });

  let content;
  try { content = JSON.parse(row.content_json); }
  catch { return res.status(500).json({ error_code: 'CORRUPT_SNAPSHOT' }); }

  // extras_json (MB-gross) nicht roh mitliefern — nur eine kompakte Zaehl-
  // Uebersicht (Publikations-Nachweis: Weltaufbau-/Lektorat-Stand zum Capture-
  // Zeitpunkt). Publikations-Metadaten als TEXT-Meta (ohne Cover/Foto-BLOBs) fuer
  // den Metadaten-Diff im Vergleich.
  const publication = snapshotPublication(row.publication_json);
  return res.json({
    snapshot: {
      id: row.id, seq: row.seq, label: row.label, description: row.description,
      chars: row.chars, words: row.words, pages: row.pages, chapters: row.chapters,
      user_email: row.user_email, created_at: row.created_at, published_at: row.published_at || null,
      has_publication: row.publication_json ? 1 : 0,
      publication: publication ? publication.meta : null,
      extras_summary: extrasSummary(row.extras_json),
      content,
    },
  });
});

// ── Export (Fassung in html/txt/md/epub/docx) ───────────────────────────────────
// Exportiert den selbsttragenden Stand der Fassung — unabhaengig vom aktuellen
// Buchinhalt. PDF laeuft NICHT hier, sondern als Job (routes/jobs/pdf-export.js
// mit snapshotId), wegen Render-Dauer + Profil-Auswahl. Synchroner Pfad wie
// routes/export.js (reiner DB-Read + Build).
router.get('/:bookId/:id/export/:fmt', async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  const fmt = String(req.params.fmt || '').toLowerCase();
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  if (!guardBook(req, res, bookId, 'viewer')) return;

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
    if (!bundle.groups.length) throw new Error('no groups');
  } catch (e) {
    logger.error(`Fassungs-Export: Fassung defekt (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' });
  }

  // Eingefrorene Publikation der Fassung bevorzugen (fmt='epub' konsumiert sie);
  // fehlt sie, faellt buildExportMeta auf die Live-book_publication zurueck.
  const publication = snapshotPublication(row.publication_json);

  // Quellen-Fundstellen der FASSUNG aus deren eingefrorenem HTML, nicht aus
  // `source_citations`: der Fund-Index beschreibt den heutigen Seitenstand, die
  // Fassung aber einen alten — sonst traegt ein Chip im numerischen Stil eine
  // Nummer, die zum Verzeichnis dieser Fassung nicht passt. Die Quellen-Stammdaten
  // bleiben bewusst live (eine korrigierte ISBN soll auch hier stimmen).
  let citations = null;
  try {
    const { citationsFromGroups } = require('../lib/bibliography');
    citations = await citationsFromGroups(bundle.groups);
  } catch (e) {
    logger.warn(`Fassungs-Export: Fundstellen nicht lesbar (book=${bookId}, id=${id}): ${e.message}`);
  }

  let buf;
  try {
    buf = await spec.build(bundle, await buildExportMeta(bookId, fmt, {
      publication, citations, userEmail: sessionEmail(req),
    }));
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
  if (!guardBook(req, res, bookId, 'editor')) return;

  const label = _clip(req.body?.label, LABEL_MAX);
  const description = _clip(req.body?.description, DESC_MAX);

  let payload;
  try {
    payload = await buildSnapshotPayload(bookId, req);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (e.code === 'BOOK_EMPTY') return res.status(400).json({ error_code: 'BOOK_EMPTY' });
    logger.error(`Snapshot-Capture fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'CAPTURE_FAILED' });
  }

  const userEmail = sessionEmail(req);
  let created;
  try {
    created = insertPayload(bookId, payload, { label, description, userEmail });
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
      created_at: new Date().toISOString(), published_at: null,
      has_extras: payload.extrasJson ? 1 : 0,
      has_publication: payload.publicationJson ? 1 : 0,
    },
  });
});

registerRestoreRoutes(router);

// ── Publish (Fassung als veroeffentlichte Auflage markieren) ────────────────────
// Kennzeichnet die Fassung, die als Auflage erschienen ist (Publikations-Anker).
// Body { published: bool }. Mehrere Fassungen duerfen markiert sein.
router.post('/:bookId/:id/publish', express.json({ limit: '4kb' }), (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  if (!guardBook(req, res, bookId, 'editor')) return;

  const published = !!req.body?.published;
  try {
    const ok = snapshots.setPublished(bookId, id, published);
    if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const row = snapshots.getSnapshot(bookId, id);
    logger.info(`Fassung ${row?.seq} ${published ? 'als veroeffentlicht markiert' : 'Markierung entfernt'} (book=${bookId}).`);
    return res.json({ ok: true, published_at: row?.published_at || null });
  } catch (e) {
    logger.error(`Snapshot-Publish fehlgeschlagen (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(500).json({ error_code: 'PUBLISH_FAILED' });
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────────
// Veroeffentlichte Fassungen sind geschuetzt: Loeschen verlangt ?force=1 (Frontend
// zeigt eine staerkere Bestaetigung) UND die Owner-Rolle — ein Publikations-Anker
// ist die Nachweis-Kopie einer erschienenen Auflage, die kein Mitautor im
// Vorbeigehen entfernen soll.
router.delete('/:bookId/:id', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  if (!guardBook(req, res, bookId, 'editor')) return;

  const force = req.query.force === '1' || req.query.force === 'true';
  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (row.published_at) {
    if (!force) return res.status(409).json({ error_code: 'SNAPSHOT_PUBLISHED' });
    if (!guardBook(req, res, bookId, 'owner')) return;
  }

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
module.exports.captureSnapshot = captureSnapshot;
