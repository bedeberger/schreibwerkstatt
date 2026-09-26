'use strict';
// Bild-Loader fuer PDF-Render. Loest Manuskript-Bilder (/content/page-image/:id)
// aus der DB und absolute http(s)-URLs per fetch auf, normalisiert beide via
// sharp (sRGB, kein Alpha, JPEG q85) zu PDF/A-tauglichem Buffer. imageCache
// verhindert Doppel-Fetch + Doppel-Decode bei mehrfach referenzierten Bildern.

const sharp = require('sharp');
const logger = require('../../logger');
const { safeFetch } = require('../ssrf-guard');

const PAGE_IMAGE_RE = /^\/content\/page-image\/(\d+)/;

// Grenzen des Remote-Zweigs. Die URL stammt aus dem `src` eines <img> im
// Manuskript-HTML und ist damit vollstaendig user-kontrolliert — jeder, der eine
// Seite schreiben darf, bestimmt hier das Ziel eines serverseitigen Requests.
// Darum drei Deckel, die es vorher nicht gab:
//   • assertPublicUrl pro Hop  → kein Zugriff auf loopback/private/link-local
//     Adressen (interne Dienste, Cloud-Metadaten). Ohne das ist der PDF-Export
//     ein SSRF-Werkzeug aus dem Inneren des Containers heraus.
//   • Timeout                  → ein Ziel, das die Verbindung offen haelt, wuerde
//     sonst den Render-Job blockieren (Node-fetch hat keinen Default-Timeout).
//   • Byte-Deckel              → eine Antwort beliebiger Groesse landete sonst
//     vollstaendig im Heap, bevor sharp sie ueberhaupt ansieht.
const FETCH_TIMEOUT_MS  = 10_000;
const MAX_REMOTE_BYTES  = 20 * 1024 * 1024;
const MAX_REDIRECTS     = 3;

async function _normalize(input, src, imageCache) {
  const out = await sharp(input)
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb')
    .jpeg({ quality: 85 })
    .withMetadata({ icc: 'srgb' })
    .toBuffer({ resolveWithObject: true });
  const result = { buffer: out.data, width: out.info.width, height: out.info.height };
  imageCache?.set(src, result);
  return result;
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

async function _fetchImage(src, imageCache) {
  if (imageCache?.has(src)) return imageCache.get(src);

  // Manuskript-Bild aus der lokalen DB (kein HTTP-Roundtrip, kein Token noetig).
  const m = PAGE_IMAGE_RE.exec(src || '');
  if (m) {
    try {
      const { getPageImage } = require('../../db/page-images');
      const row = getPageImage(parseInt(m[1], 10));
      if (!row || !row.image) { imageCache?.set(src, null); return null; }
      return await _normalize(row.image, src, imageCache);
    } catch (e) {
      logger.warn(`pdf-render: page-image lookup failed for ${src} (${e.message})`);
      imageCache?.set(src, null);
      return null;
    }
  }

  // data:-URI (z.B. Fassungs-Export, der eingebettete Snapshot-Bilder inlined).
  // Nicht cachen — der base64-Key waere riesig.
  if (/^data:image\//i.test(src)) {
    try {
      const buf = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
      const out = await sharp(buf)
        .rotate().flatten({ background: '#ffffff' }).toColorspace('srgb')
        .jpeg({ quality: 85 }).withMetadata({ icc: 'srgb' })
        .toBuffer({ resolveWithObject: true });
      return { buffer: out.data, width: out.info.width, height: out.info.height };
    } catch (e) {
      logger.warn(`pdf-render: data-URI decode failed (${e.message})`);
      return null;
    }
  }

  if (!/^https?:\/\//i.test(src)) {
    imageCache?.set(src, null);
    return null;
  }
  try {
    const buf = await _fetchRemote(src);
    if (!buf) { imageCache?.set(src, null); return null; }
    return await _normalize(buf, src, imageCache);
  } catch (e) {
    // SSRF_BLOCKED_HOST / SSRF_DNS_FAILED landen hier wie jeder Netzfehler:
    // ein unerreichbares Bild darf den Export nicht abbrechen. `e.code` mitloggen,
    // sonst ist ein geblockter Host nicht von einem echten Ausfall zu trennen.
    const code = e.code ? ` [${e.code}]` : '';
    logger.warn(`pdf-render: image fetch failed for ${src}${code} (${e.message})`);
    imageCache?.set(src, null);
    return null;
  }
}

module.exports = { _fetchImage, MAX_REMOTE_BYTES, FETCH_TIMEOUT_MS, MAX_REDIRECTS };
