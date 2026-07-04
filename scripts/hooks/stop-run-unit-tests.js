#!/usr/bin/env node
'use strict';
// Stop-Hook: faehrt am Turn-Ende `npm run test:unit` als lokales Gate, damit die
// drift-/invarianten-gateten Unit-Tests (sw-manifest-drift, squash-drift,
// erd-drift, loc-limits, dedup-tripwire, page-stats-normalization, escape-xss …)
// rot werden, BEVOR committet/gepusht wird — nicht erst in CI.
//
// Nur wenn der Working Tree Aenderungen hat (git status --porcelain nicht leer) —
// reine Konversations-Turns ohne Code-Change laufen nicht durch die Suite.
// Test-Suite gruen → Exit 0, still. Rot → Warnung auf stderr, aber Exit 0
// (NON-BLOCKING): mehrere parallele Sessions teilen einen Checkout, ein
// blockierender Gate wuerde eine Session fuer Fremd-Drift einer anderen sperren.
// Verbindliches Gate ist CI; hier nur Frueh-Hinweis. test:unit ist parallel +
// browserlos (wenige Sekunden), kein E2E/Smoke.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  // stop_hook_active === true: wir haengen bereits in einer Stop-Hook-getriebenen
  // Fortsetzung → nicht erneut blocken (Endlosschleifen-Schutz laut Hook-Vertrag).
  try {
    if (JSON.parse(raw || '{}').stop_hook_active) process.exit(0);
  } catch { /* kein/kaputtes JSON → normal weiter */ }

  // Nur bei Working-Tree-Aenderungen testen.
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (status.status === 0 && !status.stdout.trim()) process.exit(0); // sauberer Tree → nichts zu pruefen

  const res = spawnSync('npm', ['run', 'test:unit'], { cwd: ROOT, encoding: 'utf8' });
  if (res.status === 0) process.exit(0); // gruen → still stoppen

  const out = ((res.stdout || '') + '\n' + (res.stderr || '')).trim();
  // Kompakte, aussagekraeftige Endzeilen zurueckgeben (volle Ausgabe waere zu lang).
  const tail = out.split('\n').slice(-40).join('\n');
  // Non-blocking: nur WARNEN, nicht stoppen (Exit 0). Bei mehreren parallelen
  // Sessions im selben Checkout wuerde ein blockierender Gate (Exit 2) eine Session
  // fuer das rote Rot einer ANDEREN Session sperren (Kreuz-Kontamination). CI bleibt
  // das echte, verbindliche Netz; hier reicht der Hinweis, um eigenes Rot frueh zu sehen.
  process.stderr.write(
    '[stop-gate] WARNUNG: npm run test:unit ist ROT — checke, ob es zu DEINER Arbeit gehoert '
    + '(bei Parallel-Sessions oft Fremd-Drift). CI ist das verbindliche Gate:\n' + tail + '\n',
  );
  process.exit(0);
});
