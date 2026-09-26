'use strict';
// Server-seitiger Cache + Proxy für Google-Profilbilder. Browser-Tracking-
// Prevention (Edge/Firefox, oft in Firmennetzen) blockiert Storage-Zugriff auf
// `lh3.googleusercontent.com`, sodass das Avatar im Header nicht lädt. Der
// Server holt das Bild stattdessen selbst (nicht von Tracking-Prevention
// betroffen) und liefert es same-origin über `/auth/avatar` aus.
//
// In-Memory-Cache (Map keyed by Bild-URL), TTL + Stale-while-revalidate analog
// lib/font-fetch.js. Kein DB-Persist nötig: die Bild-URL lebt in der Session,
// nach Server-Restart wird einmalig neu geladen.
//
// SSRF-Schutz: es werden ausschliesslich https-URLs auf `*.googleusercontent.com`
// gefetcht (die einzige Quelle, die Google-OIDC im `picture`-Claim liefert).

const logger = require('../logger');
const { fetchWithTimeout, readCapped } = require('./http-util');

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB Hard-Cap

// url -> { buffer, contentType, fetchedAt }
const _cache = new Map();

/** Nur https auf *.googleusercontent.com zulassen (SSRF-Guard). */
function isAllowedAvatarUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return u.hostname === 'googleusercontent.com' || u.hostname.endsWith('.googleusercontent.com');
}

async function _fetchFromGoogle(url) {
  const res = await fetchWithTimeout(url, { redirect: 'follow' }, FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`avatar-upstream ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error(`avatar-bad-type ${contentType}`);
  const buffer = await readCapped(res, MAX_BYTES, { tooLargeCode: 'AVATAR_TOO_LARGE' })
    .catch((e) => { throw e.code === 'AVATAR_TOO_LARGE' ? new Error('avatar-too-large') : e; });
  return { buffer, contentType };
}

/**
 * Liefert `{ buffer, contentType }` für eine Google-Avatar-URL. Cache zuerst,
 * dann Network. Bei Network-Fehler mit (stale) Cache wird der Cache geliefert.
 * Wirft bei nicht-erlaubter URL oder leerem Cache + Network-Fehler.
 */
async function getAvatar(url) {
  if (!isAllowedAvatarUrl(url)) throw new Error('avatar-url-not-allowed');

  const cached = _cache.get(url);
  const fresh = cached && (Date.now() - cached.fetchedAt) < TTL_MS;
  if (fresh) return { buffer: cached.buffer, contentType: cached.contentType };

  try {
    const fetched = await _fetchFromGoogle(url);
    _cache.set(url, { ...fetched, fetchedAt: Date.now() });
    return fetched;
  } catch (e) {
    if (cached) {
      logger.warn(`avatar-fetch failed (${e.message}); serving stale cache`);
      return { buffer: cached.buffer, contentType: cached.contentType };
    }
    throw e;
  }
}

module.exports = { getAvatar, isAllowedAvatarUrl };
