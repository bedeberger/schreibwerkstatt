'use strict';
// Lädt strukturierte Komplettanalyse-Daten + Lektorats-Findings für ein Buch
// und verdichtet sie zu einem Kontext-Objekt, das `buildBookReviewSinglePassPrompt`
// / `buildBookReviewMultiPassPrompt` einkippt.
//
// Alle Quellen sind optional: fehlt eine Komplettanalyse, bleibt das Feld leer
// und der Prompt-Block für diese Quelle wird vom Builder weggelassen.

const { db, getChapterFigures, getChapterFigureRelations, getLatestContinuityCheck } = require('../../db/schema');

// Schutz vor Prompt-Bloat. Werte konservativ – die Buchreview liefert ohnehin
// den Volltext (Single-Pass) bzw. die Kapitelanalysen (Multi-Pass) als Hauptinput.
const MAX_FIGUREN          = 30;
const MAX_BEZIEHUNGEN      = 60;
const MAX_CONTINUITY       = 25;
const MAX_ZEITSTRAHL       = 40;

function _truncString(s, n) {
  if (!s) return '';
  const t = String(s).trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** Lädt Zeitstrahl-Events aus zeitstrahl_events. Kapitel-Namen kommen via
 *  Junction-Tabelle zeitstrahl_event_chapters → chapters (Migration 74).
 *  Pro Event: kommagetrennte Kapitelnamen in Sort-Order.
 */
function _loadZeitstrahl(bookId, userEmail) {
  return db.prepare(`
    SELECT ze.datum, ze.ereignis, ze.typ, ze.bedeutung,
           (
             SELECT GROUP_CONCAT(c.chapter_name, ', ')
               FROM zeitstrahl_event_chapters zec
               LEFT JOIN chapters c ON c.chapter_id = zec.chapter_id
              WHERE zec.event_id = ze.id
           ) AS kapitel
      FROM zeitstrahl_events ze
     WHERE ze.book_id = ? AND ze.user_email = ?
     ORDER BY ze.sort_order, ze.id
  `).all(bookId, userEmail || '');
}

/** Sammelt alle für die Buchreview-Augmentation relevanten Strukturdaten.
 *  Liefert ein flaches Objekt mit den Buckets; leere Buckets bleiben als
 *  leere Arrays / null – der Prompt-Builder entscheidet, was er injiziert.
 */
function loadReviewKomplettContext(bookId, userEmail) {
  const figuren     = (getChapterFigures(bookId, null, userEmail) || []).slice(0, MAX_FIGUREN).map(f => ({
    name: f.name,
    kurzname: f.kurzname || null,
    typ: f.typ || null,
    geschlecht: f.geschlecht || null,
    beruf: f.beruf || null,
    beschreibung: _truncString(f.beschreibung, 240),
  }));
  const beziehungen = (getChapterFigureRelations(bookId, null, userEmail) || []).slice(0, MAX_BEZIEHUNGEN).map(b => ({
    von: b.von,
    zu: b.zu,
    typ: b.typ,
    beschreibung: _truncString(b.beschreibung, 160),
  }));
  const continuity  = getLatestContinuityCheck(bookId, userEmail);
  const continuityIssues = continuity?.issues
    ? continuity.issues.slice(0, MAX_CONTINUITY).map(i => ({
        schwere: i.schwere,
        typ: i.typ,
        beschreibung: _truncString(i.beschreibung, 240),
        kapitel: (i.kapitel || []).slice(0, 3),
        figuren: (i.figuren || []).slice(0, 5),
      }))
    : [];
  const zeitstrahl = _loadZeitstrahl(bookId, userEmail).slice(0, MAX_ZEITSTRAHL).map(e => ({
    datum: e.datum,
    ereignis: _truncString(e.ereignis, 160),
    typ: e.typ || null,
    kapitel: e.kapitel || null,
  }));

  return { figuren, beziehungen, continuityIssues, zeitstrahl };
}

module.exports = {
  loadReviewKomplettContext,
};
