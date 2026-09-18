'use strict';
// Lesepfad fuer die Kapitel-Entstehung: die Seitenfassungen eines Buchs mit
// ihrem Kapitelbezug. Der JOIN auf `pages` gehoert in dieses Modul und nicht in
// den Route-Handler (gleiche Regel wie db/sources/citations.js und der
// Kapitel-JOIN in db/time-tracking.js).
//
// Verdichtet wird NICHT in SQL: die Tagesgrenze haengt an `app.timezone`, und
// SQLite kennt nur UTC bzw. die Prozess-Zeitzone — ein `date(created_at)` legte
// einen Abend-Eintrag um 00:30 Ortszeit auf den Vortag. Die Bucketbildung macht
// darum lib/chapter-growth.js. Die Zeilen sind schmal (kein `body_html`) und
// durch die Retention gedeckelt.

const { db } = require('./connection');
require('./migrations');

const _rowsStmt = db.prepare(`
  SELECT p.chapter_id AS chapter_id,
         r.page_id    AS page_id,
         r.created_at AS created_at,
         r.chars      AS chars,
         r.words      AS words
    FROM page_revisions r
    JOIN pages p ON p.page_id = r.page_id
   WHERE r.book_id = ?
     AND p.book_id = r.book_id
     AND p.chapter_id IS NOT NULL
     AND r.chars IS NOT NULL
   ORDER BY r.created_at ASC, r.id ASC
`);

/** Fassungs-Zeilen eines Buchs, aufsteigend nach Zeitstempel (Vertrag von
 *  lib/chapter-growth.js#buildChapterGrowth). Seiten ohne Kapitel bleiben
 *  aussen vor — die Karte fragt immer nach einem Kapitel. */
function chapterGrowthRows(bookId) {
  return _rowsStmt.all(bookId);
}

module.exports = { chapterGrowthRows };
