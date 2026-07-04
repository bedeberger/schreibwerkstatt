'use strict';
// Normalisiert einen User-Upload-Buffer zu einem sicheren, ueberall einbettbaren
// Manuskript-Bild:
//  - Magic-Bytes-Check vor sharp (kein beliebiger BLOB an libvips)
//  - EXIF-Rotation anwenden + Metadaten strippen (Privacy + kleinere Datei)
//  - sRGB
//  - Ausgabe JPEG (Fotos) bzw. PNG (falls Transparenz) — nur diese zwei Formate
//    betten pdfkit (PDF), docx (Word) UND data:-URIs (EPUB) zuverlaessig ein.
//  - max. 2000 px Laengsseite (Druck bei ~200 dpi auf Buchseite reicht)
//
// Wirft bei korrupten Eingaben oder unsupported Formaten. Vorbild: cover-prepare.js.

const sharp = require('sharp');
const { detectMime } = require('./cover-prepare');

const MAX_INPUT_BYTES   = 15 * 1024 * 1024;
const MAX_OUTPUT_PIXELS = 2000;
const JPEG_QUALITY      = 85;

/**
 * @param {Buffer} input  Upload-Buffer
 * @returns {Promise<{ buffer: Buffer, mime: 'image/jpeg'|'image/png', width: number, height: number }>}
 */
async function preparePageImage(input) {
  if (!Buffer.isBuffer(input)) throw new Error('image-not-buffer');
  if (input.length === 0) throw new Error('image-empty');
  if (input.length > MAX_INPUT_BYTES) throw new Error('image-too-large');

  const mime = detectMime(input);
  if (!mime) throw new Error('image-unsupported-format');

  const img = sharp(input, { failOn: 'error' });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('image-no-dimensions');

  const keepAlpha = !!meta.hasAlpha;
  const pipeline = img.rotate().toColorspace('srgb');
  if (!keepAlpha) pipeline.flatten({ background: '#ffffff' });

  const longest = Math.max(meta.width, meta.height);
  if (longest > MAX_OUTPUT_PIXELS) {
    pipeline.resize({
      width:  meta.width  >= meta.height ? MAX_OUTPUT_PIXELS : null,
      height: meta.height >  meta.width  ? MAX_OUTPUT_PIXELS : null,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const encoded = keepAlpha
    ? pipeline.png({ compressionLevel: 9 })
    : pipeline.jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:2:0', mozjpeg: false });

  // withMetadata NICHT setzen → EXIF/GPS werden gestrippt (Privacy).
  const out = await encoded.toBuffer({ resolveWithObject: true });

  return {
    buffer: out.data,
    mime: keepAlpha ? 'image/png' : 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
  };
}

module.exports = { preparePageImage, MAX_INPUT_BYTES };
