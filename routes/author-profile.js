'use strict';
// Autorenprofil des Users: die stilistischen Kennzahlen seiner eigenen Buecher
// nebeneinander, in Werk-Reihenfolge.
//
// Eigener Router statt weiterer Routen in routes/usersettings.js: die Datei ist
// bereits eine LOC-Altlast (Ratsche in tests/unit/loc-limits.test.mjs) und darf
// nicht wachsen — dieselbe Begruendung wie bei routes/mybooks.js.
// Mount-Punkt `/me/author-profile`, user-bound wie `/me/profile-stats`.
//
// Kein KI-Call und kein Job: Stufe 1 ist reine Messung auf bereits vorhandenen
// Indexen (`book_lexicon`, `page_stats`). Die deutende KI-Schicht kommt spaeter
// obendrauf und bekommt genau diese Zahlen als Vorbefund.

const express = require('express');
const { getAuthorProfile, saveAuthorProfileText } = require('../db/author-profile');
const { sessionEmail } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '64kb' });

// DECKUNGSGLEICH mit STILPROFIL_MAX in routes/booksettings.js. Das ist kein
// Zufallswert: das Autorenprofil kann in das Stilprofil eines Buchs uebernommen
// werden, und ein groesserer Deckel hier erzeugte Texte, die dort nicht mehr
// hineinpassen — die Uebernahme muesste kuerzen oder scheitern.
const AUTHOR_PROFILE_MAX = 6000;

/**
 * GET /me/author-profile — Messung ueber die eigenen Buecher.
 *
 * Keine Buch-ACL: die Antwort ist ueber `books.owner_email` skopiert und
 * enthaelt ausschliesslich eigene Buecher. Sichtbarkeit endet beim Eigentum —
 * fremde Buecher, an denen man mitarbeitet, gehoeren nicht ins eigene Stilbild
 * (gleiche Definition wie der Keyness-Referenzkorpus in db/lexicon.js).
 *
 * Keine Buchnamen im Body (Content-Store-Regel) — das Frontend joint ueber
 * `book_id` aus `/content/books`.
 */
router.get('/', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  try {
    res.json(getAuthorProfile(email));
  } catch (e) {
    logger.error('[me/author-profile] DB-Fehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

/**
 * PUT /me/author-profile — den Profiltext von Hand aendern.
 *
 * Setzt `edited = 1`. Ab da ist der Text der des Autors, und ein neuer KI-Lauf
 * antwortet `409 AUTHOR_PROFILE_EDITED`, statt ihn kommentarlos zu ersetzen —
 * derselbe Respekt vor der Handarbeit wie beim Buch-Stilprofil.
 *
 * Nur der Fliesstext. Die Deutungs-Listen (`konstanten`/`entwicklung`) gehoeren
 * zum Lauf und sind kein Formularfeld: eine von Hand editierte „Entwicklung"
 * waere eine Behauptung ohne Messung dahinter.
 */
router.put('/', jsonBody, (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const text = req.body?.profil_text;
  if (typeof text !== 'string') {
    return res.status(400).json({ error_code: 'PROFIL_TEXT_REQUIRED' });
  }
  if (text.length > AUTHOR_PROFILE_MAX) {
    return res.status(400).json({ error_code: 'AUTHOR_PROFILE_TOO_LONG', max: AUTHOR_PROFILE_MAX });
  }
  try {
    saveAuthorProfileText(email, text);
    res.json({ ok: true });
  } catch (e) {
    logger.error('[me/author-profile] Schreibfehler: ' + e.message, { user: email });
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

module.exports = router;
