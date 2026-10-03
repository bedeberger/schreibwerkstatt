'use strict';
// Chat-Qualitaet: Feedback pro Antwort, Wiederholungs-Erkennung und die
// Auswertung pro Chat-Art fuer das Admin-Usage (Tab „Chat").
//
// Gilt fuer alle Chats gleich (Seiten-, Buch-, Recherche-Chat, docs/chats.md) —
// alles haengt an `chat_messages` + `chat_sessions.kind`, nicht an einem Job-Pfad.
//
//  - Feedback: `chat_messages.feedback` (+1/-1/NULL) + `feedback_at`, nur an
//    Assistant-Nachrichten, nur durch den Besitzer der Session.
//  - Wiederholung: stellt derselbe User dieselbe Frage (normalisiert) binnen
//    REPEAT_WINDOW_MS im selben Buch und in derselben Chat-Art erneut, traegt
//    die neue User-Nachricht `context_info.repeat_of = <id der frueheren>`.
//    Reine Messung — keine UI, kein Einfluss auf den Job.
//  - Auswertung: Antworten, Fehlerquote (job_runs), Feedback-Anteile,
//    Wiederholungen und Kosten (Kosten-Ledger, source='chat') je Chat-Art.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const costLedger = require('./cost-ledger');
const { CHAT_SOURCED_JOB_TYPES, CHAT_JOB_KIND } = require('../lib/usage-sources');

const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Deckel fuer die Kandidaten einer Wiederholungs-Pruefung: ein User stellt in
// 24 h in einem Buch keine 500 Fragen; der Deckel haelt nur den Ausreisser flach.
const REPEAT_SCAN_LIMIT = 500;

/** Normalisierung fuer den Wiederholungs-Vergleich: Kleinschreibung, jede
 *  Whitespace-Folge zu einem Leerzeichen, getrimmt. */
