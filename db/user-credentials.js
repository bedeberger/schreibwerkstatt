'use strict';
// Helper-API ueber `user_credentials` (Passwort-Hash je Konto) und
// `user_password_tokens` (Einmal-Links zum Setzen/Zuruecksetzen).
// Keine direkte SQL aus Konsumenten.
//
// Beide Tabellen existieren nur fuer die lokale Anmeldung (`auth.method='local'`).
// Auf einer Instanz, die ueber einen IdP anmeldet, bleiben sie leer.
//
// Die Token-Zeile speichert ausschliesslich den SHA-256-Hash des Tokens — aus
// einem DB-Leak laesst sich damit kein gueltiger Link bauen. Der Klartext
// existiert genau einmal: im Rueckgabewert von `createToken` und danach nur
// noch in der Mail.

const crypto = require('crypto');
const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

function _norm(email) {
  return (email || '').trim().toLowerCase();
}

function _hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ── Passwort-Hash ──────────────────────────────────────────────────────────

const _stmtGet = db.prepare(`
  SELECT user_email, password_hash, must_change, updated_by, created_at, updated_at
    FROM user_credentials
   WHERE user_email = ?
`);

const _stmtUpsert = db.prepare(`
  INSERT INTO user_credentials (user_email, password_hash, must_change, updated_by, created_at, updated_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  ON CONFLICT(user_email) DO UPDATE SET
    password_hash = excluded.password_hash,
    must_change   = excluded.must_change,
    updated_by    = excluded.updated_by,
    updated_at    = excluded.updated_at
`);

const _stmtDelete = db.prepare('DELETE FROM user_credentials WHERE user_email = ?');


/** Hash-Zeile oder null. Der Aufrufer prueft mit lib/password.verifyPassword. */
function getCredential(email) {
  const e = _norm(email);
  if (!e) return null;
  return _stmtGet.get(e) || null;
}

function hasPassword(email) {
  return !!getCredential(email);
}

/**
 * Passwort-Hash setzen (Insert oder Update).
 * `mustChange` markiert ein vom Admin vergebenes Initialpasswort: der Login
 * fuehrt dann zwingend auf die Setz-Seite, statt eine Sitzung zu eroeffnen.
 * `updatedBy` ist der handelnde Admin — NULL, wenn der User es selbst gesetzt hat.
 */
function setPassword(email, passwordHash, { mustChange = 0, updatedBy = null } = {}) {
  const e = _norm(email);
  if (!e) throw new Error('setPassword: email required');
  if (!passwordHash) throw new Error('setPassword: passwordHash required');
  _stmtUpsert.run(e, passwordHash, mustChange ? 1 : 0, _norm(updatedBy) || null);
}

/** Hash entfernen — das Konto kann sich danach nicht mehr lokal anmelden. */
function deleteCredential(email) {
  const e = _norm(email);
  if (!e) return;
  _stmtDelete.run(e);
}

/** Konten mit gesetztem Passwort — fuer die Admin-Liste (eine Abfrage statt N). */
function listEmailsWithPassword() {
  return db.prepare('SELECT user_email, must_change FROM user_credentials').all();
}

// ── Einmal-Tokens ──────────────────────────────────────────────────────────

const _stmtTokenInsert = db.prepare(`
  INSERT INTO user_password_tokens (user_email, token_hash, purpose, created_by, created_at, expires_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ?)
`);

const _stmtTokenFind = db.prepare(`
  SELECT id, user_email, purpose, created_by, created_at, expires_at, used_at
    FROM user_password_tokens
   WHERE token_hash = ?
`);

const _stmtTokenConsume = db.prepare(`
  UPDATE user_password_tokens SET used_at = ${NOW_ISO_SQL} WHERE id = ? AND used_at IS NULL
`);

const _stmtTokenRevokeOpen = db.prepare(`
  UPDATE user_password_tokens SET used_at = ${NOW_ISO_SQL}
   WHERE user_email = ? AND used_at IS NULL
`);

const _stmtTokenPurge = db.prepare(`
  DELETE FROM user_password_tokens
   WHERE used_at IS NOT NULL OR datetime(expires_at) < datetime('now', '-30 days')
`);

/**
 * Neues Einmal-Token. Liefert `{ token, expiresAt }` — der Klartext wird nicht
 * gespeichert und ist danach nur noch im Link.
 *
 * Offene Tokens desselben Kontos werden entwertet: ein neu angeforderter Link
 * soll den alten ausser Kraft setzen, sonst bleibt eine abgefangene aeltere Mail
 * bis zu ihrem Ablauf gueltig.
 */
function createToken(email, { purpose = 'set', ttlHours = 48, createdBy = null } = {}) {
  const e = _norm(email);
  if (!e) throw new Error('createToken: email required');
  if (purpose !== 'set' && purpose !== 'reset') throw new Error("createToken: purpose must be 'set'|'reset'");
  _stmtTokenRevokeOpen.run(e);
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.max(1, ttlHours) * 3600_000).toISOString();
  _stmtTokenInsert.run(e, _hashToken(token), purpose, _norm(createdBy) || null, expiresAt);
  return { token, expiresAt };
}

/** Token aufloesen. Liefert die Zeile nur, wenn sie ungebraucht und gueltig ist. */
function findValidToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = _stmtTokenFind.get(_hashToken(token));
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Als verbraucht markieren. Liefert false, wenn ein paralleler Request schneller war. */
function consumeToken(id) {
  return _stmtTokenConsume.run(id).changes === 1;
}

function revokeOpenTokens(email) {
  const e = _norm(email);
  if (!e) return;
  _stmtTokenRevokeOpen.run(e);
}

/** Aufraeumen verbrauchter/alter Zeilen (Cron). */
function purgeTokens() {
  return _stmtTokenPurge.run().changes;
}

module.exports = {
  getCredential, hasPassword, setPassword, deleteCredential, listEmailsWithPassword,
  createToken, findValidToken, consumeToken, revokeOpenTokens, purgeTokens,
};
