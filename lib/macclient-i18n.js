'use strict';
// OTA-Override-Quelle der UI-Strings des nativen macOS-Clients
// (schreibwerkstatt-focuseditor). Der Client liefert dieselben Kataloge
// gebuendelt mit (Offline-Fallback) und fragt diesen Endpunkt konditional ab,
// um einzelne Keys zentral vom Server ueberschreiben zu lassen. Keys, die der
// Server nicht liefert, fallen im Client auf den gebuendelten Stand zurueck.
//
// SSoT der Server-Overrides sind die JSON-Kataloge unter
// assets/macclient-i18n/{de,en}.json (flaches Key→Value je Locale, {param}-
// Platzhalter analog zur Web-i18n). Aenderungen daran wirken nach
// systemd-Restart (Inhalt wird pro Prozess gecacht — Deploy = Restart, wie das
// Editor-Bundle).
//
// Antwort-Shape: { "de": { "<key>": "<value>", … }, "en": { … } }.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const logger = require('../logger');

const I18N_DIR = join(__dirname, '..', 'assets', 'macclient-i18n');
const LOCALES = ['de', 'en'];

// Ergebnis pro Prozess cachen — die Kataloge aendern sich ohne Neustart nicht.
let _cache = null;

function _build() {
  const catalogs = {};
  for (const loc of LOCALES) {
    const raw = readFileSync(join(I18N_DIR, `${loc}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`macclient-i18n: ${loc}.json ist kein flaches Key→Value-Objekt`);
    }
    catalogs[loc] = parsed;
  }
  // ETag = sha256 ueber den kanonisch serialisierten Body. Stabil ueber
  // Requests/Neustarts solange die Kataloge unveraendert sind.
  const body = JSON.stringify(catalogs);
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  logger.info(`macclient-i18n: Kataloge geladen (${LOCALES.map(l => `${l}=${Object.keys(catalogs[l]).length}`).join(', ')}, etag=${etag.slice(1, 13)})`);
  return { etag, body };
}

function getCatalogs() {
  if (!_cache) _cache = _build();
  return _cache;
}

module.exports = {
  getCatalogs,
  LOCALES,
  _resetCache() { _cache = null; },
};
