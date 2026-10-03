'use strict';
// Lädt TTF-Buffers von Google Fonts zur Render-Zeit. Cache via db/fonts.js
// (30-Tage-TTL, Stale-while-revalidate). Eingaben sind whitelisted: nur
// Familien aus FONT_LIST und Weights aus deren `weights`-Array werden
// akzeptiert (verhindert SSRF / beliebige Outbound-Requests).
//
// Implementierung:
//  - Hit `https://fonts.googleapis.com/css?family=...` (CSS-API v1) mit
//    User-Agent, der Server zum TTF-Serving zwingt.
//  - Aus dem CSS regex-extrahieren des passenden TTF-URLs für gewünschten
//    Weight + Style.
//  - Download des TTF-Buffers, in font_cache speichern.
//  - Wenn Fetch fehlschlägt und stale-Cache vorhanden → stale-Buffer zurück.

const { getCachedFont, cacheFont } = require('../db/fonts');
const { fetchWithTimeout, readCapped } = require('./http-util');
const logger = require('../logger');

// Feste Ziele (fonts.googleapis.com / fonts.gstatic.com) — kein SSRF-Guard
// noetig, aber Zeit- und Byte-Deckel: ein haengender Google-Endpunkt darf den
// PDF-Job nicht unbegrenzt halten.
const FETCH_TIMEOUT_MS = 15_000;
const CSS_MAX_BYTES    = 256 * 1024;
const TTF_MAX_BYTES    = 8 * 1024 * 1024;

