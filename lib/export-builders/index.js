'use strict';
// Facade. Liefert eine Format-Map mit { mime, build }-Eintragen pro Format.
// `build` ist immer eine async-Funktion, die einen Buffer liefert. Caller in
// routes/export.js und routes/jobs/pdf-export.js wahlen ueber den Format-Key.

const { buildPdf }  = require('./pdf');
const { buildHtml } = require('./html');
const { buildTxt }  = require('./txt');
const { buildMd }   = require('./md');
const { buildEpub } = require('./epub');
const { buildDocx } = require('./docx');

const FORMATS = {
  pdf:  { mime: 'application/pdf',                                                                            build: buildPdf,  bom: false },
  html: { mime: 'text/html; charset=utf-8',                                                                  build: buildHtml, bom: false },
  txt:  { mime: 'text/plain; charset=utf-8',                                                                 build: buildTxt,  bom: true  },
  md:   { mime: 'text/markdown; charset=utf-8',                                                              build: buildMd,   bom: true  },
  epub: { mime: 'application/epub+zip',                                                                      build: buildEpub, bom: false },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',                   build: buildDocx, bom: false },
};

module.exports = { FORMATS, buildPdf, buildHtml, buildTxt, buildMd, buildEpub, buildDocx };
