'use strict';
// Geocoding-Kern fuer die Orte-Karte. Schlaegt Koordinaten zu einem Ortsnamen
// vor. Genutzt von der HTTP-Route (routes/geocode.js, User-Vorschlag) UND vom
// naechtlichen Cron (geocodeAllBooks, Auto-Verortung). Beide teilen denselben
// Provider, dieselbe Rate-Limit-Kette und dieselbe Antwort-Normalisierung.
//
// Provider waehlbar via app_settings `geocode.provider`:
//   - 'nominatim' (Default): OSM-Nominatim `search`, jsonv2. Public-Instanz hat
//     Policy max. 1 Request/Sekunde + Pflicht-User-Agent → wir serialisieren mit
//     Mindestabstand. Self-hosted Instanz via `geocode.nominatim.url`.
//   - 'photon': Komoot-Photon (self-hosted), GeoJSON-Antwort. Kein Rate-Limit,
//     URL via `geocode.photon.url`. Photon braucht zwingend eine URL.
// Fehler/Timeout/Fehlkonfiguration → leeres Kandidaten-Array (non-fatal —
// manueller Pin bleibt immer moeglich).
const appSettings = require('./app-settings');
const logger = require('../logger');
const { db, getBookSettings } = require('../db/schema');
const { NOW_ISO_SQL } = require('../db/now');
const contentStore = require('./content-store');

const USER_AGENT = process.env.NOMINATIM_USER_AGENT || 'Schreibwerkstatt/1.0 (self-hosted book tool)';
const NOMINATIM_MIN_INTERVAL_MS = 1100; // > 1s Nominatim-Public-Policy
const REQUEST_TIMEOUT_MS = 8000;
const MAX_QUERY_LEN = 200;

