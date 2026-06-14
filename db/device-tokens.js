'use strict';
// DB-Helper fuer device_tokens — per-User-Bearer-Token fuer native Clients
// (Mac-Focus-Writer). Plain-Token wird nur einmal beim Create zurueckgegeben;
// danach existiert in der DB ausschliesslich der SHA-256-Hash.
// Format: `swd_<32 Hex-Bytes>` — eigener Prefix, damit der Device-Bearer-Pfad
// fremde Tokens (`sw_…` = api_tokens/Metrics) frueh abweisen kann.

const crypto = require('crypto');
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const TOKEN_PREFIX = 'swd_';
const DEFAULT_SCOPES = 'content:read,content:write';

function generatePlainToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain || ''), 'utf8').digest('hex');
}

function createDeviceToken({ userEmail, deviceName, platform = null, scopes = DEFAULT_SCOPES, expiresAt = null }) {
  if (!userEmail) throw new Error('user_email required');
  if (!deviceName || !String(deviceName).trim()) throw new Error('device_name required');
  const plain = generatePlainToken();
  const hash = hashToken(plain);
  const r = db.prepare(`
    INSERT INTO device_tokens (user_email, token_hash, device_name, platform, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  `).run(userEmail, hash, String(deviceName).trim().slice(0, 100), platform ? String(platform).slice(0, 40) : null, scopes || DEFAULT_SCOPES, expiresAt);
  const row = db.prepare('SELECT id, user_email, device_name, platform, scopes, expires_at, created_at FROM device_tokens WHERE id = ?').get(r.lastInsertRowid);
  return { ...row, plain_token: plain };
}

function findActiveTokenByPlain(plain) {
  if (!plain || typeof plain !== 'string') return null;
  if (!plain.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plain);
  const row = db.prepare(`
    SELECT id, user_email, scopes, expires_at, revoked_at
    FROM device_tokens
    WHERE token_hash = ?
  `).get(hash);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) return null;
  return row;
}

function touchTokenUsage(tokenId, ip) {
  db.prepare(`UPDATE device_tokens SET last_used_at = ${NOW_ISO_SQL}, last_used_ip = ? WHERE id = ?`)
    .run(String(ip || '').slice(0, 64), tokenId);
}

function listDeviceTokens(userEmail) {
  return db.prepare(`
    SELECT id, user_email, device_name, platform, scopes,
           last_used_at, last_used_ip, expires_at, revoked_at, created_at
    FROM device_tokens
    WHERE user_email = ?
    ORDER BY (revoked_at IS NULL) DESC, created_at DESC
  `).all(userEmail);
}

function revokeDeviceToken(id, userEmail) {
  const r = db.prepare(`
    UPDATE device_tokens SET revoked_at = ${NOW_ISO_SQL}
    WHERE id = ? AND user_email = ? AND revoked_at IS NULL
  `).run(id, userEmail);
  return r.changes > 0;
}

function deleteDeviceToken(id, userEmail) {
  const r = db.prepare('DELETE FROM device_tokens WHERE id = ? AND user_email = ?').run(id, userEmail);
  return r.changes > 0;
}

module.exports = {
  TOKEN_PREFIX,
  DEFAULT_SCOPES,
  generatePlainToken,
  hashToken,
  createDeviceToken,
  findActiveTokenByPlain,
  touchTokenUsage,
  listDeviceTokens,
  revokeDeviceToken,
  deleteDeviceToken,
};
