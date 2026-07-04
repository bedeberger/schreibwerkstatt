'use strict';
// Bild-Loader fuer PDF-Render. Loest Manuskript-Bilder (/content/page-image/:id)
// aus der DB und absolute http(s)-URLs per fetch auf, normalisiert beide via
// sharp (sRGB, kein Alpha, JPEG q85) zu PDF/A-tauglichem Buffer. imageCache
// verhindert Doppel-Fetch + Doppel-Decode bei mehrfach referenzierten Bildern.

const sharp = require('sharp');
const logger = require('../../logger');

const PAGE_IMAGE_RE = /^\/content\/page-image\/(\d+)/;

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

async function _fetchImage(src, _token, imageCache) {
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
    const r = await fetch(src);
    if (!r.ok) { imageCache?.set(src, null); return null; }
    const ab = await r.arrayBuffer();
    return await _normalize(Buffer.from(ab), src, imageCache);
  } catch (e) {
    logger.warn(`pdf-render: image fetch failed for ${src} (${e.message})`);
    imageCache?.set(src, null);
    return null;
  }
}

module.exports = { _fetchImage };
