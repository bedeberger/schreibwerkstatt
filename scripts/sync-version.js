'use strict';
// Synchronisiert package.json#version aus der SSoT-Datei VERSION (Projektroot).
// VERSION wird vor jedem Commit von Hand gepflegt; package.json folgt automatisch
// (laeuft als `prestart` vor `npm start`). Schreibt nur, wenn sich der Wert
// unterscheidet — idempotent, keine unnoetigen Diffs.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const versionFile = path.join(root, 'VERSION');
const pkgFile = path.join(root, 'package.json');

const version = fs.readFileSync(versionFile, 'utf8').trim();
if (!version) {
  console.error('sync-version: VERSION ist leer — abgebrochen.');
  process.exit(1);
}

const raw = fs.readFileSync(pkgFile, 'utf8');
const pkg = JSON.parse(raw);
if (pkg.version === version) {
  console.log(`sync-version: package.json bereits auf ${version}.`);
  process.exit(0);
}

pkg.version = version;
// Trailing-Newline des Originals erhalten.
const out = JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : '');
fs.writeFileSync(pkgFile, out);
console.log(`sync-version: package.json auf ${version} gesetzt.`);
