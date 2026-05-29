'use strict';
// Admin-Routen fuer KI-Parse-Fehler-Dumps (lib/ai.js#_dumpParseFail schreibt
// Rohtext nach ai_parse_fails/ wenn JSON-Parsing fehlschlaegt). Hinter
// requireAdmin. Keine Privacy-Boundary — Admin sieht alle Dumps. Audit-Log auf
// Loeschen. Verzeichnis ist rotiert (max 50 Files, siehe ai.js).

const express = require('express');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { requireAdmin } = require('../lib/admin-mw');
const { setContext } = require('../lib/log-context');
const appUsers = require('../db/app-users');
const logger = require('../logger');

const FAILS_DIR = path.join(__dirname, '..', 'ai_parse_fails');
// Cap fuer den Content-Read — Dumps sind i.d.R. < 1 MB, aber lokale Modelle
// koennen ausreissen. Schuetzt den Heap.
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

const router = express.Router();
router.use(requireAdmin);
router.use((req, _res, next) => {
  setContext({ book: null });
  next();
});

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

// Validiert den vom Client gelieferten Namen: nur Basename, .txt-Endung, keine
// Path-Traversal. Gibt den absoluten Pfad zurueck oder null.
function _safePath(name) {
  const base = path.basename(String(name || ''));
  if (base !== name || !base.endsWith('.txt')) return null;
  return path.join(FAILS_DIR, base);
}

// ── GET /admin/parse-fails/files ──────────────────────────────────────────────
// Liste aller Dumps, neueste zuerst.
router.get('/files', async (_req, res) => {
  let entries;
  try {
    entries = await fsp.readdir(FAILS_DIR);
  } catch {
    return res.json({ files: [] }); // Dir existiert noch nicht → leer
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.txt')) continue;
    try {
      const stat = await fsp.stat(path.join(FAILS_DIR, name));
      if (!stat.isFile()) continue;
      out.push({ name, size: stat.size, mtime: stat.mtime.toISOString() });
    } catch { /* race: Datei verschwand */ }
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  res.json({ files: out });
});

// ── GET /admin/parse-fails/file?name=... ──────────────────────────────────────
// Voller Rohtext eines Dumps.
router.get('/file', async (req, res) => {
  const fp = _safePath(req.query.name);
  if (!fp) return res.status(400).json({ error_code: 'BAD_NAME' });
  let stat, content;
  try {
    stat = await fsp.stat(fp);
    content = await fsp.readFile(fp, { encoding: 'utf8' });
  } catch {
    return res.status(404).json({ error_code: 'FILE_NOT_FOUND' });
  }
  res.json({
    name: path.basename(fp),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    content: content.length > MAX_CONTENT_BYTES ? content.slice(0, MAX_CONTENT_BYTES) : content,
    truncated: content.length > MAX_CONTENT_BYTES,
  });
});

// ── DELETE /admin/parse-fails/file?name=... ───────────────────────────────────
// Loescht einen einzelnen Dump.
router.delete('/file', async (req, res) => {
  const fp = _safePath(req.query.name);
  if (!fp) return res.status(400).json({ error_code: 'BAD_NAME' });
  try {
    await fsp.unlink(fp);
  } catch {
    return res.status(404).json({ error_code: 'FILE_NOT_FOUND' });
  }
  try {
    appUsers.recordAuditEvent(req.session.user.email, 'admin.parse_fails.delete', {
      ip: _clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      meta: { file: path.basename(fp) },
    });
  } catch (e) {
    logger.warn(`[admin-parse-fails] audit log failed: ${e.message}`);
  }
  res.json({ ok: true });
});

// ── DELETE /admin/parse-fails ─────────────────────────────────────────────────
// Loescht alle Dumps.
router.delete('/', async (req, res) => {
  let entries;
  try {
    entries = await fsp.readdir(FAILS_DIR);
  } catch {
    return res.json({ ok: true, deleted: 0 });
  }
  let deleted = 0;
  for (const name of entries) {
    if (!name.endsWith('.txt')) continue;
    try { await fsp.unlink(path.join(FAILS_DIR, name)); deleted++; } catch { /* race */ }
  }
  try {
    appUsers.recordAuditEvent(req.session.user.email, 'admin.parse_fails.clear', {
      ip: _clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      meta: { deleted },
    });
  } catch (e) {
    logger.warn(`[admin-parse-fails] audit log failed: ${e.message}`);
  }
  res.json({ ok: true, deleted });
});

module.exports = router;
