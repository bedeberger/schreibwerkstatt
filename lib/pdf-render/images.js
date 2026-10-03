'use strict';
// Bild-Loader fuer PDF-Render. Loest Manuskript-Bilder (/content/page-image/:id)
// aus der DB, data:-URIs und absolute http(s)-URLs auf und normalisiert alle via
// sharp zu einem PDF/A-tauglichen Buffer (sRGB, kein Alpha). imageCache
// verhindert Doppel-Fetch + Doppel-Decode bei mehrfach referenzierten Bildern.
//
// Drei Regeln, die hier gelten und nirgends sonst:
//   • BUCH-SCOPE. Ein /content/page-image/:id gehoert zu genau einem Buch. Die ID
//     steht im Manuskript-HTML und ist damit user-kontrolliert — ohne Abgleich
//     koennte jeder, der eine Seite schreiben darf, die Bilder fremder Buecher
//     per PDF-Export auslesen. Fremdes Bild ⇒ wie fehlend behandeln + Warnung.
//   • DECKEL VOR DEM DECODE. sharp bekommt `limitInputPixels` (Dekompressions-
//     bombe), eine data:-URI wird vor dem base64-Decode an ihrer Laenge gemessen.
//   • ZIELAUFLOESUNG. Mehr als ~300 dpi bezogen auf die groesste druckbare
//     Breite (Satzspiegel) sieht niemand, kostet aber PDF-Groesse und Speicher —
//     darum wird heruntergerechnet, nie hochgerechnet. Strichzeichnungen und
//     Grafiken (PNG/GIF/SVG-Quelle mit wenigen Farben, z. B. Mermaid-Diagramme)
//     bleiben verlustfrei PNG — JPEG verschmiert Kanten und Schrift; Fotos
//     werden JPEG q88.

const sharp = require('sharp');
const logger = require('../../logger');
const { safeFetch } = require('../ssrf-guard');

const PAGE_IMAGE_RE = /^\/content\/page-image\/(\d+)/;

// Grenzen des Remote-Zweigs. Die URL stammt aus dem `src` eines <img> im
// Manuskript-HTML und ist damit vollstaendig user-kontrolliert:
//   • assertPublicUrl pro Hop  → kein Zugriff auf loopback/private/link-local
//   • Timeout                  → ein haengendes Ziel blockiert den Job nicht
//   • Byte-Deckel              → keine Antwort beliebiger Groesse im Heap
const FETCH_TIMEOUT_MS  = 10_000;
const MAX_REMOTE_BYTES  = 20 * 1024 * 1024;
const MAX_REDIRECTS     = 3;
// Decode-Deckel: 50 Megapixel reichen fuer jedes Druckbild (A4 bei 600 dpi
// sind ~35 MP) und halten eine Dekompressionsbombe vom Speicher fern.
const MAX_INPUT_PIXELS  = 50e6;
// data:-URIs: dekodierte Groesse, ab der das Bild verworfen wird.
const MAX_DATA_URI_BYTES = 20 * 1024 * 1024;

// Zielaufloesung und Mindestaufloesung fuer die natuerliche Groesse (siehe
// blocks: ein Bild ohne/mit niedriger dpi-Angabe wird nie groesser gedruckt als
// bei 150 dpi — darunter wird es sichtbar pixelig).
const TARGET_DPI = 300;
const MIN_PRINT_DPI = 150;
const JPEG_QUALITY = 88;
// Entropie (bit/Pixel, sharp stats) unter der ein PNG/GIF-Bild als Grafik gilt.
// Fotos liegen typisch bei 6.5–7.8, Diagramme/Screenshots mit Flaechen unter 5.
const LINE_ART_ENTROPY = 5.5;

const SHARP_OPTS = { limitInputPixels: MAX_INPUT_PIXELS };

/** Normalisieren: drehen, Alpha auf Weiss, sRGB, auf Zielaufloesung begrenzen,
 *  PNG (Grafik) oder JPEG (Foto). Liefert neben dem Buffer die Masse des
 *  ERGEBNISSES (`width`/`height`), die der Quelle (`srcWidth`/`srcHeight`, fuer
 *  die dpi-Warnung) und die natuerliche Druckbreite in pt. */
async function _normalize(input, opts = {}) {
  const meta = await sharp(input, SHARP_OPTS).metadata();
  // EXIF-Drehung: bei 5–8 sind Breite/Hoehe vertauscht.
  const swap = (meta.orientation || 1) >= 5;
  const srcWidth = swap ? meta.height : meta.width;
  const srcHeight = swap ? meta.width : meta.height;
  if (!srcWidth || !srcHeight) throw new Error('image without dimensions');
  const declaredDpi = Number.isFinite(meta.density) && meta.density > 0 ? meta.density : 0;
  const naturalWidthPt = srcWidth * 72 / Math.max(MIN_PRINT_DPI, declaredDpi);

  const fmt = String(meta.format || '').toLowerCase();
  let lossless = false;
  if (fmt === 'png' || fmt === 'gif' || fmt === 'svg') {
    try {
      const st = await sharp(input, SHARP_OPTS).stats();
      lossless = !(Number.isFinite(st.entropy) && st.entropy >= LINE_ART_ENTROPY);
    } catch { lossless = true; }
  }

  let pipe = sharp(input, SHARP_OPTS).rotate();
  const maxW = Number.isFinite(opts.maxWidthPx) && opts.maxWidthPx > 0 ? Math.round(opts.maxWidthPx) : null;
  const maxH = Number.isFinite(opts.maxHeightPx) && opts.maxHeightPx > 0 ? Math.round(opts.maxHeightPx) : null;
  if ((maxW && srcWidth > maxW) || (maxH && srcHeight > maxH)) {
    pipe = pipe.resize({ width: maxW || undefined, height: maxH || undefined, fit: 'inside', withoutEnlargement: true });
  }
  pipe = pipe.flatten({ background: '#ffffff' }).toColorspace('srgb');
  pipe = lossless
    ? pipe.png({ compressionLevel: 9, adaptiveFiltering: true })
    : pipe.jpeg({ quality: JPEG_QUALITY });
  const out = await pipe.withMetadata({ icc: 'srgb' }).toBuffer({ resolveWithObject: true });
  return {
    buffer: out.data,
    width: out.info.width,
    height: out.info.height,
    format: lossless ? 'png' : 'jpeg',
    srcWidth, srcHeight, naturalWidthPt,
  };
}

