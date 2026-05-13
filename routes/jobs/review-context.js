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
const MAX_MIKRO_PRO_KAPITEL = 8;  // Top-N Kapitel im Mikro-Aggregat

function _truncString(s, n) {
  if (!s) return '';
  const t = String(s).trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** Lädt Zeitstrahl-Events aus zeitstrahl_events. Kapitel-IDs werden bei Bedarf
 *  in lesbare Namen aufgelöst.
 */
function _loadZeitstrahl(bookId, userEmail) {
  return db.prepare(`
    SELECT ze.datum, ze.ereignis, ze.typ, ze.bedeutung, ze.kapitel
      FROM zeitstrahl_events ze
     WHERE ze.book_id = ? AND ze.user_email = ?
     ORDER BY ze.sort_order, ze.id
  `).all(bookId, userEmail || '');
}

/** Aggregiert die zuletzt aufgezeichneten Lektorats-Findings des Buchs:
 *   - latest page_check pro Seite (per checked_at DESC)
 *   - errors_json parsen, Severity/Typ zählen
 *   - per-Kapitel-Aggregat (Top-N nach Findings-Anzahl)
 *   - Buch-weite Typ-Verteilung
 *  Ohne user_email-Match: Verwerfen, damit Reviews je User isoliert bleiben.
 */
function _aggregateMikroFindings(bookId, userEmail) {
  const email = userEmail || null;
  // Letzter Check pro Seite – sub-select per page_id.
  const rows = db.prepare(`
    SELECT pc.page_id, pc.chapter_id, pc.error_count, pc.errors_json, p.page_name, c.chapter_name
      FROM page_checks pc
      LEFT JOIN pages p    ON p.page_id = pc.page_id
      LEFT JOIN chapters c ON c.chapter_id = pc.chapter_id
     WHERE pc.book_id = ? AND pc.user_email IS ?
       AND pc.id = (
         SELECT id FROM page_checks
          WHERE page_id = pc.page_id AND book_id = pc.book_id AND user_email IS pc.user_email
          ORDER BY checked_at DESC LIMIT 1
       )
  `).all(bookId, email);

  if (!rows.length) return null;

  const byTyp = new Map();
  const byChapter = new Map();
  let totalFindings = 0;
  let pagesWithFindings = 0;

  for (const r of rows) {
    const cnt = r.error_count || 0;
    if (cnt > 0) pagesWithFindings++;
    totalFindings += cnt;
    if (r.errors_json) {
      try {
        const arr = JSON.parse(r.errors_json);
        if (Array.isArray(arr)) {
          for (const f of arr) {
            const typ = (f?.typ || 'sonstige').toString();
            byTyp.set(typ, (byTyp.get(typ) || 0) + 1);
          }
        }
      } catch { /* ungültiges JSON – ignorieren */ }
    }
    if (r.chapter_id) {
      const key = r.chapter_id;
      const bucket = byChapter.get(key) || { chapter_id: key, chapter_name: r.chapter_name || null, findings: 0, pages: 0 };
      bucket.findings += cnt;
      if (cnt > 0) bucket.pages += 1;
      byChapter.set(key, bucket);
    }
  }

  const topTypen = [...byTyp.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([typ, count]) => ({ typ, count }));

  const topKapitel = [...byChapter.values()]
    .sort((a, b) => b.findings - a.findings)
    .slice(0, MAX_MIKRO_PRO_KAPITEL);

  return {
    pagesChecked: rows.length,
    pagesWithFindings,
    totalFindings,
    topTypen,
    topKapitel,
  };
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
  const mikro = _aggregateMikroFindings(bookId, userEmail);

  return { figuren, beziehungen, continuityIssues, zeitstrahl, mikro };
}

module.exports = {
  loadReviewKomplettContext,
  _aggregateMikroFindings,  // export for tests
};
