#!/usr/bin/env node
'use strict';
// PostToolUse-Hook (Edit|Write|MultiEdit): erinnert an die drift-gateten
// Folge-Artefakte, die laut CLAUDE.md im selben Commit mitgepflegt werden
// muessen — sonst wird der zugehoerige Drift-Test in CI rot bzw. eine Metrik
// erscheint nie in Home Assistant. Reine Reminder (kein Auto-Regen), weil
// squash:regen bei Recreate-Migrationen FORCE_LEGACY_MIGRATIONS=1 braucht und
// docs/erd.md + die HA-Configs handgepflegt sind. No-op + still bei anderen
// Dateien.

const path = require('node:path');

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

  const p = fp.split(path.sep).join('/');
  const reminders = [];

  if (/\/db\/migrations\.js$/.test(p)) {
    reminders.push(
      'db/migrations.js bearbeitet → vor dem Commit:',
      '  • npm run squash:regen  (Recreate-Migration? dann FORCE_LEGACY_MIGRATIONS=1 npm run squash:regen) — sonst squash-drift.test rot',
      '  • docs/erd.md aktualisieren (Stand-Zeile: Schema-Version + Tabellen-Anzahl, betroffene Bloecke/FK-Kanten) — sonst erd-drift.test rot',
    );
  } else if (/\/db\/squashed-schema\.js$/.test(p)) {
    reminders.push(
      'db/squashed-schema.js bearbeitet → docs/erd.md im selben Commit aktualisieren (sonst erd-drift.test rot).',
    );
  }

  if (/\/lib\/metrics-collector\.js$/.test(p)) {
    reminders.push(
      'lib/metrics-collector.js bearbeitet → bei neuer /metrics-Kennzahl im selben Commit ergaenzen:',
      '  • docs/homeassistant/configuration.yaml (REST-Sensor + ggf. abgeleiteter template:-Sensor)',
      '  • docs/homeassistant/dashboard.yaml (Dashboard-Kachel)',
      '  • docs/homeassistant/README.md (Sensor-Uebersicht)',
    );
  }

  if (reminders.length) {
    console.log('[drift-reminder] ' + reminders.join('\n'));
  }
  process.exit(0);
});
