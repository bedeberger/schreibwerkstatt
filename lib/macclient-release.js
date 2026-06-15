'use strict';
// Liest das "latest"-GitHub-Release des oeffentlichen Client-Repos
// (bedeberger/schreibwerkstatt-focuseditor), damit die Web-App in /me Version +
// Download-Link der nativen macOS-App (Focus-Writer) anzeigen kann. Das .dmg
// liegt NICHT im Repo, sondern als Release-Asset auf dem GitHub-CDN — die UI
// verlinkt direkt darauf (kein Download-Proxy).
//
// Public-Repo → kein Token noetig. Ist das App-Setting `macclient.github_token`
// gesetzt (Admin-Settings → Erweitert), wird es als Bearer mitgeschickt, um das
// ungewichtete API-Rate-Limit (60/h pro IP) anzuheben (5000/h authentifiziert).
//
// In-Memory-Cache mit TTL (~10 min), damit nicht jeder Profil-Aufruf GitHub
// trifft. Bei Netzfehler/keinem Release wird nie geworfen: der letzte
// erfolgreiche Cache bleibt erhalten, sonst { available: false }.

const logger = require('../logger');
const appSettings = require('./app-settings');

const REPO = 'bedeberger/schreibwerkstatt-focuseditor';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const TTL_MS = 10 * 60 * 1000; // 10 Minuten
const FETCH_TIMEOUT_MS = 8000;

// Letztes erfolgreiches Parse-Ergebnis pro Prozess. Auch ueber die TTL hinaus
// als Fallback bei Netzfehler aufgehoben.
let _cache = null;        // { available: true, version, … } | { available: false }
let _cachedAt = 0;

function _parseRelease(rel) {
  if (!rel || typeof rel !== 'object') return { available: false };
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const dmgAsset = assets.find(a => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.dmg'));
  if (!dmgAsset) return { available: false };
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  return {
    available: true,
    version,
    notes: rel.body || '',
    publishedAt: rel.published_at || null,
    dmg: {
      name: dmgAsset.name,
      sizeBytes: dmgAsset.size || 0,
      downloadUrl: dmgAsset.browser_download_url || '',
    },
  };
}

async function _fetchLatest() {
  const headers = {
    'User-Agent': 'schreibwerkstatt-server',
    'Accept': 'application/vnd.github+json',
  };
  const token = appSettings.get('macclient.github_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      // 404 = noch kein Release; alles andere = transienter Fehler.
      logger.warn(`macclient-release: GitHub-API antwortete HTTP ${res.status}`);
      return res.status === 404 ? { available: false } : null;
    }
    const json = await res.json();
    return _parseRelease(json);
  } finally {
    clearTimeout(timer);
  }
}

// Liefert das geparste Release oder { available:false }. Wirft nie. Bei
// transienten Fehlern wird der letzte gueltige Cache zurueckgegeben (sonst null
// → { available:false }).
async function getLatestRelease() {
  const now = Date.now();
  if (_cache && (now - _cachedAt) < TTL_MS) return _cache;

  try {
    const fresh = await _fetchLatest();
    if (fresh) {
      _cache = fresh;
      _cachedAt = now;
      if (fresh.available) {
        logger.info(`macclient-release: latest = ${fresh.version} (${fresh.dmg.name}, ${(fresh.dmg.sizeBytes / 1048576).toFixed(1)} MB)`);
      } else {
        logger.info('macclient-release: kein .dmg-Asset im latest-Release');
      }
      return _cache;
    }
    // Transienter Fehler: alten Cache behalten, sonst "nicht verfuegbar".
    return _cache || { available: false };
  } catch (e) {
    logger.warn(`macclient-release: Abruf fehlgeschlagen (${e.message}); nutze Cache-Fallback`);
    return _cache || { available: false };
  }
}

module.exports = {
  getLatestRelease,
  _parseRelease, // export fuer Tests
  _resetCache() { _cache = null; _cachedAt = 0; },
};
