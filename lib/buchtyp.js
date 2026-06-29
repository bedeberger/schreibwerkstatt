'use strict';
// SSoT für serverseitige Buchtyp-Gates. Buchtyp-Keys leben kanonisch in
// prompt-config.json (`buchtypen`); tests/unit/buchtyp-drift.test.mjs hält die
// im Code referenzierten Literale gegen diese Quelle synchron.
//
// Blog-Sync (WordPress + HubSpot) ist das einzige serverseitige Feature, das an
// einen Buchtyp gebunden ist: alle Endpunkte/Jobs erfordern buchtyp === 'blog'.
// Der per-Feature unterschiedliche Fehler-Code (BLOG_… vs. HUBSPOT_…) wird als
// Argument durchgereicht, der Typ-Vergleich selbst lebt nur hier.

const { getBookSettings } = require('../db/schema');

const BLOG = 'blog';

// Reiner Typ-Check (für /status-Endpunkte ohne Guard-Semantik).
function isBlogBook(settings) {
  return !!settings && settings.buchtyp === BLOG;
}

// Express-Guard für REST-Routen: antwortet 400 + error_code, wenn das Buch
// nicht vom Typ 'blog' ist. Liest req.bookId (via bookParamHandler gesetzt).
// Rückgabe false → Caller bricht ab (Response ist bereits gesendet).
function requireBlogTypeRoute(req, res, errorCode) {
  const settings = getBookSettings(req.bookId, req.session?.user?.email || null);
  if (!isBlogBook(settings)) {
    res.status(400).json({ error_code: errorCode });
    return false;
  }
  return true;
}

// Job-Guard: wirft mit `errorCode` (als err.code + message), wenn das Buch
// nicht vom Typ 'blog' ist. Gibt sonst die Settings zurück.
function assertBlogBook(bookId, userEmail, errorCode) {
  const settings = getBookSettings(bookId, userEmail);
  if (!isBlogBook(settings)) {
    const err = new Error(errorCode);
    err.code = errorCode;
    throw err;
  }
  return settings;
}

module.exports = { BUCHTYP_BLOG: BLOG, isBlogBook, requireBlogTypeRoute, assertBlogBook };
