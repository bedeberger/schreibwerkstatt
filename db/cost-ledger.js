'use strict';
// Persistentes KI-Kosten-Ledger (Tabelle ai_cost_ledger, Mig 196).
//
// Eine Zeile pro abgerechnetem KI-Call mit zur Schreib-Zeit EINGEFRORENER
// USD-Kosten (costUsd zum Zeitpunkt des Calls). Zweck: die Kostenhistorie von
// der Job-Wegwerf-Historie entkoppeln — job_runs wird nach 30 Tagen geprunt
// (lib/cache-cleanup.js), wodurch jede zur Lese-Zeit re-computete Aggregation
// ueber aeltere Zeitraeume schrumpfte. Das Ledger wird vom Cleanup NIE
// angefasst; alle Kosten-/Token-Aggregate (Admin-Usage, Budget-Gate,
// Daily-Usage, /metrics) lesen daraus.
//
// Schreib-Chokepoints (genau zwei, sonst Doppelzaehlung):
//   - recordJobLedger(jobId)            ← db/schema.js#endJobRun (alle Jobs
//                                         AUSSER chat-sourced Typen)
//   - recordChatLedgerForMessage(id)    ← routes/jobs/chat.js (pro Assistant-
//                                         Nachricht; Seiten- + Buch-Chat)
// Chat-Jobs laufen ebenfalls durch endJobRun (Lifecycle), ihr Verbrauch lebt
// aber in chat_messages — darum schliesst recordJobLedger die Typen 'chat'/
// 'book-chat' aus. Spiegelt lib/usage-sources#excludeChatSourcedSql.
//
// source_ref ('job:<job_id>' | 'chatmsg:<id>') ist ein opaker Trace-/Idempotenz-
// Schluessel mit UNIQUE-Constraint — INSERT OR IGNORE macht beide Recorder
// re-entry-sicher. Bewusst KEIN Integer-FK: muss den Prune der Quellzeile
// ueberleben.

const { db } = require('./connection');
// Migrationen vor Statement-Prep erzwingen — egal ueber welchen Pfad dieses
// Modul zuerst geladen wird, ai_cost_ledger muss dann existieren. Idempotent.
require('./migrations');
const { costUsd } = require('../lib/pricing');
const { CHAT_SOURCED_JOB_TYPES } = require('../lib/usage-sources');
const logger = require('../logger');

const _chatSourced = new Set(CHAT_SOURCED_JOB_TYPES);

const _ins = db.prepare(`
  INSERT OR IGNORE INTO ai_cost_ledger
    (ts, user_email, source, type, book_id, provider, model,
     tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, usd, source_ref)
  VALUES (@ts, @user_email, @source, @type, @book_id, @provider, @model,
          @tokens_in, @tokens_out, @cache_read_in, @cache_creation_in, @cache_creation_1h_in, @usd, @source_ref)
`);

function _record(row) {
  _ins.run({
    ts: row.ts || new Date().toISOString(),
    user_email: row.user_email || null,
    source: row.source,
    type: row.type || null,
    book_id: row.book_id || null,
    provider: row.provider || null,
    model: row.model || null,
    tokens_in: row.tokens_in || 0,
    tokens_out: row.tokens_out || 0,
    cache_read_in: row.cache_read_in || 0,
    cache_creation_in: row.cache_creation_in || 0,
    cache_creation_1h_in: row.cache_creation_1h_in || 0,
    usd: costUsd({
      provider: row.provider, model: row.model,
      tokensIn: row.tokens_in, tokensOut: row.tokens_out,
      cacheReadIn: row.cache_read_in, cacheCreationIn: row.cache_creation_in,
      cacheCreation1hIn: row.cache_creation_1h_in,
    }),
    source_ref: row.source_ref,
  });
}

const _selJobRun = db.prepare(`
  SELECT job_id, ended_at, user_email, type, book_id, provider, model,
         tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in
    FROM job_runs WHERE job_id = ?
`);

