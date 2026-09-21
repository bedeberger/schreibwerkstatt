'use strict';
// Passwort-Hashing fuer die lokale Anmeldung (`auth.method='local'`).
//
// scrypt aus dem Node-Core statt bcrypt/argon2: die App laeuft self-hosted in
// einem LXC, und eine native Abhaengigkeit, die beim Node-Upgrade neu gebaut
// werden muss, ist genau das, was eine Anmeldung nicht braucht. scrypt ist
// speicherhart und damit gegen GPU-Brute-Force widerstandsfaehig.
//
// Format des gespeicherten Strings:
//
//   scrypt$<N>$<r>$<p>$<salt-b64url>$<hash-b64url>
//
// Die Parameter stehen IM String, nicht in einer Spalte daneben: wer den
// Kostenfaktor spaeter anhebt, muss die bestehenden Hashes weiter verifizieren
// koennen, sonst sperrt ein Parameter-Wechsel alle Konten aus. `needsRehash`
// meldet, welche Hashes beim naechsten erfolgreichen Login neu gerechnet
// gehoeren.

const crypto = require('crypto');
const appSettings = require('./app-settings');

// N=2^15 kostet rund 100 ms und 32 MB pro Verifikation auf der Zielhardware —
// genug, um Offline-Brute-Force teuer zu machen, wenig genug, dass ein Login
// nicht spuerbar haengt. maxmem muss explizit hoch, sonst wirft scrypt bei N
// ueber 16384 mit dem Node-Default von 32 MB.
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };
const MAXMEM = 256 * 1024 * 1024;

const _b64 = (buf) => buf.toString('base64url');

function _scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'), salt, keylen,
      { N, r, p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Neuen Hash im aktuellen Parametersatz erzeugen. */
async function hashPassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('hashPassword: password required');
  const salt = crypto.randomBytes(16);
  const key = await _scrypt(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${_b64(salt)}$${_b64(key)}`;
}

function _parse(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, N, r, p, saltB64, hashB64] = parts;
  const nums = [Number(N), Number(r), Number(p)];
  if (nums.some(n => !Number.isInteger(n) || n <= 0)) return null;
  try {
    const salt = Buffer.from(saltB64, 'base64url');
    const hash = Buffer.from(hashB64, 'base64url');
    if (!salt.length || !hash.length) return null;
    return { N: nums[0], r: nums[1], p: nums[2], salt, hash, keylen: hash.length };
  } catch {
    return null;
  }
}

/**
 * Passwort gegen einen gespeicherten Hash pruefen. Liefert immer false statt zu
 * werfen — ein kaputter Hash in der DB ist ein fehlgeschlagener Login, keine
 * 500er-Antwort, die dem Aufrufer verraet, dass dieses Konto existiert.
 */
async function verifyPassword(password, stored) {
  const parsed = _parse(stored);
  if (!parsed || typeof password !== 'string' || !password) return false;
  try {
    const key = await _scrypt(password, parsed.salt, parsed);
    // Laengen sind durch keylen=hash.length identisch; timingSafeEqual wirft
    // sonst, statt false zu liefern.
    return key.length === parsed.hash.length && crypto.timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

/** Wurde dieser Hash mit schwaecheren Parametern als heute gerechnet? */
function needsRehash(stored) {
  const parsed = _parse(stored);
  if (!parsed) return true;
  return parsed.N !== PARAMS.N || parsed.r !== PARAMS.r || parsed.p !== PARAMS.p
    || parsed.keylen !== PARAMS.keylen;
}

function minLength() {
  const v = appSettings.get('auth.local.min_password_length');
  return Number.isInteger(v) ? v : 12;
}

/**
 * Policy-Pruefung vor dem Setzen. Bewusst nur Laenge und ein Deckel, keine
 * Zeichenklassen-Pflicht: erzwungene Sonderzeichen verschieben Passwoerter in
 * Richtung „Passwort1!" und machen sie nicht schwerer zu raten. Die Laenge ist
 * ueber `auth.local.min_password_length` konfigurierbar, der Deckel nicht — er
 * schuetzt nur davor, dass jemand die scrypt-Kosten mit einem Megabyte-Eingang
 * gegen den Server richtet.
 *
 * Liefert `null` bei Erfolg, sonst einen i18n-Key fuer die Fehlermeldung.
 */
function validatePassword(password) {
  if (typeof password !== 'string' || !password) return 'auth.password.errRequired';
  if (password.length < minLength()) return 'auth.password.errTooShort';
  if (Buffer.byteLength(password, 'utf8') > 1024) return 'auth.password.errTooLong';
  return null;
}

module.exports = { hashPassword, verifyPassword, needsRehash, validatePassword, minLength, PARAMS };