function normalizeQuestion(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const _stmtRepeatCandidates = db.prepare(`
  SELECT cm.id, cm.content
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
   WHERE cs.user_email = ? AND cs.book_id = ? AND cs.kind = ?
     AND cm.role = 'user' AND cm.id <> ? AND cm.created_at >= ?
   ORDER BY cm.created_at DESC, cm.id DESC
   LIMIT ${REPEAT_SCAN_LIMIT}
`);

/** Juengste fruehere User-Nachricht mit derselben (normalisierten) Frage —
 *  gleicher User, gleiches Buch, gleiche Chat-Art, binnen 24 h. Liefert ihre
 *  ID oder null. */
function findRepeatOf({ messageId, userEmail, bookId, kind, content, now = Date.now() }) {
  const needle = normalizeQuestion(content);
  if (!needle || !userEmail || !bookId || !kind) return null;
  const cutoff = new Date(now - REPEAT_WINDOW_MS).toISOString();
  const rows = _stmtRepeatCandidates.all(userEmail, bookId, kind, messageId || 0, cutoff);
  const hit = rows.find(r => normalizeQuestion(r.content) === needle);
  return hit ? hit.id : null;
}

const _stmtMarkRepeat = db.prepare(`
  UPDATE chat_messages
     SET context_info = json_set(
           CASE WHEN json_valid(context_info) THEN context_info ELSE '{}' END,
           '$.repeat_of', ?)
   WHERE id = ?
`);

/** Prueft eine frisch gespeicherte User-Nachricht auf Wiederholung und
 *  vermerkt sie. Liefert die ID der frueheren Nachricht oder null. */
function recordRepeat({ messageId, userEmail, bookId, kind, content, now }) {
  const repeatOf = findRepeatOf({ messageId, userEmail, bookId, kind, content, now });
  if (repeatOf) _stmtMarkRepeat.run(repeatOf, messageId);
  return repeatOf;
}

const _stmtOwnedMessage = db.prepare(`
  SELECT cm.id, cm.role, cs.book_id
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
   WHERE cm.id = ? AND cs.user_email = ?
`);

/** Nachricht samt Buch, falls sie zu einer Session dieses Users gehoert. */
function getOwnedMessage(messageId, userEmail) {
  if (!messageId || !userEmail) return null;
  return _stmtOwnedMessage.get(messageId, userEmail) || null;
}

const _stmtSetFeedback = db.prepare(`
  UPDATE chat_messages SET feedback = ?, feedback_at = ${NOW_ISO_SQL}
   WHERE id = ? AND role = 'assistant'
`);

/** Feedback setzen (+1/-1) oder zuruecknehmen (null). */
function setFeedback(messageId, value) {
  return _stmtSetFeedback.run(value, messageId).changes;
}

// ── Auswertung (Admin-Usage) ────────────────────────────────────────────────

function _notIn(col, set) {
  if (!set || !set.size) return { sql: '', args: [] };
  return { sql: ` AND ${col} NOT IN (${[...set].map(() => '?').join(',')})`, args: [...set] };
}

function _row(acc, kind) {
  let r = acc.get(kind);
  if (!r) {
    r = {
      kind, answers: 0, questions: 0, repeats: 0, feedbackUp: 0, feedbackDown: 0,
      runs: 0, done: 0, errors: 0, cancelled: 0, usd: 0,
    };
    acc.set(kind, r);
  }
  return r;
}

/**
 * Kennzahlen je Chat-Art im Zeitraum [fromIso, toIso). `excludedEmails`: Konten,
 * die nicht mitzaehlen (Admins, siehe db/admin-usage.js).
 * Fehlerquote = Fehler / (fertig + Fehler); vom User abgebrochene Laeufe zaehlen
 * separat und nicht als Fehler.
 */
function chatQualityStats({ fromIso, toIso, excludedEmails = new Set() }) {
  const acc = new Map();

  const ex = _notIn('cs.user_email', excludedEmails);
  const msgRows = db.prepare(`
    SELECT cs.kind,
           SUM(cm.role = 'assistant')                         AS answers,
           SUM(cm.role = 'user')                              AS questions,
           SUM(cm.role = 'assistant' AND cm.feedback = 1)     AS up,
           SUM(cm.role = 'assistant' AND cm.feedback = -1)    AS down,
           SUM(cm.role = 'user' AND json_valid(cm.context_info)
               AND json_extract(cm.context_info, '$.repeat_of') IS NOT NULL) AS repeats
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.session_id
     WHERE cm.created_at >= ? AND cm.created_at < ?${ex.sql}
     GROUP BY cs.kind
  `).all(fromIso, toIso, ...ex.args);
  for (const m of msgRows) {
    const r = _row(acc, m.kind);
    r.answers = m.answers || 0;
    r.questions = m.questions || 0;
    r.feedbackUp = m.up || 0;
    r.feedbackDown = m.down || 0;
    r.repeats = m.repeats || 0;
  }

  const exJ = _notIn('user_email', excludedEmails);
  const types = CHAT_SOURCED_JOB_TYPES.map(() => '?').join(',');
  const jobRows = db.prepare(`
    SELECT type, status, COUNT(*) AS n
      FROM job_runs
     WHERE type IN (${types}) AND queued_at >= ? AND queued_at < ?
       AND status IN ('done','error','cancelled')${exJ.sql}
     GROUP BY type, status
  `).all(...CHAT_SOURCED_JOB_TYPES, fromIso, toIso, ...exJ.args);
  for (const j of jobRows) {
    const r = _row(acc, CHAT_JOB_KIND[j.type] || j.type);
    r.runs += j.n;
    if (j.status === 'done') r.done += j.n;
    else if (j.status === 'error') r.errors += j.n;
    else r.cancelled += j.n;
  }

  for (const l of costLedger.queryRange({ fromIso, toIso })) {
    if (l.source !== 'chat') continue;
    if (l.user_email && excludedEmails.has(l.user_email)) continue;
    _row(acc, l.type || 'unknown').usd += l.usd || 0;
  }

  return [...acc.values()].map(r => {
    const settled = r.done + r.errors;
    const rated = r.feedbackUp + r.feedbackDown;
    return {
      ...r,
      errorRate: settled > 0 ? r.errors / settled : null,
      upShare: rated > 0 ? r.feedbackUp / rated : null,
      downShare: rated > 0 ? r.feedbackDown / rated : null,
      repeatShare: r.questions > 0 ? r.repeats / r.questions : null,
      usdPerAnswer: r.answers > 0 ? r.usd / r.answers : null,
    };
  }).sort((a, b) => b.answers - a.answers);
}

module.exports = {
  REPEAT_WINDOW_MS,
  normalizeQuestion, findRepeatOf, recordRepeat,
  getOwnedMessage, setFeedback,
  chatQualityStats,
};
