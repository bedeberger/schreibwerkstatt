#!/usr/bin/env node
'use strict';
// PostToolUse-Hook (Edit|Write|MultiEdit): warnt sofort, wenn eine gerade
// bearbeitete Datei den Kategorie-LOC-Cap aus CLAUDE.md („File-Limits /
// Modularitaet") reisst — bevor loc-limits.test.mjs in CI rot wird.
//   • public/js/**.js       → Cap 600
//   • public/partials/*.html → Cap 250
//   • public/css/**.css      → Cap 600
// Grandfathering: die gepinnten Ceilings der Altlasten werden LIVE aus
// tests/unit/loc-limits.test.mjs geparst (einzige Quelle, kein Drift). Eine
// allowlisted Datei warnt nur, wenn sie ueber ihr Ceiling waechst (Ratsche).
// Reiner Warner (kein Block), still bei Nicht-Assets / innerhalb der Limits.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// LOC == physische Zeilen, deckungsgleich mit `wc -l` (Schluss-Newline abziehen).
// Muss mit loc() in loc-limits.test.mjs uebereinstimmen.
function loc(src) {
  if (src === '') return 0;
  const n = src.split('\n').length;
  return src.endsWith('\n') ? n - 1 : n;
}

// Gepinnte Altlast-Ceilings aus dem Test ziehen — Set-Gleichheit mit der Ratsche.
function loadCeilings() {
  const map = new Map();
  try {
    const test = fs.readFileSync(path.join(ROOT, 'tests', 'unit', 'loc-limits.test.mjs'), 'utf8');
    const re = /'(public\/[^']+)':\s*(\d+)/g;
    let m;
    while ((m = re.exec(test))) map.set(m[1], Number(m[2]));
  } catch { /* Test fehlt → nur Caps pruefen */ }
  return map;
}

function category(rel) {
  if (/^public\/js\/.+\.js$/.test(rel)) return { label: 'JS-Modul', cap: 600 };
  if (/^public\/partials\/[^/]+\.html$/.test(rel)) return { label: 'HTML-Partial', cap: 250 };
  if (/^public\/css\/.+\.css$/.test(rel)) return { label: 'CSS-File', cap: 600 };
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let fp = '';
  try {
    fp = (JSON.parse(raw || '{}').tool_input || {}).file_path || '';
  } catch {
    process.exit(0);
  }
  if (!fp) process.exit(0);

  const abs = path.resolve(fp);
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const cat = category(rel);
  if (!cat) process.exit(0);

  let n;
  try {
    n = loc(fs.readFileSync(abs, 'utf8'));
  } catch {
    process.exit(0); // Datei (noch) nicht lesbar → still
  }

  const ceilings = loadCeilings();
  const msgs = [];

  if (ceilings.has(rel)) {
    const ceiling = ceilings.get(rel);
    if (n > ceiling) {
      msgs.push(
        `${rel}: ${n} LOC > gepinntes Ceiling ${ceiling} (${cat.label}-Altlast) — darf nur schrumpfen.`,
        '  Datei splitten (Allowlist-Eintrag in loc-limits.test.mjs dann streichen) oder kuerzen — sonst loc-limits.test rot.',
      );
    }
  } else if (n > cat.cap) {
    msgs.push(
      `${rel}: ${n} LOC > ${cat.cap}-Cap (${cat.label}) — in <name>/-Subfolder splitten`,
      '  (Facade-File re-exportiert Sub-Module; siehe CLAUDE.md „File-Limits / Modularitaet") — sonst loc-limits.test rot.',
    );
  }

  if (msgs.length) console.log('[loc-limit] ' + msgs.join('\n'));
  process.exit(0);
});