// Kuratierte Liste populärer Google-Fonts. Pro Eintrag: Weights + Styles, die
// das Frontend auswählen darf.
const FONT_LIST = [
  // Serif (Body / Heading / Title)
  { family: 'EB Garamond',      category: 'serif', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Lora',             category: 'serif', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Crimson Pro',      category: 'serif', weights: [400, 500, 600, 700, 800], styles: ['normal', 'italic'] },
  { family: 'Source Serif 4',   category: 'serif', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Merriweather',     category: 'serif', weights: [400, 700, 900], styles: ['normal', 'italic'] },
  { family: 'Playfair Display', category: 'serif', weights: [400, 600, 700, 900], styles: ['normal', 'italic'] },
  { family: 'PT Serif',         category: 'serif', weights: [400, 700], styles: ['normal', 'italic'] },
  { family: 'Cormorant Garamond', category: 'serif', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Libre Baskerville',  category: 'serif', weights: [400, 700], styles: ['normal', 'italic'] },
  { family: 'Bitter',           category: 'serif', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Spectral',         category: 'serif', weights: [300, 400, 600, 700], styles: ['normal', 'italic'] },

  // Sans
  { family: 'Inter',            category: 'sans', weights: [400, 500, 600, 700], styles: ['normal'] },
  { family: 'Source Sans 3',    category: 'sans', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Roboto',           category: 'sans', weights: [400, 500, 700], styles: ['normal', 'italic'] },
  { family: 'Open Sans',        category: 'sans', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Lato',             category: 'sans', weights: [400, 700, 900], styles: ['normal', 'italic'] },
  { family: 'Nunito',           category: 'sans', weights: [400, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Work Sans',        category: 'sans', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Noto Sans',        category: 'sans', weights: [400, 700], styles: ['normal', 'italic'] },
  { family: 'Noto Serif',       category: 'serif', weights: [400, 700], styles: ['normal', 'italic'] },

  // Display / Title
  { family: 'Cormorant',        category: 'display', weights: [400, 500, 600, 700], styles: ['normal', 'italic'] },
  { family: 'Cinzel',           category: 'display', weights: [400, 600, 700, 900], styles: ['normal'] },
  { family: 'Great Vibes',      category: 'handwriting', weights: [400], styles: ['normal'] },

  // Monospace (selten gebraucht, nur als Notbehelf)
  { family: 'JetBrains Mono',   category: 'mono', weights: [400, 500, 700], styles: ['normal', 'italic'] },
];

const FONT_INDEX = new Map(FONT_LIST.map(f => [f.family, f]));

// Wget liefert von der Google-CSS-API zuverlässig `format('truetype')`-Einträge.
// Andere getestete UAs (alte Firefox/IE) geben WOFF/WOFF2 zurück, was pdfkit
// nicht embedden kann.
const UA_FOR_TTF = 'Wget/1.13.4';

function listFonts() {
  return FONT_LIST.map(f => ({ family: f.family, category: f.category, weights: f.weights, styles: f.styles }));
}

function isAllowed(family, weight, style) {
  const f = FONT_INDEX.get(family);
  if (!f) return false;
  if (!f.weights.includes(parseInt(weight))) return false;
  if (!f.styles.includes(style)) return false;
  return true;
}

function _buildCssUrl(family, weight, style) {
  // Old-API: /css?family=Lora:400,400i,700,700i&display=swap. Liefert TTF
  // bei Firefox-UA. Family-Whitelist enthält nur alphanumerische Namen + Spaces,
  // darum reicht der Space→+ Replace; `:` muss literal bleiben, was URLSearchParams
  // percent-encoden würde.
  const tag = `${weight}${style === 'italic' ? 'i' : ''}`;
  const fam = family.replaceAll(' ', '+');
  return `https://fonts.googleapis.com/css?family=${fam}:${tag}&display=swap`;
}

/** Prueft alle Schrift-Rollen einer (validierten) `config.font` gegen die
 *  Whitelist — nur auf FAMILIEN-Ebene. Fehlt einer erlaubten Familie bloss das
 *  Gewicht oder der Kursivschnitt, ist das kein Ablehnungsgrund: der Renderer
 *  faellt zurueck und meldet es als `meta.fontFallbacks`. So sperrt die
 *  Pruefung kein bestehendes Profil aus.
 *  Rueckgabe: `null` (alles erlaubt) oder `{ role, family, weight }` der ersten
 *  Rolle mit unbekannter Familie (`weight` fuer den bestehenden UI-Text). */
function findDisallowedFont(font) {
  if (!font || typeof font !== 'object') return null;
  for (const [role, f] of Object.entries(font)) {
    if (!f || typeof f !== 'object' || !('family' in f)) continue;
    if (!FONT_INDEX.has(f.family)) return { role, family: f.family, weight: f.weight || 400 };
  }
  return null;
}

async function _fetchTtfFromGoogle(family, weight, style, { fetchImpl, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = _buildCssUrl(family, weight, style);
  const cssRes = await fetchWithTimeout(url, { headers: { 'User-Agent': UA_FOR_TTF, 'Accept': 'text/css' } },
    timeoutMs, { fetchImpl });
  if (!cssRes.ok) throw new Error(`google-fonts-css ${cssRes.status}`);
  const css = (await readCapped(cssRes, CSS_MAX_BYTES)).toString('utf8');
  // Suche `src: url(...) format('truetype')`
  const ttfMatch = css.match(/url\(([^)]+\.ttf)\)/i);
  if (!ttfMatch) throw new Error('no-ttf-url');
  const ttfUrl = ttfMatch[1];
  if (!/^https:\/\/fonts\.gstatic\.com\//.test(ttfUrl)) throw new Error('unexpected-ttf-host');
  const ttfRes = await fetchWithTimeout(ttfUrl, {}, timeoutMs, { fetchImpl });
  if (!ttfRes.ok) throw new Error(`google-fonts-ttf ${ttfRes.status}`);
  return readCapped(ttfRes, TTF_MAX_BYTES);
}

/** User-sichtbarer Fehler als i18n-Key; die technische Ursache steht in
 *  `cause` (und im Log), nicht in der Job-Meldung. */
function _unavailable(family, cause) {
  const e = new Error('job.error.fontUnavailable');
  e.i18nParams = { family };
  e.code = 'FONT_UNAVAILABLE';
  e.cause = cause;
  return e;
}

// In-flight-Dedup: rendern mehrere Rollen/Jobs gleichzeitig dieselbe
// (family, weight, style), geht nur EIN Request raus.
const _inflight = new Map();

/**
 * Liefert TTF-Buffer für (family, weight, style). Cache zuerst, dann Network.
 * Bei Network-Fehler mit stale-Cache wird der stale-Buffer geliefert (Render
 * läuft durch, Job-Log warnt).
 *
 * Wirft bei nicht-whitelisted Eingaben oder leerem Cache + Network-Fehler —
 * jeweils mit i18n-Key als Message (`job.error.fontNotAllowed` /
 * `job.error.fontUnavailable`, Param `family`).
 * `opts.fetchImpl`/`opts.timeoutMs` sind Test-Hooks.
 */
async function fetchFont(family, weight, style = 'normal', opts = {}) {
  if (!isAllowed(family, weight, style)) {
    const e = new Error('job.error.fontNotAllowed');
    e.i18nParams = { family: String(family) };
    e.code = 'FONT_NOT_ALLOWED';
    throw e;
  }
  const cached = getCachedFont(family, weight, style);
  if (cached && !cached.stale) return cached.ttf;

  const key = `${family}|${parseInt(weight)}|${style}`;
  let p = _inflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const buf = await _fetchTtfFromGoogle(family, weight, style, opts);
        cacheFont(family, weight, style, buf);
        return buf;
      } finally {
        _inflight.delete(key);
      }
    })();
    _inflight.set(key, p);
  }

  try {
    return await p;
  } catch (e) {
    if (cached) {
      logger.warn(`font-fetch failed for ${family} ${weight} ${style} (${e.message}); serving stale cache`);
      return cached.ttf;
    }
    logger.warn(`font-fetch failed for ${family} ${weight} ${style}: ${e.message}`);
    throw _unavailable(family, e);
  }
}

module.exports = { listFonts, isAllowed, findDisallowedFont, fetchFont, FONT_LIST, FETCH_TIMEOUT_MS };
