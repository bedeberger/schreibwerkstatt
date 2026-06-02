'use strict';
// ALTCHA-Proof-of-Work-Captcha (self-hosted, kein Drittanbieter).
//
// Flow: Browser holt eine signierte Challenge von /altcha/challenge, brute-forced
// im Web-Worker die Loesungszahl und sendet das base64-Payload im Formular mit.
// Der Server verifiziert HMAC-Signatur + Loesung + Ablaufzeit (verifySolution).
//
// Geschuetzt: /register und der ENV-Admin-Login. Aktivierung via App-Setting
// `auth.altcha.enabled`; der harte Rate-Limit bleibt unabhaengig davon aktiv.
//
// Das HMAC-Secret lebt verschluesselt in app_settings (`auth.altcha.hmac_secret`)
// und wird beim ersten Bedarf automatisch generiert — der Admin muss nur den
// Toggle setzen. Stabil ueber Restarts hinweg, damit vor einem Neustart
// ausgegebene Challenges danach noch verifizieren.

const crypto = require('crypto');
const appSettings = require('./app-settings');
const logger = require('../logger');

// altcha-lib ist ESM mit CJS-Build; der v1-Pfad spricht das klassische
// Challenge-Format, das das vendored Widget (public/vendor/altcha-*.min.js) nutzt.
const { createChallenge, verifySolution } = require('altcha-lib/v1');

// Challenge-Lebensdauer: lange genug fuer User mit langsamem Geraet, kurz genug
// um das Replay-Fenster eng zu halten (Rate-Limit deckt den Rest).
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function isEnabled() {
  return appSettings.get('auth.altcha.enabled') === true;
}

// HMAC-Secret holen; bei Bedarf einmalig generieren + verschluesselt persistieren.
function _secret() {
  let secret = appSettings.get('auth.altcha.hmac_secret');
  if (secret && typeof secret === 'string') return secret;
  secret = crypto.randomBytes(32).toString('hex');
  appSettings.set('auth.altcha.hmac_secret', secret, { updatedBy: 'altcha-autogen' });
  logger.info('ALTCHA: HMAC-Secret automatisch generiert.');
  return secret;
}

// Neue Challenge fuer das Widget. Wirft nur bei kaputtem Setup (kein Secret) —
// Caller behandelt das als 503.
async function createPowChallenge() {
  const maxNumber = appSettings.get('auth.altcha.complexity') || 100000;
  return createChallenge({
    hmacKey: _secret(),
    maxNumber,
    expires: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
}

// Loesung verifizieren. Liefert { ok, skipped?, reason? } analog dem alten
// Captcha-Vertrag: skipped=true wenn ALTCHA aus ist (dann reicht der Rate-Limit).
async function verify(payload) {
  if (!isEnabled()) return { ok: true, skipped: true };
  if (!payload) return { ok: false, reason: 'missing-solution' };
  try {
    const ok = await verifySolution(payload, _secret(), true);
    return ok ? { ok: true } : { ok: false, reason: 'verify-failed' };
  } catch (e) {
    logger.warn(`ALTCHA verify failed: ${e.message}`);
    return { ok: false, reason: 'verify-error' };
  }
}

module.exports = { isEnabled, createPowChallenge, verify };
