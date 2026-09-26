'use strict';
// Kapitel-/Seiten-Namens-JOINs der Buch-Chat-Tools `list_continuity_issues` und
// `get_timeline` (routes/jobs/book-chat-tools/tools-timeline.js). Handler fassen
// `pages`/`chapters`/`books` nie selbst an (CLAUDE.md „Content-Store-Facade als
// einziger Eintrittspunkt"). IN-Listen werden hier gebaut; eine leere Liste
// matcht nichts (`inClause` → `(NULL)`).

const { db } = require('../connection');
require('../migrations');
const { inClause } = require('../../lib/validate');

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
  listContinuityIssueChapters,
  listTimelineEventChapters,
  listTimelineEventPages,
};
