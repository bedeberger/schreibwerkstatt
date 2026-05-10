'use strict';
const { bsGet: _bsGet, bsGetAll: _bsGetAll, BOOKSTACK_URL: BS_URL } = require('../../../lib/bookstack');
const { getBookSettings } = require('../../../db/schema');
const { getPrompts } = require('../../../lib/prompts-loader');
const { i18nError } = require('./jobs');

/**
 * Gibt das Locale-Prompts-Objekt für ein Buch zurück – augmentiert mit Buchtyp und Buchkontext.
 * Liest Sprache, Region, Buchtyp und Buchkontext aus book_settings;
 * falls die Zeile fehlt, werden die User-Defaults (falls userEmail übergeben) als Fallback verwendet.
 * @param {number|string} bookId
 * @param {string|null}   userEmail optional – ermöglicht User-Default-Fallback bei fehlenden book_settings
 */
async function getBookPrompts(bookId, userEmail = null) {
  const { getLocalePromptsForBook } = await getPrompts();
  const settings = bookId ? getBookSettings(bookId, userEmail) : { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null };
  const locale   = `${settings.language}-${settings.region}`;
  return getLocalePromptsForBook(locale, settings.buchtyp || null, settings.buch_kontext || null);
}

// Wrapped `lib/bookstack.js` – mappt Nicht-OK-Responses auf i18nError, damit
// Job-UI die Meldung übersetzt anzeigen kann.
async function bsGet(path, userToken) {
  try {
    return await _bsGet(path, userToken);
  } catch (e) {
    if (e.status) throw i18nError('job.error.bookstack', { status: e.status, text: e.bodyText });
    throw e;
  }
}

async function bsGetAll(path, userToken) {
  try {
    return await _bsGetAll(path, userToken);
  } catch (e) {
    if (e.status) throw i18nError('job.error.bookstack', { status: e.status, text: e.bodyText });
    throw e;
  }
}

module.exports = { BS_URL, bsGet, bsGetAll, getBookPrompts };
