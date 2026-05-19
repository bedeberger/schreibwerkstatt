'use strict';

// Extension-Dispatch fuer Folder-Import. Liefert { html, warnings } oder
// null wenn die Datei nicht supported ist (Caller sammelt skips).

const { parseDocx } = require('./docx');
const { parseOdt } = require('./odt');
const { parseAbw } = require('./abw');

const SUPPORTED_EXTS = new Set(['docx', 'odt', 'abw']);

function extOf(name) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

async function parseImportFile(filename, buffer) {
  const ext = extOf(filename);
  if (ext === 'docx') return parseDocx(buffer);
  if (ext === 'odt')  return parseOdt(buffer);
  if (ext === 'abw')  return parseAbw(buffer);
  return null;
}

module.exports = { parseImportFile, extOf, SUPPORTED_EXTS };
