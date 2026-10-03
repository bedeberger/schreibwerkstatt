'use strict';
// PDF-Export-Profile (CRUD) + Umschlag-Rückseitenbild + Font-Liste.
// Render-Trigger läuft via /jobs/pdf-export (Job-Queue). Diese Routen
// verwalten nur Konfiguration, das profil-gebundene Rückseitenbild und
// die Font-Auswahl. Front-Cover + Autorfoto leben buch-weit in
// book_publication (routes/publication.js).

const express = require('express');
const {
  listPdfExportProfiles, getPdfExportProfile, createPdfExportProfile,
  updatePdfExportProfile, deletePdfExportProfile,
  setPdfExportProfileBackCover, clearPdfExportProfileBackCover, getPdfExportProfileBackCover,
  setPdfExportProfileSpineImage, clearPdfExportProfileSpineImage, getPdfExportProfileSpineImage,
  setPdfExportProfileDefault,
} = require('../db/schema');
const { defaultConfig, validateConfig } = require('../lib/pdf-export-defaults');
const { prepareCover, MAX_INPUT_BYTES, MAX_INPUT_PIXELS } = require('../lib/cover-prepare');
const { listFonts, isAllowed: isFontAllowed, fetchFont, findDisallowedFont } = require('../lib/font-fetch');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
const jsonBody = express.json({ limit: '1mb' });
const rawCoverBody = express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_INPUT_BYTES + 1 });

const NAME_MAX = 80;
const PROFILE_MAX_PER_SCOPE = 20;


// Font-Auswahl gegen die Whitelist (lib/font-fetch.js#FONT_LIST) pruefen —
// auf JEDEM Weg, der eine Konfiguration persistiert (Anlegen, Klonen,
// Vorlage, Import, Speichern), damit ein Profil nicht erst beim Render oder
// beim naechsten PUT scheitert. Antwortet selbst; true = Antwort ist raus.
function _rejectDisallowedFont(res, cfg) {
  const bad = findDisallowedFont(cfg.font);
  if (!bad) return false;
  res.status(400).json({ error_code: 'FONT_NOT_ALLOWED', params: bad });
  return true;
}

// Bild-Fehler aus lib/cover-prepare.js → i18n-Key fuer den User. Der rohe
// Fehlertext (libvips-Meldung) geht nur ins Log.
const _IMAGE_ERROR_KEYS = {
  'cover-too-large':          'pdfExport.imageError.tooLarge',
  'cover-too-many-pixels':    'pdfExport.imageError.tooManyPixels',
  'cover-unsupported-format': 'pdfExport.imageError.unsupportedFormat',
};
function _imageErrorResponse(res, errorCode, e) {
  const reasonKey = _IMAGE_ERROR_KEYS[e?.message] || 'pdfExport.imageError.invalid';
  if (!_IMAGE_ERROR_KEYS[e?.message]) logger.warn(`pdf-export Bild-Upload abgelehnt: ${e?.message}`);
  return res.status(400).json({
    error_code: errorCode,
    message_key: reasonKey,
    params: { maxMb: Math.round(MAX_INPUT_BYTES / (1024 * 1024)), maxMp: Math.round(MAX_INPUT_PIXELS / 1e6) },
  });
}

const _isUniqueViolation = (e) => e?.code === 'SQLITE_CONSTRAINT_UNIQUE';

function _ownedOr404(profile, userEmail) {
  if (!profile) return { error_code: 'PROFILE_NOT_FOUND', status: 404 };
  if (profile.user_email !== userEmail) return { error_code: 'FORBIDDEN', status: 403 };
  return null;
}

// ── Profile listing & CRUD ──────────────────────────────────────────────────
// Profile sind user-scoped (NICHT buch-scoped). `?book=X` wird ignoriert
// (rückwärtskompatibel — Frontend kann den Param weiter mitschicken). Listing
// liefert immer alle Profile des Users.
router.get('/profiles', (req, res) => {
  const userEmail = sessionEmail(req);
  const profiles = listPdfExportProfiles(0, userEmail);
  res.json({ profiles });
});

