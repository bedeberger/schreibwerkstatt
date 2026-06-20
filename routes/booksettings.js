'use strict';
const express = require('express');
const { getBookSettings, saveBookSettings, setBookEntitiesEnabled } = require('../db/schema');
const { aclParamGuard } = require('../lib/acl');

const router = express.Router();
const jsonBody = express.json();

const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];
const VALID_BUCHTYPEN = ['roman', 'kurzgeschichten', 'gesellschaft', 'krimi', 'historisch', 'fantasy_scifi', 'erotik', 'jugend', 'autobiografie', 'tagebuch', 'sachbuch', 'lyrik', 'essay', 'blog', 'satire', 'andere'];
const VALID_POV     = ['ich', 'er_sie_personal', 'er_sie_auktorial', 'du', 'wir', 'gemischt'];
const VALID_TEMPUS  = ['praeteritum', 'praesens', 'gemischt'];
const BUCH_KONTEXT_MAX = 1000;
// Stilprofil: KI-destilliert ~1-2k Zeichen; 6000 als grosszuegige Obergrenze
// gegen versehentliches Einfuegen ganzer Kapitel.
const STILPROFIL_MAX = 6000;
// Tagesziel: 100 Zeichen ≈ kurzer Tweet (Untergrenze gegen Tippfehler),
// 50 000 ≈ 33 Normseiten als praktisches Maximum.
const DAILY_GOAL_MIN = 100;
const DAILY_GOAL_MAX = 50000;
// Schreibziel (gesamt): 1 000 Zeichen Untergrenze, 20 Mio (~13 000 Normseiten)
// als praktisches Maximum gegen Tippfehler.
const GOAL_TARGET_MIN = 1000;
const GOAL_TARGET_MAX = 20000000;

/** Gibt Sprache, Region, Buchtyp und Buchkontext für ein Buch zurück. */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  res.json(settings);
});

/** Speichert Sprache, Region, Buchtyp und Buchkontext für ein Buch. */
router.put('/:book_id', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;

  const { language, region, buchtyp, buch_kontext, stilprofil, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, goal_target_chars, goal_deadline, orte_real, schauplatz_land } = req.body || {};
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
  if (stilprofil && String(stilprofil).length > STILPROFIL_MAX) {
    return res.status(400).json({ error_code: 'STILPROFIL_TOO_LONG', params: { max: STILPROFIL_MAX } });
  }
  if (erzaehlperspektive && !VALID_POV.includes(erzaehlperspektive)) {
    return res.status(400).json({ error_code: 'INVALID_POV', params: { allowed: VALID_POV.join(', ') } });
  }
  if (erzaehlzeit && !VALID_TEMPUS.includes(erzaehlzeit)) {
    return res.status(400).json({ error_code: 'INVALID_TEMPUS', params: { allowed: VALID_TEMPUS.join(', ') } });
  }
  let dailyGoal = null;
  if (daily_goal_chars !== undefined && daily_goal_chars !== null && daily_goal_chars !== '') {
    const n = Number(daily_goal_chars);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < DAILY_GOAL_MIN || n > DAILY_GOAL_MAX) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'daily_goal_chars', allowed: `${DAILY_GOAL_MIN}–${DAILY_GOAL_MAX}` } });
    }
    dailyGoal = n;
  }

  // Schreibziel: Zielzeichenzahl (gesamt). NULL/leer = kein Ziel.
  let goalTarget = null;
  if (goal_target_chars !== undefined && goal_target_chars !== null && goal_target_chars !== '') {
    const n = Number(goal_target_chars);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < GOAL_TARGET_MIN || n > GOAL_TARGET_MAX) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'goal_target_chars', allowed: `${GOAL_TARGET_MIN}–${GOAL_TARGET_MAX}` } });
    }
    goalTarget = n;
  }

  // Abgabedatum: striktes ISO YYYY-MM-DD. NULL/leer = keine Deadline.
  let goalDeadline = null;
  if (goal_deadline !== undefined && goal_deadline !== null && goal_deadline !== '') {
    const s = String(goal_deadline);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'goal_deadline', allowed: 'YYYY-MM-DD' } });
    }
    goalDeadline = s;
  }

  let schauplatzLand = null;
  if (schauplatz_land !== undefined && schauplatz_land !== null && schauplatz_land !== '') {
    if (!/^[A-Za-z]{2}$/.test(String(schauplatz_land))) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'schauplatz_land', allowed: 'ISO-3166-1-alpha-2' } });
    }
    schauplatzLand = String(schauplatz_land).toLowerCase();
  }

  const finished = is_finished ? 1 : 0;
  const lektorBookChat = allow_lektor_book_chat ? 1 : 0;
  const orteReal = orte_real ? 1 : 0;
  saveBookSettings(bookId, language, region, buchtyp || null, buch_kontext || null, erzaehlperspektive || null, erzaehlzeit || null, finished, lektorBookChat, dailyGoal, orteReal, schauplatzLand, goalTarget, goalDeadline, stilprofil || null);
  res.json({
    ok: true, language, region,
    buchtyp: buchtyp || null, buch_kontext: buch_kontext || null,
    stilprofil: stilprofil || null,
    erzaehlperspektive: erzaehlperspektive || null,
    erzaehlzeit: erzaehlzeit || null,
    is_finished: finished,
    allow_lektor_book_chat: lektorBookChat,
    daily_goal_chars: dailyGoal,
    goal_target_chars: goalTarget,
    goal_deadline: goalDeadline,
    orte_real: orteReal,
    schauplatz_land: schauplatzLand,
    locale: `${language}-${region}`,
  });
});

/** Quick-Toggle aus Notebook-Toolbar — patcht nur entities_enabled,
 *  ohne dass der ganze Settings-Body uebertragen werden muss. */
router.put('/:book_id/entities-enabled', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const enabled = req.body?.enabled ? 1 : 0;
  setBookEntitiesEnabled(bookId, enabled);
  res.json({ ok: true, entities_enabled: enabled });
});

module.exports = router;
