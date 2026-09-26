#!/usr/bin/env node
'use strict';
// Stop-Hook: faehrt am Turn-Ende `npm run test:unit` als lokales Gate, damit die
// drift-/invarianten-gateten Unit-Tests (sw-manifest-drift, squash-drift,
// erd-drift, loc-limits, dedup-tripwire, page-stats-normalization, escape-xss …)
// rot werden, BEVOR committet/gepusht wird — nicht erst in CI.
//
// Nur wenn der Working Tree Aenderungen hat (git status --porcelain nicht leer) —
// reine Konversations-Turns ohne Code-Change laufen nicht durch die Suite.
// Test-Suite gruen → Exit 0, still. Rot → EINMAL `{"decision":"block"}` auf
// stdout: der Agent bekommt die Endzeilen als Grund und muss reagieren, statt
// den Turn mit rotem Tree zu beenden. stderr bei Exit 0 sieht niemand — weder
// Agent noch User —, der Hinweis waere wirkungslos.
//
// Genau einmal pro Stop-Kette: beim folgenden Stop ist `stop_hook_active` true
// und der Hook laesst durch. Das haelt den Fall aus, dass mehrere parallele
// Sessions einen Checkout teilen und das Rot von einer ANDEREN stammt — die
// blockierte Session prueft, meldet "Fremd-Drift" und darf dann stoppen, statt
// in einer Endlosschleife festzuhaengen. Verbindliches Gate bleibt CI.
// test:unit ist parallel + browserlos (Sekunden), kein E2E/Smoke; der Timeout
// verhindert, dass ein haengender Test den Turn-Abschluss blockiert.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_TIMEOUT_MS = 180000;

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

  const res = spawnSync('npm', ['run', 'test:unit'], {
    cwd: ROOT, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status === 0) process.exit(0); // gruen → still stoppen

  const out = ((res.stdout || '') + '\n' + (res.stderr || '')).trim();
  // Kompakte, aussagekraeftige Endzeilen zurueckgeben (volle Ausgabe waere zu lang).
  const tail = out.split('\n').slice(-40).join('\n');
  const why = res.error && res.error.code === 'ETIMEDOUT'
    ? `npm run test:unit nach ${TEST_TIMEOUT_MS / 1000} s abgebrochen (haengt ein Test?)`
    : 'npm run test:unit ist ROT';
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `[stop-gate] ${why}. Pruefe, ob das Rot zu DEINER Arbeit gehoert, und behebe es; `
      + 'stammt es erkennbar aus einer parallelen Session (Fremd-Drift), sag das und beende den Turn. '
      + 'Endzeilen:\n' + tail,
  }) + '\n');
  process.exit(0);
});
