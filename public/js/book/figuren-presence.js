// Figuren-Präsenz: deterministische Auftritts- und Bogen-Analyse (kein KI-Call).
// Rechnet client-seitig aus dem bereits geladenen Figuren-Katalog:
//   - f.kapitel            [{ chapter_id, name, haeufigkeit }]  → Präsenz je Kapitel
//   - f.lebensereignisse   [{ subtyp, chapter_id, … }]          → Wendepunkt-Marker
//   - f.arc.wendepunkte                                         → deklarierter Bogen
// Speist die Präsenz-Heatmap (Figuren × Kapitel) als 4. Graph-Tab, den Pro-Figur-
// Streifen in den Figuren-Details und eine deterministische Befund-Liste
// (Abwesenheits-Lücke, später Auftritt, früher Abgang, flacher Bogen, Ko-Präsenz-
// Lücke). Methoden werden in Alpine.data('figurenCard') gespreadet; Root-Zugriffe
// via window.__app. Reine Compute-Funktionen exportiert → ohne Alpine testbar.

// Reihenfolge der Figuren-Zeilen (Typ-Tier, danach Gesamtpräsenz absteigend).
const TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, randfigur: 4, andere: 5 };
// Typen, für die dramaturgische Befunde (Lücke / später Auftritt / früher Abgang) zählen.
const CORE_TYPES = new Set(['hauptfigur', 'antagonist', 'mentor']);
const EDGE_FRACTION = 0.25; // erstes/letztes Viertel des Buchs = "spät/früh"

// Mindestlänge einer internen Abwesenheits-Kette, damit sie als Befund gilt.
function gapThreshold(n) { return Math.max(3, Math.round(n * 0.15)); }

// Kern-Aggregation. `figuren` = Katalog-Array, `chapterOrder` = Kapitelnamen in
// Lese-Reihenfolge (Spaltenachse). Liefert Matrix + Zeilen-Kennzahlen + Befunde.
export function computePresence(figuren, chapterOrder) {
  const chapters = chapterOrder || [];
  const n = chapters.length;
  const colIdx = new Map();
  chapters.forEach((name, i) => colIdx.set(name, i));

  const src = (figuren || []).filter(f => !f.stale);

  // Kapitelname → chapter_id (für Header-Sprünge) + chapter_id → Spaltenindex
  // (Wendepunkt-Events sind per chapter_id verankert, nicht per Name).
  const nameToId = new Map();
  for (const f of src) {
    for (const k of (f.kapitel || [])) {
      if (k.name && k.chapter_id != null && !nameToId.has(k.name)) nameToId.set(k.name, k.chapter_id);
    }
  }
  const idToCol = new Map();
  for (const [name, id] of nameToId) { const c = colIdx.get(name); if (c != null) idToCol.set(id, c); }

  let grandTotal = 0, maxCell = 0;
  const rows = [];
  for (const f of src) {
    const haeByCol = new Array(n).fill(0);
    for (const k of (f.kapitel || [])) {
      const c = colIdx.get(k.name);
      if (c != null) haeByCol[c] += (k.haeufigkeit || 1);
    }
    let total = 0, firstIdx = -1, lastIdx = -1;
    for (let i = 0; i < n; i++) {
      const h = haeByCol[i];
      if (h > 0) { total += h; if (firstIdx < 0) firstIdx = i; lastIdx = i; if (h > maxCell) maxCell = h; }
    }
    if (total === 0) continue; // Figuren ohne Auftritt gehören nicht in die Heatmap
    grandTotal += total;

    // Längste interne Abwesenheits-Kette (nur zwischen erstem und letztem Auftritt).
    let maxGap = null, run = 0, runStart = -1;
    for (let i = firstIdx; i <= lastIdx; i++) {
      if (haeByCol[i] === 0) { if (run === 0) runStart = i; run++; }
      else if (run > 0) { if (!maxGap || run > maxGap.len) maxGap = { len: run, fromIdx: runStart, toIdx: i - 1 }; run = 0; }
    }

    // Wendepunkt-Spalten aus verankerten Lebensereignissen (subtyp='wendepunkt').
    const wpCols = new Set();
    for (const e of (f.lebensereignisse || [])) {
      if (e.subtyp !== 'wendepunkt' || e.chapter_id == null) continue;
      const c = idToCol.get(e.chapter_id);
      if (c != null) wpCols.add(c);
    }
    const declaredWendepunkte = Array.isArray(f.arc?.wendepunkte) ? f.arc.wendepunkte.length : 0;

    rows.push({
      id: f.id, name: f.name, typ: f.typ || 'andere',
      haeByCol, total, firstIdx, lastIdx, maxGap,
      wpCols, declaredWendepunkte, wendepunktCount: wpCols.size,
      cols: haeByCol.reduce((acc, h, i) => { if (h > 0) acc.push(i); return acc; }, []),
    });
  }

  rows.sort((a, b) => {
    const t = (TYP_ORDER[a.typ] ?? 9) - (TYP_ORDER[b.typ] ?? 9);
    return t || (b.total - a.total);
  });
  for (const r of rows) r.share = grandTotal > 0 ? r.total / grandTotal : 0;

  return { chapters, chapterNameToId: nameToId, rows, maxCell, grandTotal, findings: computeFindings(rows, chapters) };
}

