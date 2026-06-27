'use strict';
// Chat-Job-Typen, deren Token-Verbrauch in ZWEI Tabellen landet: job_runs
// (Lifecycle/Status, von completeJob→endJobRun) und chat_messages (Detail-Record
// mit korrektem Per-Message-Modell). chat_messages ist die SSoT fuer Chat-
// Verbrauch.
//
// Jede Token-/Kosten-Aggregation, die BEIDE Tabellen summiert (Admin-Usage,
// Daily-Usage, Budget-Gate, /metrics), MUSS diese Typen auf der job_runs-Seite
// ausschliessen — sonst wird jeder Chat-Dollar doppelt gezaehlt. Job-COUNT-
// Metriken und die Job-Detailliste duerfen die Rows behalten (kein Aggregat).
const CHAT_SOURCED_JOB_TYPES = ['chat', 'book-chat', 'research-chat'];

// SQL-Fragment fuer eine WHERE-Clause ueber job_runs. `col` erlaubt Tabellen-
// Alias-Prefixe (z.B. 'jr.type'); Default ist die nackte Spalte `type`.
function excludeChatSourcedSql(col = 'type') {
  const list = CHAT_SOURCED_JOB_TYPES.map(t => `'${t}'`).join(', ');
  return `${col} NOT IN (${list})`;
}

module.exports = { CHAT_SOURCED_JOB_TYPES, excludeChatSourcedSql };