router.get('/profiles/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  res.json(profile);
});

router.post('/profiles', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const { name, config, clone_from } = req.body || {};
  const safeName = String(name || '').trim().slice(0, NAME_MAX);
  if (!safeName) return res.status(400).json({ error_code: 'NAME_REQUIRED' });

  const existing = listPdfExportProfiles(0, userEmail);
  if (existing.length >= PROFILE_MAX_PER_SCOPE) {
    return res.status(400).json({ error_code: 'PROFILE_LIMIT_REACHED', params: { max: PROFILE_MAX_PER_SCOPE } });
  }
  if (existing.some(p => p.name === safeName)) {
    return res.status(409).json({ error_code: 'PROFILE_NAME_TAKEN' });
  }

  let cfg;
  if (clone_from) {
    const src = getPdfExportProfile(toIntId(clone_from));
    if (!src || src.user_email !== userEmail) return res.status(404).json({ error_code: 'CLONE_SOURCE_NOT_FOUND' });
    cfg = validateConfig(src.config);
  } else {
    cfg = validateConfig(config || defaultConfig());
  }
  if (_rejectDisallowedFont(res, cfg)) return;

  try {
    // bookId=0 → _scope() wandelt in user_default-Scope.
    const profile = createPdfExportProfile(0, userEmail, safeName, cfg);
    logger.info(`PDF-Export-Profil erstellt: «${safeName}» (id=${profile.id})`);
    res.status(201).json(profile);
  } catch (e) {
    // Name-Race zwischen Dup-Check oben und INSERT (zwei Tabs, Doppelklick).
    if (_isUniqueViolation(e)) return res.status(409).json({ error_code: 'PROFILE_NAME_TAKEN' });
    logger.error(`pdf-export profile create: ${e.message}`);
    res.status(500).json({ error_code: 'PROFILE_CREATE_FAILED' });
  }
});

router.put('/profiles/:id', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });

  const { name, config } = req.body || {};
  const safeName = name != null ? String(name).trim().slice(0, NAME_MAX) : profile.name;
  if (!safeName) return res.status(400).json({ error_code: 'NAME_REQUIRED' });

  if (safeName !== profile.name) {
    // user-scoped — book_id ignorieren.
    const dups = listPdfExportProfiles(0, userEmail);
    if (dups.some(p => p.name === safeName && p.id !== id)) {
      return res.status(409).json({ error_code: 'PROFILE_NAME_TAKEN' });
    }
  }

  const cfg = validateConfig(config || profile.config);
  if (_rejectDisallowedFont(res, cfg)) return;

  let updated;
  try {
    updated = updatePdfExportProfile(id, safeName, cfg);
  } catch (e) {
    if (_isUniqueViolation(e)) return res.status(409).json({ error_code: 'PROFILE_NAME_TAKEN' });
    throw e;
  }
  res.json(updated);
});

router.delete('/profiles/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  deletePdfExportProfile(id);
  res.json({ ok: true });
});

router.post('/profiles/:id/default', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  // user-scoped — bookId=0 reicht, _scope() wandelt in user_default.
  const updated = setPdfExportProfileDefault(0, userEmail, id);
  res.json(updated);
});

// Front-Cover + Autorfoto leben buch-weit in `book_publication` (siehe
// routes/publication.js); hier nur noch das profil-gebundene Rückseitenbild
// für das separate Umschlag-PDF (Phase 4).

