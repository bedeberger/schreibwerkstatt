'use strict';
// Job-spezifische Helper rund um Buch-Kontext (Buch-Settings + Locale + Prompts).
//
// Die frueher hier definierten bsGet/bsGetAll-Wrapper sind weggefallen — Jobs
// verwenden direkt `require('lib/content-store')` und wrappen Errors bei Bedarf
// ueber `bsHttpError` aus shared/jobs.js. So bleibt content-store die SSoT,
// und es gibt keinen zweiten Layer mehr, der bs*-Aufrufe versteckt.

const { BOOKSTACK_URL: BS_URL } = require('../../../lib/bookstack');
const { getBookSettings } = require('../../../db/schema');
const { getPrompts } = require('../../../lib/prompts-loader');

/**
 * Gibt das Locale-Prompts-Objekt für ein Buch zurück – augmentiert mit Buchtyp und Buchkontext.
 * Liest Sprache, Region, Buchtyp und Buchkontext aus book_settings;
 * falls die Zeile fehlt, werden die User-Defaults (falls userEmail übergeben) als Fallback verwendet.
 * @param {number|string} bookId
 * @param {string|null}   userEmail optional – ermöglicht User-Default-Fallback bei fehlenden book_settings
 */
async function getBookPrompts(bookId, userEmail = null) {
  const { getLocalePromptsForBook } = await getPrompts();
  const settings = bookId ? getBookSettings(bookId, userEmail) : { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null, is_finished: 0 };
  const locale   = `${settings.language}-${settings.region}`;
  return getLocalePromptsForBook(locale, settings.buchtyp || null, settings.buch_kontext || null, !!settings.is_finished);
}

module.exports = { BS_URL, getBookPrompts };
