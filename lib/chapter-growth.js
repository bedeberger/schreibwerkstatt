'use strict';
// Kapitel-Entstehung: aus den Seitenfassungen (`page_revisions`) wird je Kapitel
// eine Zeitreihe seiner ABSOLUTEN Groesse. Reiner Rechenkern ohne DB und ohne
// Express — die Zeilen liefert db/chapter-growth.js, den Endpunkt
// routes/history/stats.js.
//
// Warum aus `page_revisions` und nicht aus `book_stats_history`: der
// Statistik-Verlauf ist buchweit (ein Snapshot pro Tag ueber das ganze Werk) und
// laesst sich nicht nachtraeglich auf Kapitel aufteilen. Die Fassungen sind die
// einzige Quelle, die einen Textstand einer EINZELNEN Seite mit Zeitstempel
// festhaelt.
//
// Drei Eigenschaften, die jeder Konsument kennen muss:
//
//   * **Absolut, nicht additiv.** Ein Punkt sagt „so gross war dieses Kapitel am
//     Abend dieses Tages", nicht „so viel kam dazu". Nur so darf der Client
//     mehrere Kapitel eines Scopes addieren (Summe carry-forward-gefuehrter
//     Reihen = carry-forward der Summe); bei Zuwaechsen waere jede Seite, die an
//     dem Tag NICHT angefasst wurde, stillschweigend auf null gefallen.
//   * **Nur Tage mit Aenderung.** Dazwischen gilt der letzte Wert weiter; die
//     Kurve ist eine Treppe. Eine dichte Tagesachse waere ueber Jahre hinweg
//     tausende Punkte fuer dieselbe Aussage.
//   * **Die Aufloesung nimmt nach hinten ab.** `pruneTiered` (db/page-revisions.js)
//     haelt aeltere Zeitraeume nur noch woechentlich/monatlich/jaehrlich. Die
//     FORM der Kurve ueberlebt das (die behaltenen Werte sind echte Staende),
//     eine Zaehlung von Bearbeitungen NICHT — darum gibt dieses Modul bewusst
//     keine Fassungs- oder Aktivtage-Zahl heraus, die man ueber die Zeit
//     vergleichen koennte.
//
// Der Kapitelbezug ist der von HEUTE (`pages.chapter_id`): eine Seite, die
// spaeter in ein anderes Kapitel gehaengt wurde, bringt ihre ganze Geschichte
// dorthin mit. Das ist die Frage, die die Karte stellt — „wie ist dieses
// Kapitel, so wie es jetzt dasteht, entstanden".

/** Tages-Formatter (YYYY-MM-DD) in der App-Zeitzone. Einmal gebaut und
 *  wiederverwendet: der Aufruf laeuft ueber zehntausende Fassungen, und ein
 *  `toLocaleDateString` pro Zeile baut jedes Mal einen neuen Intl-Formatter.
 *  'en-CA' liefert das ISO-Format unabhaengig von der System-Locale (gleiche
 *  Begruendung wie lib/local-date.js#localIsoDate). */
function dayBucketer(tz) {
  let fmt = null;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' });
  } catch (_) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' });
  }
  return (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '').slice(0, 10);
    return fmt.format(d);
  };
}

/**
 * Fassungs-Zeilen → Zeitreihe je Kapitel.
 *
 * @param {Array<{chapter_id:number, page_id:number, created_at:string, chars:number, words:number}>} rows
 *        AUFSTEIGEND nach `created_at` sortiert. Die Ordnung ist Vertrag: das
 *        Verfahren traegt die Seitenstaende mit und kann nicht zurueckspringen.
 * @param {{tz?: string}} opts
 * @returns {{chapters: Object<string, {points: Array<{d:string,c:number,w:number}>, pages: number[]}>}}
 */
function buildChapterGrowth(rows, { tz = 'UTC' } = {}) {
  const dayOf = dayBucketer(tz);
  const chapters = new Map();

  for (const r of rows || []) {
    if (r == null || r.chapter_id == null) continue;
    const key = String(r.chapter_id);
    let st = chapters.get(key);
    if (!st) {
      st = { pages: new Map(), chars: 0, words: 0, points: [] };
      chapters.set(key, st);
    }
    const chars = Number(r.chars) || 0;
    const words = Number(r.words) || 0;
    const prev = st.pages.get(r.page_id);
    // Laufende Summe fortschreiben statt neu aufzuaddieren: das Verfahren ist
    // sonst O(Zeilen × Seiten) und laeuft ueber die ganze Buchhistorie.
    st.chars += chars - (prev ? prev.c : 0);
    st.words += words - (prev ? prev.w : 0);
    st.pages.set(r.page_id, { c: chars, w: words });

    const day = dayOf(r.created_at);
    const last = st.points[st.points.length - 1];
    if (last && last.d === day) { last.c = st.chars; last.w = st.words; }
    else st.points.push({ d: day, c: st.chars, w: st.words });
  }

  const out = {};
  for (const [key, st] of chapters) {
    out[key] = { points: st.points, pages: [...st.pages.keys()] };
  }
  return { chapters: out };
}

module.exports = { buildChapterGrowth, dayBucketer };
