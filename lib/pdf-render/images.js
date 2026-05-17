'use strict';
// Bild-Loader fuer PDF-Render. Fetcht absolute http(s)-URLs, normalisiert via
// sharp (sRGB, kein Alpha, JPEG q85) zu PDF/A-tauglichem Buffer. imageCache
// verhindert Doppel-Fetch + Doppel-Decode bei mehrfach referenzierten Bildern.

const sharp = require('sharp');
const logger = require('../../logger');

async function _fetchImage(src, _token, imageCache) {
  if (imageCache?.has(src)) return imageCache.get(src);
  if (!/^https?:\/\//i.test(src)) {
    imageCache?.set(src, null);
    return null;
  }
  try {
    const r = await fetch(src);
    if (!r.ok) { imageCache?.set(src, null); return null; }
    const ab = await r.arrayBuffer();
    const out = await sharp(Buffer.from(ab))
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColorspace('srgb')
      .jpeg({ quality: 85 })
      .withMetadata({ icc: 'srgb' })
      .toBuffer({ resolveWithObject: true });
    const result = { buffer: out.data, width: out.info.width, height: out.info.height };
    imageCache?.set(src, result);
    return result;
  } catch (e) {
    logger.warn(`pdf-render: image fetch failed for ${src} (${e.message})`);
    imageCache?.set(src, null);
    return null;
  }
}

module.exports = { _fetchImage };