// Beschreibendes/fiktives Schauplatz-Label → wahrscheinlicher Toponym. Schneidet
// einen fuehrenden Beschreibungsteil vor einem lokativen Bindewort ab
// («Bar in Olten» → «Olten», «Marktplatz von Bern» faellt nicht, kein Bindewort
// in der Liste — dafuer greift der KI-Fallback). Rein regelbasiert, pure →
// unit-testbar. null, wenn kein Bindewort gefunden oder Rest leer.
const _LOCATIVE_RE = /\s(?:in der|in dem|im|in|bei der|beim|bei|an der|an dem|am|an|auf der|auf dem|auf|vor der|vor dem|vor|zur|zum|zu|near|at|on)\s/gi;
function parseToponym(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  const matches = [...s.matchAll(_LOCATIVE_RE)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const tail = s.slice(last.index + last[0].length).trim();
  return tail || null;
}

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

// Serialisierung: jede Anfrage haengt sich hinten an die Kette und wartet, bis
// der Mindestabstand zur letzten erreicht ist. Verhindert Policy-Verstoss bei
// der Public-Nominatim-Instanz (Photon self-hosted: minInterval 0). Geteilt
// zwischen Route und Cron → beide drosseln gemeinsam gegen dieselbe API.
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

// Loest den aktiven Provider + dessen Basis-URL + Mindestabstand auf.
// base === null signalisiert Fehlkonfiguration (Photon ohne URL).
function _resolveProvider() {
  const provider = appSettings.get('geocode.provider') === 'photon' ? 'photon' : 'nominatim';
  if (provider === 'photon') {
    const base = String(appSettings.get('geocode.photon.url') || '')
      .replace(/\/+$/, '')
      .replace(/\/api$/i, '');
    return { provider, base: base || null, minInterval: 0 };
  }
  const base = String(appSettings.get('geocode.nominatim.url') || 'https://nominatim.openstreetmap.org/search');
  return { provider, base, minInterval: NOMINATIM_MIN_INTERVAL_MS };
}

/**
 * Geocodet einen Ortsnamen → Kandidaten-Array `[{ lat, lng, displayName }]`.
 * Fehler/Timeout/Fehlkonfiguration → `[]` (non-fatal). lang: 'de'|'en'.
 * region: optionaler ISO-3166-1-alpha-2-Code (nur Nominatim, biast countrycodes).
 */
async function geocode(query, { lang = 'de', region = null } = {}) {
  const q = String(query || '').trim();
  if (!q || q.length > MAX_QUERY_LEN) return [];
  const safeLang = /^(de|en)$/.test(String(lang)) ? String(lang) : 'de';
  const cc = /^[A-Za-z]{2}$/.test(String(region || '')) ? String(region).toLowerCase() : null;
  const { provider, base, minInterval } = _resolveProvider();
  if (provider === 'photon' && !base) {
    logger.warn('[geocode] Photon als Provider gewaehlt, aber geocode.photon.url leer.');
    return [];
  }

  const runQuery = async (qStr) => {
    try {
      if (provider === 'photon') {
        return await _schedule(async () => {
          const params = new URLSearchParams({ q: qStr, limit: '5', lang: safeLang });
          const fc = await _fetchJson(`${base}/api?${params.toString()}`);
          return parsePhotonResults(fc);
        }, minInterval);
      }
      return await _schedule(async () => {
        const params = new URLSearchParams({ q: qStr, format: 'jsonv2', limit: '5', 'accept-language': safeLang });
        if (cc) params.set('countrycodes', cc);
        const arr = await _fetchJson(`${base}?${params.toString()}`);
        return parseNominatimResults(arr);
      }, minInterval);
    } catch (e) {
      logger.warn(`[geocode] ${provider}-Abfrage fehlgeschlagen: ${e.message}`);
      return [];
    }
  };

  // Erst das rohe Label, dann — falls leer — der regelbasiert extrahierte Toponym
  // («Bar in Olten» → «Olten»). KI-Fallback (Job/Cron) greift erst, wenn auch das leer bleibt.
  let results = await runQuery(q);
  if (!results.length) {
    const top = parseToponym(q);
    if (top && top.toLowerCase() !== q.toLowerCase()) results = await runQuery(top);
  }
  return results;
}

const _updateCoords = db.prepare(
  `UPDATE locations SET lat = ?, lng = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);

/**
 * Naechtlicher Cron: verortet alle noch nicht verorteten Orte automatisch.
 * Nur Buecher mit `book_settings.orte_real` (Feature ist per Buch opt-in, Default
 * aus). Nur Orte ohne Koordinaten (`lat IS NULL OR lng IS NULL`) — manuell
 * gepinnte/gedraggte und bereits gesetzte Coords bleiben unangetastet. Region
 * aus `schauplatz_land` biast die Suche. Rate-Limit teilt sich die Kette mit der
 * HTTP-Route. Cap als Sicherheitsnetz gegen einen ueberlangen Public-API-Lauf.
 *
 * `aiResolve` (optional, via DI aus server.js — haelt lib dependency-frei von
 * routes/jobs): async (name, { language, region }) => ({ ort, land }) | null.
 * Greift nur bei leerer Heuristik: normalisiert das Label auf einen realen
 * Toponym, der dann erneut geocodet wird.
 */
async function geocodeAllBooks({ aiResolve = null } = {}) {
  if (appSettings.get('geocode.cron.enabled') === false) {
    logger.info('[geocode] Cron deaktiviert (geocode.cron.enabled=false).');
    return { books: 0, geocoded: 0, attempted: 0, failed: 0 };
  }
  const { provider, base } = _resolveProvider();
  if (provider === 'photon' && !base) {
    logger.warn('[geocode] Cron uebersprungen: Photon-Provider, aber geocode.photon.url leer.');
    return { books: 0, geocoded: 0, attempted: 0, failed: 0 };
  }
  const maxPerRun = Math.max(1, parseInt(appSettings.get('geocode.cron.max_per_run'), 10) || 1000);

  const books = await contentStore.listBooks(null);
  let booksProcessed = 0, attempted = 0, geocoded = 0, failed = 0, capped = false;

  for (const book of books) {
    if (attempted >= maxPerRun) { capped = true; break; }
    const settings = getBookSettings(book.id);
    if (!settings?.orte_real) continue;

    const rows = db.prepare(
      'SELECT id, name FROM locations WHERE book_id = ? AND (lat IS NULL OR lng IS NULL) ORDER BY id'
    ).all(book.id);
    if (!rows.length) continue;

    booksProcessed++;
    const lang = settings.language || 'de';
    const region = settings.schauplatz_land || null;

    for (const row of rows) {
      if (attempted >= maxPerRun) { capped = true; break; }
      const name = String(row.name || '').trim();
      if (!name) continue;
      attempted++;
      // KI-first: Label zuerst auf eine praezise reale Anfrage normalisieren
      // («Badi Olten» → «Olten»), erst dann geocoden. Verhindert, dass der
      // tolerante Geocoder das rohe Label auf einen falschen Treffer zieht.
      let candidates = [];
      if (typeof aiResolve === 'function') {
        try {
          const r = await aiResolve(name, { language: lang, region });
          if (r?.ort) candidates = await geocode(r.ort, { lang, region: r.land || region });
        } catch (e) {
          logger.warn(`[geocode] KI-Normalisierung fehlgeschlagen fuer «${name}»: ${e.message}`);
        }
      }
      // Safety-Net: kein Resolver / KI ohne realen Anker → rohes Label heuristisch.
      if (!candidates.length) candidates = await geocode(name, { lang, region });
      const c = candidates[0];
      if (c) {
        _updateCoords.run(c.lat, c.lng, row.id);
        geocoded++;
      } else {
        failed++;
      }
    }
  }

  logger.info(`[geocode] Cron fertig: ${geocoded}/${attempted} Orte verortet aus ${booksProcessed} Buch/Buechern (${failed} ohne Treffer)${capped ? `, Cap ${maxPerRun} erreicht — Rest naechsten Lauf.` : '.'}`);
  return { books: booksProcessed, geocoded, attempted, failed, capped };
}

module.exports = { geocode, geocodeAllBooks, parseToponym, parseNominatimResults, parsePhotonResults };