/**
 * Remote-Bild holen: SSRF-geprueft pro Redirect-Hop, mit Timeout und
 * Byte-Deckel (lib/ssrf-guard.js#safeFetch).
 *
 * Rueckgabe: Buffer, oder null bei nicht-OK-Antwort / Redirect ohne Ziel /
 * Redirect-Kette zu lang. Wirft bei geblocktem Ziel, Timeout und Ueberlaenge.
 */
async function _fetchRemote(src) {
  let out;
  try {
    out = await safeFetch(src, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_REMOTE_BYTES,
      maxRedirects: MAX_REDIRECTS,
      tooLargeCode: 'IMAGE_TOO_LARGE',
    });
  } catch (e) {
    if (e.code === 'FETCH_REDIRECT_LIMIT' || e.code === 'FETCH_REDIRECT_INVALID') return null;
    throw e;
  }
  return out.response.ok ? out.buffer : null;
}

/** Dekodierte Groesse einer base64-data:-URI, ohne sie zu dekodieren. */
function _dataUriBytes(src) {
  const comma = src.indexOf(',');
  if (comma < 0) return 0;
  const len = src.length - comma - 1;
  return Math.floor(len * 3 / 4);
}

/**
 * @param {string} src
 * @param {Map}    [imageCache]
 * @param {object} [opts]
 * @param {number} [opts.bookId]      Buch des Exports — Manuskript-Bilder anderer
 *                                    Buecher werden wie fehlende behandelt.
 * @param {number} [opts.maxWidthPx]  Zielbreite (300 dpi auf die Satzspiegelbreite)
 * @param {number} [opts.maxHeightPx] Zielhoehe (300 dpi auf die Satzspiegelhoehe)
 */
async function _fetchImage(src, imageCache, opts = {}) {
  if (imageCache?.has(src)) return imageCache.get(src);
  const remember = (v) => { imageCache?.set(src, v); return v; };

  // Manuskript-Bild aus der lokalen DB (kein HTTP-Roundtrip, kein Token noetig).
  const m = PAGE_IMAGE_RE.exec(src || '');
  if (m) {
    try {
      const { getPageImage } = require('../../db/page-images');
      const row = getPageImage(parseInt(m[1], 10));
      if (!row || !row.image) return remember(null);
      const bookId = Number(opts.bookId);
      if (!Number.isInteger(bookId) || bookId <= 0 || Number(row.book_id) !== bookId) {
        logger.warn(`pdf-render: page-image ${m[1]} gehoert nicht zum exportierten Buch (book=${opts.bookId ?? '-'}) — uebersprungen`);
        return remember(null);
      }
      return remember(await _normalize(row.image, opts));
    } catch (e) {
      logger.warn(`pdf-render: page-image lookup failed for ${src} (${e.message})`);
      return remember(null);
    }
  }

  // data:-URI (Diagramme, Fassungs-Export mit eingebetteten Snapshot-Bildern).
  // Gecacht wie jedes andere Bild: der Map-Schluessel ist eine Referenz auf den
  // ohnehin vorhandenen String, keine Kopie.
  if (/^data:image\//i.test(src)) {
    if (_dataUriBytes(src) > MAX_DATA_URI_BYTES) {
      logger.warn(`pdf-render: data-URI zu gross (>${MAX_DATA_URI_BYTES} Bytes) — uebersprungen`);
      return remember(null);
    }
    try {
      const buf = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
      return remember(await _normalize(buf, opts));
    } catch (e) {
      logger.warn(`pdf-render: data-URI decode failed (${e.message})`);
      return remember(null);
    }
  }

  if (!/^https?:\/\//i.test(src)) return remember(null);
  try {
    const buf = await _fetchRemote(src);
    if (!buf) return remember(null);
    return remember(await _normalize(buf, opts));
  } catch (e) {
    // SSRF_BLOCKED_HOST / SSRF_DNS_FAILED landen hier wie jeder Netzfehler:
    // ein unerreichbares Bild darf den Export nicht abbrechen. `e.code` mitloggen,
    // sonst ist ein geblockter Host nicht von einem echten Ausfall zu trennen.
    const code = e.code ? ` [${e.code}]` : '';
    logger.warn(`pdf-render: image fetch failed for ${src}${code} (${e.message})`);
    return remember(null);
  }
}

module.exports = {
  _fetchImage, _normalize, MAX_REMOTE_BYTES, FETCH_TIMEOUT_MS, MAX_REDIRECTS,
  MAX_INPUT_PIXELS, MAX_DATA_URI_BYTES, TARGET_DPI, MIN_PRINT_DPI,
};