// ── Umschlag-Rückseitenbild (separates Cover-PDF, Phase 4) ───────────────────
// Identische sharp-Härtung wie Cover (prepareCover).
router.post('/profiles/:id/back-cover', rawCoverBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'BACK_COVER_EMPTY' });
  }

  let prepared;
  try {
    prepared = await prepareCover(req.body);
  } catch (e) {
    return _imageErrorResponse(res, 'BACK_COVER_INVALID', e);
  }
  setPdfExportProfileBackCover(id, prepared.buffer, prepared.mime);
  res.json({ ok: true, mime: prepared.mime, width: prepared.width, height: prepared.height, bytes: prepared.buffer.length });
});

router.delete('/profiles/:id/back-cover', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  clearPdfExportProfileBackCover(id);
  res.json({ ok: true });
});

router.get('/profiles/:id/back-cover', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  const img = getPdfExportProfileBackCover(id);
  if (!img) return res.status(404).json({ error_code: 'NO_BACK_COVER' });
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(img.image);
});

// ── Umschlag-Buchrückenbild (separates Cover-PDF) ────────────────────────────
// Identische sharp-Härtung wie Cover (prepareCover). Erlaubt ein durchgehendes
// Motiv als Front/Rücken/Rückseite-Panels.
router.post('/profiles/:id/spine-image', rawCoverBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'SPINE_IMAGE_EMPTY' });
  }

  let prepared;
  try {
    prepared = await prepareCover(req.body);
  } catch (e) {
    return _imageErrorResponse(res, 'SPINE_IMAGE_INVALID', e);
  }
  setPdfExportProfileSpineImage(id, prepared.buffer, prepared.mime);
  res.json({ ok: true, mime: prepared.mime, width: prepared.width, height: prepared.height, bytes: prepared.buffer.length });
});

router.delete('/profiles/:id/spine-image', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  clearPdfExportProfileSpineImage(id);
  res.json({ ok: true });
});

router.get('/profiles/:id/spine-image', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const profile = getPdfExportProfile(id);
  const err = _ownedOr404(profile, userEmail);
  if (err) return res.status(err.status).json({ error_code: err.error_code });
  const img = getPdfExportProfileSpineImage(id);
  if (!img) return res.status(404).json({ error_code: 'NO_SPINE_IMAGE' });
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(img.image);
});

// ── Font-Liste (für Picker) ─────────────────────────────────────────────────
router.get('/fonts', (_req, res) => {
  res.json({ fonts: listFonts() });
});

// ── Font-Preview (self-hosted, CSP-konform) ─────────────────────────────────
// Live-Preview im Picker: liefert @font-face-CSS und TTF aus eigenem Origin,
// damit CSP `style-src 'self'` und `font-src 'self'` greifen. Backend nutzt
// denselben Cache wie der Render-Pfad (lib/font-fetch.js).
router.get('/fonts/:family/:weight/preview.css', (req, res) => {
  const family = String(req.params.family || '');
  const weight = parseInt(req.params.weight, 10);
  if (!isFontAllowed(family, weight, 'normal')) {
    return res.status(400).json({ error_code: 'FONT_NOT_ALLOWED' });
  }
  const ttfUrl = `/pdf-export/fonts/${encodeURIComponent(family)}/${weight}/font.ttf`;
  const css = `@font-face{font-family:${JSON.stringify(family)};font-style:normal;font-weight:${weight};font-display:swap;src:url(${JSON.stringify(ttfUrl)}) format("truetype");}`;
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.end(css);
});

router.get('/fonts/:family/:weight/font.ttf', async (req, res) => {
  const family = String(req.params.family || '');
  const weight = parseInt(req.params.weight, 10);
  if (!isFontAllowed(family, weight, 'normal')) {
    return res.status(400).json({ error_code: 'FONT_NOT_ALLOWED' });
  }
  try {
    const buf = await fetchFont(family, weight, 'normal');
    res.setHeader('Content-Type', 'font/ttf');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.end(buf);
  } catch (e) {
    logger.warn(`font-preview ${family} ${weight}: ${e.message}`);
    res.status(502).json({ error_code: 'FONT_FETCH_FAILED' });
  }
});

module.exports = router;
