'use strict';
// App-Version — Single Source of Truth ist die Datei VERSION im Projektroot.
// Wird vor jedem Commit von Hand gepflegt. package.json#version wird NICHT mehr
// gelesen (npm-Metadatum, fuer die self-hosted App ohne Belang).
// Einmalig beim Modul-Load eingelesen; Aenderung wird beim naechsten Start aktiv.

const fs = require('fs');
const path = require('path');

let _version = '0.0.0';
try {
  _version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || '0.0.0';
} catch (_) { /* Datei fehlt → Fallback */ }

function getVersion() {
  return _version;
}

module.exports = { getVersion };
