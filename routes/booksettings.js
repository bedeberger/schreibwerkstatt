'use strict';
const express = require('express');
const { getBookSettings, saveBookSettings } = require('../db/schema');
const { aclParamGuard } = require('../lib/acl');

const router = express.Router();
const jsonBody = express.json();

const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];
const VALID_BUCHTYPEN = ['roman', 'kurzgeschichten', 'gesellschaft', 'krimi', 'historisch', 'fantasy_scifi', 'erotik', 'jugend', 'autobiografie', 'tagebuch', 'sachbuch', 'lyrik', 'essay', 'blog', 'satire', 'andere'];
const VALID_POV     = ['ich', 'er_sie_personal', 'er_sie_auktorial', 'du', 'wir', 'gemischt'];
const VALID_TEMPUS  = ['praeteritum', 'praesens', 'gemischt'];
const BUCH_KONTEXT_MAX = 1000;

/** Gibt Sprache, Region, Buchtyp und Buchkontext für ein Buch zurück. */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  res.json(settings);
});

/** Speichert Sprache, Region, Buchtyp und Buchkontext für ein Buch. */
router.put('/:book_id', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;

  const { language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat } = req.body || {};
  if (!language || !region) {
    return res.status(400).json({ error_code: 'LANGUAGE_REGION_REQUIRED' });
  }
  if (!VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({ error_code: 'INVALID_LANGUAGE', params: { allowed: VALID_LANGUAGES.join(', ') } });
  }
  if (!VALID_REGIONS.includes(region)) {
    return res.status(400).json({ error_code: 'INVALID_REGION', params: { allowed: VALID_REGIONS.join(', ') } });
  }
  if (buchtyp && !VALID_BUCHTYPEN.includes(buchtyp)) {
    return res.status(400).json({ error_code: 'INVALID_BUCHTYP', params: { allowed: VALID_BUCHTYPEN.join(', ') } });
  }
  if (buch_kontext && buch_kontext.length > BUCH_KONTEXT_MAX) {
    return res.status(400).json({ error_code: 'BUCH_KONTEXT_TOO_LONG', params: { max: BUCH_KONTEXT_MAX } });
  }
  if (erzaehlperspektive && !VALID_POV.includes(erzaehlperspektive)) {
    return res.status(400).json({ error_code: 'INVALID_POV', params: { allowed: VALID_POV.join(', ') } });
  }
  if (erzaehlzeit && !VALID_TEMPUS.includes(erzaehlzeit)) {
    return res.status(400).json({ error_code: 'INVALID_TEMPUS', params: { allowed: VALID_TEMPUS.join(', ') } });
  }

  const finished = is_finished ? 1 : 0;
  const lektorBookChat = allow_lektor_book_chat ? 1 : 0;
  saveBookSettings(bookId, language, region, buchtyp || null, buch_kontext || null, erzaehlperspektive || null, erzaehlzeit || null, finished, lektorBookChat);
  res.json({
    ok: true, language, region,
    buchtyp: buchtyp || null, buch_kontext: buch_kontext || null,
    erzaehlperspektive: erzaehlperspektive || null,
    erzaehlzeit: erzaehlzeit || null,
    is_finished: finished,
    allow_lektor_book_chat: lektorBookChat,
    locale: `${language}-${region}`,
  });
});

module.exports = router;
