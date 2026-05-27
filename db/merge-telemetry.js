'use strict';
// Block-Level-Merge-Telemetrie: globale, kumulierte Counter (lifetime).
// Geschrieben vom /telemetry-Endpoint, gelesen vom Prometheus-Collector
// (lib/metrics-collector.js). Name-gekeyt, keine Entity-Refs.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// Erlaubte Counter-Namen. Synchron mit routes/telemetry.js + Collector.
const COUNTER_NAMES = new Set([
  'silent_success',
  'conflict_shown',
  'conflict_resolved_local',
  'conflict_resolved_remote',
  'conflict_resolved_both',
  'fallback_overwrite',
]);

// Counter um delta (>=1) erhoehen. Unbekannte Namen werden ignoriert.
function bumpMergeCounter(name, delta = 1) {
  if (!COUNTER_NAMES.has(name)) return false;
  const n = Math.max(1, Math.floor(Number(delta) || 1));
  db.prepare(`
    INSERT INTO merge_telemetry (name, value, updated_at)
    VALUES (?, ?, ${NOW_ISO_SQL})
    ON CONFLICT(name) DO UPDATE SET
      value = value + excluded.value,
      updated_at = excluded.updated_at
  `).run(name, n);
  return true;
}

// Alle Counter als { name: value }-Map (fehlende = 0 ergaenzt der Aufrufer).
function allMergeCounters() {
  const out = {};
  for (const r of db.prepare('SELECT name, value FROM merge_telemetry').all()) {
    out[r.name] = r.value;
  }
  return out;
}

module.exports = { bumpMergeCounter, allMergeCounters, COUNTER_NAMES };