// Deterministische Befunde aus den Zeilen-Kennzahlen. Reihenfolge = Anzeige-
// Reihenfolge (Lücke → später Auftritt → früher Abgang → flacher Bogen →
// Ko-Präsenz-Lücke), gruppiert nach Figur.
export function computeFindings(rows, chapters) {
  const n = chapters.length;
  const gap = gapThreshold(n);
  const edge = Math.max(1, Math.round(n * EDGE_FRACTION));
  const out = [];

  for (const r of rows) {
    const core = CORE_TYPES.has(r.typ);
    if (core && r.maxGap && r.maxGap.len >= gap) {
      out.push({ kind: 'gap', typ: r.typ, figId: r.id, figName: r.name, len: r.maxGap.len,
        fromChapter: chapters[r.maxGap.fromIdx], toChapter: chapters[r.maxGap.toIdx] });
    }
    if (core && n >= 4 && r.firstIdx >= edge) {
      out.push({ kind: 'lateEntrance', typ: r.typ, figId: r.id, figName: r.name, chapter: chapters[r.firstIdx] });
    }
    if (core && n >= 4 && (n - 1 - r.lastIdx) >= edge) {
      out.push({ kind: 'earlyExit', typ: r.typ, figId: r.id, figName: r.name, chapter: chapters[r.lastIdx] });
    }
    if ((r.typ === 'hauptfigur' || r.typ === 'antagonist') && r.declaredWendepunkte === 0 && r.wendepunktCount === 0) {
      out.push({ kind: 'flatArc', typ: r.typ, figId: r.id, figName: r.name });
    }
  }

  // Ko-Präsenz-Lücke: Hauptfigur teilt kein einziges Kapitel mit einem Antagonisten.
  const antagCols = rows.filter(r => r.typ === 'antagonist').map(r => ({ r, set: new Set(r.cols) }));
  for (const h of rows.filter(r => r.typ === 'hauptfigur')) {
    for (const { r: a, set } of antagCols) {
      if (h.cols.some(c => set.has(c))) continue;
      out.push({ kind: 'coPresenceGap', figId: h.id, figName: h.name, otherId: a.id, otherName: a.name });
    }
  }
  return out;
}

export const presenceMethods = {
  // Memoisiert (ein _memo-Helper pro Modul, CLAUDE.md). Deps: Katalog + Kapitel-
  // achse — beide stabil, solange sich die Figuren nicht ändern.
  figurenPresenceData() {
    const figuren = Alpine.store('catalog').figuren;
    const chapterOrder = this.figurenKapitelListe();
    return this._memo('presence', [figuren, chapterOrder], () => computePresence(figuren, chapterOrder));
  },

  // Eine Figuren-Zeile (für den Pro-Figur-Streifen), aus der memoisierten Matrix.
  figurenPresenceRow(figId) {
    const data = this.figurenPresenceData();
    return this._memo('prow:' + figId, [data], () => data.rows.find(r => r.id === figId) || null);
  },

  // Zellfarbe: Präsenz-Intensität als Primary-Fade. Sockel 12 %, damit auch ein
  // einzelner Auftritt sichtbar bleibt; Skala relativ zum stärksten Kapitel.
  figurenPresenceCellVars(hae, maxCell) {
    if (!hae || !maxCell) return {};
    const t = Math.min(1, 0.12 + 0.6 * (hae / maxCell));
    return { '--heatmap-t': Math.round(t * 100) + '%' };
  },

  figurenPresenceSharePct(share) { return Math.round((share || 0) * 100); },

  figurenPresenceJumpToChapter(name) { if (name) window.__app.openKapitelByName(name); },

  // Befund-Zeile als lokalisierter Klartext (x-text-sicher, kein x-html).
  figurenPresenceFindingText(fd) {
    const t = (k, p) => window.__app.t(k, p);
    switch (fd.kind) {
      case 'gap':          return t('figuren.presence.finding.gap', { name: fd.figName, len: fd.len, from: fd.fromChapter, to: fd.toChapter });
      case 'lateEntrance': return t('figuren.presence.finding.lateEntrance', { name: fd.figName, chapter: fd.chapter });
      case 'earlyExit':    return t('figuren.presence.finding.earlyExit', { name: fd.figName, chapter: fd.chapter });
      case 'flatArc':      return t('figuren.presence.finding.flatArc', { name: fd.figName });
      case 'coPresenceGap':return t('figuren.presence.finding.coPresenceGap', { name: fd.figName, other: fd.otherName });
      default:             return '';
    }
  },
};
