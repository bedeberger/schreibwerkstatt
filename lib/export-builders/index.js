'use strict';
// Facade. Liefert eine Format-Map mit { mime, build }-Eintragen pro Format.
// `build` ist immer eine async-Funktion, die einen Buffer liefert. Caller in
// routes/export.js und routes/jobs/pdf-export.js wahlen ueber den Format-Key.

const { buildPdf }  = require('./pdf');
const { buildHtml } = require('./html');
const { buildTxt }  = require('./txt');
const { buildMd }   = require('./md');
const { buildEpub } = require('./epub');
const { buildSubstack } = require('./substack');
const { buildDocx, buildDocxNormseite } = require('./docx');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// `ext` ueberschreibt den Format-Key als Dateiendung (Caller: routes/export.js,
// routes/snapshots.js) — noetig fuer Varianten-Keys wie 'docx-normseite', die
// dieselbe .docx-Endung tragen.
const FORMATS = {
  pdf:  { mime: 'application/pdf',              build: buildPdf,  bom: false },
  html: { mime: 'text/html; charset=utf-8',     build: buildHtml, bom: false },
  txt:  { mime: 'text/plain; charset=utf-8',    build: buildTxt,  bom: true  },
  md:   { mime: 'text/markdown; charset=utf-8', build: buildMd,   bom: true  },
  substack: { mime: 'text/html; charset=utf-8', build: buildSubstack, bom: false, ext: 'html' },
  epub: { mime: 'application/epub+zip',         build: buildEpub, bom: false },
  docx: { mime: DOCX_MIME,                      build: buildDocx, bom: false },
  'docx-normseite': { mime: DOCX_MIME,          build: buildDocxNormseite, bom: false, ext: 'docx' },
};

module.exports = { FORMATS, buildPdf, buildHtml, buildTxt, buildMd, buildSubstack, buildEpub, buildDocx, buildDocxNormseite };
