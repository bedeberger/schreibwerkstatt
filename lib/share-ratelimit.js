'use strict';
// In-Memory-Rate-Limit für POST /share/:token/comment.
// Max 30 Kommentare pro (Token, IP-Hash) pro 60 Minuten. Beta-Leser hinterlassen
// viele verankerte Inline-Anmerkungen pro Sitzung — der Spam-Schutz muss das
// zulassen, ohne ein Bot-Schleudertor zu sein. Process-Restart resettet
// (akzeptabel: Self-Hosted-Pattern, kein Cluster-Setup).

const crypto = require('crypto');

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const _buckets = new Map(); // `${token}:${ipHash}` → number[] timestamps

let _salt = null;
function _getSalt() {
  if (_salt) return _salt;
  _salt = process.env.SHARE_IP_SALT || crypto.randomBytes(16).toString('hex');
  return _salt;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update((ip || '') + _getSalt()).digest('hex').slice(0, 16);
}

function check(token, ipHash) {
  const key = `${token}:${ipHash}`;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  let arr = _buckets.get(key) || [];
  arr = arr.filter(t => t > cutoff);
  if (arr.length >= MAX_PER_WINDOW) {
    _buckets.set(key, arr);
    return { allowed: false, retryAfterSec: Math.ceil((arr[0] + WINDOW_MS - now) / 1000) };
  }
  arr.push(now);
  _buckets.set(key, arr);
  return { allowed: true, remaining: MAX_PER_WINDOW - arr.length };
}

function _resetAll() {
  _buckets.clear();
}

module.exports = { hashIp, check, _resetAll, WINDOW_MS, MAX_PER_WINDOW };
