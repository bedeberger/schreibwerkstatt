'use strict';
// DB-Helper fuer api_tokens. Plain-Token wird nur einmal beim Create
// zurueckgegeben; danach existiert in der DB ausschliesslich der SHA-256-Hash.
// Format: `sw_<32 Hex-Bytes>` — grepbar in Leaks, 256 Bit Entropie.

const crypto = require('crypto');
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const TOKEN_PREFIX = 'sw_';

function generatePlainToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain || ''), 'utf8').digest('hex');
}

function createApiToken({ adminEmail, displayName, scopes = 'metrics:read', expiresAt = null }) {
  if (!adminEmail) throw new Error('admin_email required');
  if (!displayName || !String(displayName).trim()) throw new Error('display_name required');
  const plain = generatePlainToken();
  const hash = hashToken(plain);
  const r = db.prepare(`
    INSERT INTO api_tokens (admin_email, token_hash, display_name, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  `).run(adminEmail, hash, String(displayName).trim().slice(0, 100), scopes, expiresAt);
  const row = db.prepare('SELECT id, admin_email, display_name, scopes, expires_at, created_at FROM api_tokens WHERE id = ?').get(r.lastInsertRowid);
  return { ...row, plain_token: plain };
}

function findActiveTokenByPlain(plain) {
  if (!plain || typeof plain !== 'string') return null;
  if (!plain.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plain);
  const row = db.prepare(`
    SELECT id, admin_email, scopes, expires_at, revoked_at
    FROM api_tokens
    WHERE token_hash = ?
  `).get(hash);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) return null;
  return row;
}

function touchTokenUsage(tokenId, ip) {
  db.prepare(`UPDATE api_tokens SET last_used_at = ${NOW_ISO_SQL}, last_used_ip = ? WHERE id = ?`)
    .run(String(ip || '').slice(0, 64), tokenId);
}

function listApiTokens(adminEmail) {
  const where = adminEmail ? 'WHERE admin_email = ?' : '';
  const params = adminEmail ? [adminEmail] : [];
  return db.prepare(`
    SELECT id, admin_email, display_name, scopes,
           last_used_at, last_used_ip, expires_at, revoked_at, created_at
    FROM api_tokens
    ${where}
    ORDER BY (revoked_at IS NULL) DESC, created_at DESC
  `).all(...params);
}

function revokeApiToken(id, adminEmail) {
  const r = db.prepare(`
    UPDATE api_tokens SET revoked_at = ${NOW_ISO_SQL}
    WHERE id = ? AND admin_email = ? AND revoked_at IS NULL
  `).run(id, adminEmail);
  return r.changes > 0;
}

function deleteApiToken(id, adminEmail) {
  const r = db.prepare('DELETE FROM api_tokens WHERE id = ? AND admin_email = ?').run(id, adminEmail);
  return r.changes > 0;
}

module.exports = {
  TOKEN_PREFIX,
  generatePlainToken,
  hashToken,
  createApiToken,
  findActiveTokenByPlain,
  touchTokenUsage,
  listApiTokens,
  revokeApiToken,
  deleteApiToken,
};
