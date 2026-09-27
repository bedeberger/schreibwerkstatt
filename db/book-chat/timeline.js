'use strict';
// Abfragen der Buch-Chat-Tools `list_continuity_issues` und `get_timeline`
// (routes/jobs/book-chat-tools/tools-timeline.js): jüngster Kontinuitätscheck,
// Issues, Zeitstrahl-Events und die Figuren-/Kapitel-/Seiten-Bridges. Das Tool
// führt selbst kein SQL aus; Kapitel-/Seitennamen kommen per JOIN von hier
// (CLAUDE.md „Content-Store-Facade als einziger Eintrittspunkt"). IN-Listen
// werden hier gebaut; eine leere Liste matcht nichts (`inClause` → `(NULL)`).

const { db } = require('../connection');
require('../migrations');
const { inClause } = require('../../lib/validate');

// ── list_continuity_issues ──────────────────────────────────────────────────

const _stmtLatestContinuityCheck = db.prepare(`
    SELECT id, checked_at, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email IS ?
    ORDER BY checked_at DESC
    LIMIT 1
  `);

/** Jüngster Kontinuitätscheck von (Buch, User), NULL-sicher. */
function getLatestContinuityCheck(bookId, userEmail) {
  return _stmtLatestContinuityCheck.get(bookId, userEmail);
}

const _stmtContinuityIssues = db.prepare(`
    SELECT id, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, sort_order
    FROM continuity_issues
    WHERE check_id = ?
    ORDER BY sort_order, id
  `);

/** Issues eines Checks in Anzeige-Reihenfolge. */
function listContinuityIssuesForCheck(checkId) {
  return _stmtContinuityIssues.all(checkId);
}

/** Figuren-Bezüge von Kontinuitäts-Issues; Name aus figures, sonst Freitext. */
function listContinuityIssueFigures(issueIds) {
  const { sql: idSql, values: idVals } = inClause(issueIds);
  return db.prepare(`
    SELECT cif.issue_id, COALESCE(f.fig_id, NULL) AS fig_id,
           COALESCE(f.name, cif.figur_name) AS name
    FROM continuity_issue_figures cif
    LEFT JOIN figures f ON f.id = cif.figure_id
    WHERE cif.issue_id IN ${idSql}
    ORDER BY cif.issue_id, cif.sort_order
  `).all(...idVals);
}

/** Kapitel-Bezüge von Kontinuitäts-Issues mit Kapitelname (NULL bei gelöschtem Kapitel). */
function listContinuityIssueChapters(issueIds) {
  const { sql: idSql, values: idVals } = inClause(issueIds);
  return db.prepare(`
    SELECT cic.issue_id, cic.chapter_id, c.chapter_name
    FROM continuity_issue_chapters cic
    LEFT JOIN chapters c ON c.chapter_id = cic.chapter_id
    WHERE cic.issue_id IN ${idSql}
    ORDER BY cic.issue_id, cic.sort_order
  `).all(...idVals);
}

// ── get_timeline ────────────────────────────────────────────────────────────

const _stmtTimelineEvents = db.prepare(`
    SELECT id, datum, ereignis, typ, bedeutung
    FROM zeitstrahl_events
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `);

/** Zeitstrahl-Events von (Buch, User) — `user_email = ?`, nicht NULL-sicher. */
function listTimelineEvents(bookId, userEmail) {
  return _stmtTimelineEvents.all(bookId, userEmail);
}

/** Figuren-Bezüge von Zeitstrahl-Events; Name aus figures, sonst Freitext. */
function listTimelineEventFigures(eventIds) {
  const { sql: idSql, values: idVals } = inClause(eventIds);
  return db.prepare(`
    SELECT zef.event_id, f.fig_id, COALESCE(f.name, zef.figur_name) AS name
    FROM zeitstrahl_event_figures zef
    LEFT JOIN figures f ON f.id = zef.figure_id
    WHERE zef.event_id IN ${idSql}
    ORDER BY zef.event_id, zef.sort_order
  `).all(...idVals);
}

/** Kapitel-Bezüge von Zeitstrahl-Events mit Kapitelname. */
function listTimelineEventChapters(eventIds) {
  const { sql: idSql, values: idVals } = inClause(eventIds);
  return db.prepare(`
    SELECT zec.event_id, zec.chapter_id, c.chapter_name
    FROM zeitstrahl_event_chapters zec
    LEFT JOIN chapters c ON c.chapter_id = zec.chapter_id
    WHERE zec.event_id IN ${idSql}
    ORDER BY zec.event_id, zec.sort_order
  `).all(...idVals);
}

/** Seiten-Bezüge von Zeitstrahl-Events mit Seitenname. */
function listTimelineEventPages(eventIds) {
  const { sql: idSql, values: idVals } = inClause(eventIds);
  return db.prepare(`
    SELECT zep.event_id, zep.page_id, p.page_name
    FROM zeitstrahl_event_pages zep
    LEFT JOIN pages p ON p.page_id = zep.page_id
    WHERE zep.event_id IN ${idSql}
    ORDER BY zep.event_id, zep.sort_order
  `).all(...idVals);
}

module.exports = {
  getLatestContinuityCheck,
  listContinuityIssuesForCheck,
  listContinuityIssueFigures,
  listContinuityIssueChapters,
  listTimelineEvents,
  listTimelineEventFigures,
  listTimelineEventChapters,
  listTimelineEventPages,
};