// Aus endJobRun aufgerufen, NACHDEM die job_runs-Zeile mit ihren Token-Werten
// aktualisiert wurde. Liest die frische Zeile zurueck und schreibt eine Ledger-
// Zeile — ausser fuer chat-sourced Typen (Verbrauch via recordChatLedgerForMessage).
// Niemals werfen: Ledger-Schreiben darf den Job-Abschluss nicht torpedieren.
function recordJobLedger(jobId) {
  try {
    const r = _selJobRun.get(jobId);
    if (!r) return;
    if (_chatSourced.has(r.type)) return;
    _record({
      ts: r.ended_at,
      user_email: r.user_email,
      source: 'job',
      type: r.type,
      book_id: r.book_id,
      provider: r.provider,
      model: r.model,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
      cache_read_in: r.cache_read_in,
      cache_creation_in: r.cache_creation_in,
      cache_creation_1h_in: r.cache_creation_1h_in,
      source_ref: `job:${jobId}`,
    });
  } catch (e) {
    logger.error(`[cost-ledger] recordJobLedger(${jobId}) fehlgeschlagen: ${e.message}`);
  }
}

const _selChatMsg = db.prepare(`
  SELECT cm.id, cm.created_at, cs.user_email AS user_email, cs.kind AS type, cs.book_id AS book_id,
         cm.provider, cm.model,
         cm.tokens_in, cm.tokens_out, cm.cache_read_in, cm.cache_creation_in, cm.cache_creation_1h_in
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
   WHERE cm.id = ? AND cm.role = 'assistant'
`);

// Aus routes/jobs/chat.js aufgerufen, nachdem die Assistant-Nachricht eingefuegt
// wurde. Niemals werfen: Chat-Antwort ist bereits persistiert.
function recordChatLedgerForMessage(messageId) {
  try {
    const r = _selChatMsg.get(messageId);
    if (!r) return;
    _record({
      ts: r.created_at,
      user_email: r.user_email,
      source: 'chat',
      type: r.type,
      book_id: r.book_id,
      provider: r.provider,
      model: r.model,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
      cache_read_in: r.cache_read_in,
      cache_creation_in: r.cache_creation_in,
      cache_creation_1h_in: r.cache_creation_1h_in,
      source_ref: `chatmsg:${messageId}`,
    });
  } catch (e) {
    logger.error(`[cost-ledger] recordChatLedgerForMessage(${messageId}) fehlgeschlagen: ${e.message}`);
  }
}

// ── Lese-Helfer ─────────────────────────────────────────────────────────────

// Rohe Ledger-Zeilen in [fromIso, toIso). Optionale Filter user/provider/source.
// usd ist pro Zeile eingefroren — Aggregatoren summieren, statt neu zu rechnen.
function queryRange({ fromIso, toIso, userEmail, provider, source } = {}) {
  const where = ['ts >= @from', 'ts < @to'];
  if (userEmail) where.push('user_email = @userEmail');
  if (provider)  where.push('provider = @provider');
  if (source)    where.push('source = @source');
  return db.prepare(`
    SELECT ts, user_email, source, type, book_id, provider, model,
           tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, usd
      FROM ai_cost_ledger
     WHERE ${where.join(' AND ')}
  `).all({
    from: fromIso, to: toIso,
    userEmail: userEmail || null, provider: provider || null, source: source || null,
  });
}

const _sumUsdSince = db.prepare(
  `SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_cost_ledger WHERE user_email = ? AND ts >= ?`
);

// Eingefrorene USD-Summe eines Users seit sinceIso — treibt das Budget-Gate.
function sumUsdSince(email, sinceIso) {
  if (!email) return 0;
  return _sumUsdSince.get(email, sinceIso).usd || 0;
}

module.exports = {
  recordJobLedger,
  recordChatLedgerForMessage,
  queryRange,
  sumUsdSince,
};
