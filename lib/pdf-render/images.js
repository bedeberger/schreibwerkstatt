'use strict';
// Bild-Loader: zieht via Server-Token aus BookStack, normalisiert via sharp
// (sRGB, kein Alpha, JPEG q85) zu PDF/A-tauglichem Buffer. imageCache verhindert
// Doppel-Fetch + Doppel-Decode bei mehrfach referenzierten Bildern.

const sharp = require('sharp');
const { BOOKSTACK_URL, authHeader } = require('../bookstack');
const logger = require('../../logger');

async function _fetchImage(src, token, imageCache) {
  if (imageCache?.has(src)) return imageCache.get(src);
  let url = src;
  if (src.startsWith('/')) url = `${BOOKSTACK_URL}${src}`;
  if (!/^https?:\/\//i.test(url)) {
    imageCache?.set(src, null);
    return null;
  }
  try {
    const headers = {};
    if (token && url.startsWith(BOOKSTACK_URL)) headers['Authorization'] = authHeader(token);
    const r = await fetch(url, { headers });
    if (!r.ok) { imageCache?.set(src, null); return null; }
    const ab = await r.arrayBuffer();
    // sharp normalisiert: kein Alpha, sRGB, JPEG (PDF/A-tauglich)
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
