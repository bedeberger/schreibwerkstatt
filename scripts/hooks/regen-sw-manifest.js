#!/usr/bin/env node
'use strict';
// PostToolUse-Hook (Edit|Write|MultiEdit): regeneriert public/sw-manifest.js,
// sobald ein Shell-Kohärenz-Asset bearbeitet wurde — so driftet die
// content-hash-getriebene SHELL_CACHE-Generation nie vom Working Tree weg und
// der sw-manifest-drift-Test bleibt grün. Der geprüfte Asset-Satz spiegelt
// exakt scripts/sw-manifest.js (partials/*.html, js/**.{js,mjs,json},
// css/**.css, icons.svg, index.html). Backend-/Test-/Doku-Edits werden
// übersprungen — sie verschieben den Hash nicht. No-op + still bei Nicht-Assets.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let fp = '';
  try {
    fp = (JSON.parse(raw || '{}').tool_input || {}).file_path || '';
  } catch {
    process.exit(0); // unlesbares Payload → nichts tun
  }
  if (!fp) process.exit(0);

  const p = fp.split(path.sep).join('/');
  const isShellAsset =
    /\/public\/partials\/.+\.html$/.test(p) ||
    /\/public\/js\/.+\.(?:js|mjs|json)$/.test(p) ||
    /\/public\/css\/.+\.css$/.test(p) ||
    /\/public\/icons\.svg$/.test(p) ||
    /\/public\/index\.html$/.test(p);
  if (!isShellAsset) process.exit(0);

  const root = path.resolve(__dirname, '..', '..');
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'sw-manifest.js')], {
    cwd: root,
    encoding: 'utf8',
  });
  const out = (res.stdout || '').trim();
  if (out) console.log(out); // im Transcript sichtbar, harmlos bei Exit 0
  process.exit(0);
});
