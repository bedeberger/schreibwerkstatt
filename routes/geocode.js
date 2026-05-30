'use strict';
// Geocoding-Proxy fuer die Orte-Karte. Schlaegt Koordinaten zu einem Ortsnamen
// vor; der User korrigiert per Marker-Drag. Kein KI-Call → normale Route (keine
// Job-Queue). Auth greift global.
//
// Provider waehlbar via app_settings `geocode.provider`:
//   - 'nominatim' (Default): OSM-Nominatim `search`, jsonv2. Public-Instanz hat
//     Policy max. 1 Request/Sekunde + Pflicht-User-Agent → wir serialisieren mit
//     Mindestabstand. Self-hosted Instanz via `geocode.nominatim.url`.
//   - 'photon': Komoot-Photon (self-hosted), GeoJSON-Antwort. Kein Rate-Limit,
//     URL via `geocode.photon.url`. Photon braucht zwingend eine URL.
// Fehler/Timeout/Fehlkonfiguration → leeres Kandidaten-Array (non-fatal —
// manueller Pin bleibt immer moeglich).
const express = require('express');
const appSettings = require('../lib/app-settings');
const logger = require('../logger');

const router = express.Router();

// Nominatim-Antwort (Fremd-Input) → flaches Kandidaten-Array. Verwirft Eintraege
// ohne gueltige Koordinaten. Pure → unit-testbar ohne Netzwerk.
function parseNominatimResults(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(item => {
      const rawLat = item?.lat;
      const rawLng = item?.lon;
      if (rawLat == null || rawLat === '' || rawLng == null || rawLng === '') return null;
      const lat = Number(rawLat);
      const lng = Number(rawLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, displayName: String(item?.display_name || '') };
    })
    .filter(Boolean);
}

// Photon-Antwort (GeoJSON FeatureCollection) → flaches Kandidaten-Array.
// Koordinaten liegen als [lon, lat] in geometry.coordinates. displayName aus den
// Adress-Properties zusammengesetzt. Pure → unit-testbar ohne Netzwerk.
function parsePhotonResults(fc) {
  const feats = Array.isArray(fc?.features) ? fc.features : [];
  return feats
    .map(f => {
      const coords = f?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return null;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const p = f.properties || {};
      const displayName = [p.name, p.street, p.city, p.state, p.country]
        .filter(s => s != null && String(s).trim() !== '')
        .join(', ');
      return { lat, lng, displayName };
    })
    .filter(Boolean);
}

const USER_AGENT = process.env.NOMINATIM_USER_AGENT || 'Schreibwerkstatt/1.0 (self-hosted book tool)';
const NOMINATIM_MIN_INTERVAL_MS = 1100; // > 1s Nominatim-Public-Policy
const REQUEST_TIMEOUT_MS = 8000;
const MAX_QUERY_LEN = 200;

// Serialisierung: jede Anfrage haengt sich hinten an die Kette und wartet, bis
// der Mindestabstand zur letzten erreicht ist. Verhindert Policy-Verstoss bei
// der Public-Nominatim-Instanz (Photon self-hosted: minInterval 0).
let _chain = Promise.resolve();
let _lastCallAt = 0;

function _schedule(task, minIntervalMs) {
  const run = _chain.then(async () => {
    const wait = Math.max(0, _lastCallAt + minIntervalMs - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCallAt = Date.now();
    return task();
  });
  // Kette darf nicht durch einen Fehler reissen.
  _chain = run.then(() => {}, () => {});
  return run;
}

async function _fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error_code: 'QUERY_REQUIRED' });
  if (q.length > MAX_QUERY_LEN) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });

  const lang = /^(de|en)$/.test(String(req.query.lang)) ? String(req.query.lang) : 'de';
  const cc = /^[A-Za-z]{2}$/.test(String(req.query.region)) ? String(req.query.region).toLowerCase() : null;

  const provider = appSettings.get('geocode.provider') === 'photon' ? 'photon' : 'nominatim';

  try {
    if (provider === 'photon') {
      const base = String(appSettings.get('geocode.photon.url') || '')
        .replace(/\/+$/, '')
        .replace(/\/api$/i, '');
      if (!base) {
        logger.warn('[geocode] Photon als Provider gewaehlt, aber geocode.photon.url leer.');
        return res.json({ candidates: [] });
      }
      const candidates = await _schedule(async () => {
        const params = new URLSearchParams({ q, limit: '5', lang });
        const fc = await _fetchJson(`${base}/api?${params.toString()}`);
        return parsePhotonResults(fc);
      }, 0);
      return res.json({ candidates });
    }

    const base = String(appSettings.get('geocode.nominatim.url') || 'https://nominatim.openstreetmap.org/search');
    const candidates = await _schedule(async () => {
      const params = new URLSearchParams({
        q,
        format: 'jsonv2',
        limit: '5',
        'accept-language': lang,
      });
      if (cc) params.set('countrycodes', cc);
      const arr = await _fetchJson(`${base}?${params.toString()}`);
      return parseNominatimResults(arr);
    }, NOMINATIM_MIN_INTERVAL_MS);
    res.json({ candidates });
  } catch (e) {
    logger.warn(`[geocode] ${provider}-Abfrage fehlgeschlagen: ${e.message}`);
    res.json({ candidates: [] });
  }
});

module.exports = router;
module.exports.parseNominatimResults = parseNominatimResults;
module.exports.parsePhotonResults = parsePhotonResults;
