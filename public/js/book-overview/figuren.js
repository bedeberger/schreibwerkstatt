// Figuren-Tile: Count + Top-Liste + Präsenz-Matrix.
// Datenquelle: overviewSzenen.fig_ids (gleiche Quelle wie Sidebar-Auflistung).
// figuren[].kapitel.haeufigkeit zählt nur namentliche Treffer und unterzählt
// Hauptfiguren bei pronomenlastigen Texten systematisch — daher hier nicht
// als Ranking-Quelle verwendet.
export const figurenMethods = {
  overviewFigurenCount() { return (this.overviewFiguren || []).length; },

  // Top-6 Figuren nach Szenen-Präsenz.
  overviewTopFiguren() {
    const figs = this.overviewFiguren || [];
    const sz = this.overviewSzenen || [];
    return this._memo('topFiguren', [figs, sz], () => {
      const totals = new Map();
      for (const s of sz) {
        if (!Array.isArray(s.fig_ids)) continue;
        for (const fid of s.fig_ids) totals.set(fid, (totals.get(fid) || 0) + 1);
      }
      return figs
        .map(f => ({
          id: f.id,
          name: f.name,
          kurzname: f.kurzname,
          rolle: f.rolle || null,
          mentions: totals.get(f.id) || 0,
        }))
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, 6);
    });
  },

  // Figuren-Präsenz-Matrix: Kapitel (Zeilen) × Top-Figuren (Spalten).
  // Cell-Wert = Anzahl Szenen, in denen die Figur im Kapitel auftritt
  // (gezählt aus overviewSzenen.fig_ids). Auswahl: Top-MAX_COLS Figuren nach
  // Gesamt-Szenen. Match Kapitel primär per chapter_id (stabil), Fallback
  // auf Name. Skalierung global über alle Cells.
  overviewFigurePresence() {
    const figs = this.overviewFiguren || [];
    const sz = this.overviewSzenen || [];
    const tree = window.__app?.tree || [];
    return this._memo('figPresence', [figs, sz, tree],
      () => this._computeFigurePresence(figs, sz));
  },

  _computeFigurePresence(figs, sz) {
    const empty = { figures: [], rows: [] };
    const app = window.__app;
    if (!app || figs.length === 0 || sz.length === 0) return empty;
    const tree = app.tree || [];
    // Solo-Wrapper (Spezialseiten ohne Kapitel) ausklammern — sie sind in tree
    // als type:'chapter' mit solo:true verpackt (siehe tree.js loadPages).
    const chapters = tree
      .filter(i => i.type === 'chapter' && !i.solo)
      .map(c => ({ id: c.id, name: c.name }));
    if (chapters.length === 0) return empty;

    const MAX_COLS = 20;

    const figByFigId = new Map();
    for (const f of figs) figByFigId.set(f.id, f);

    // Spezialseiten ohne Kapitel ausklammern: Figuren, die nur dort auftreten,
    // dürfen weder Top-N-Selektion noch Matrix-Skalierung beeinflussen.
    const chapterIds = new Set(chapters.map(c => Number(c.id)));
    const chapterNames = new Set(chapters.map(c => c.name));

    const counts = new Map(); // fig_id -> { byId, byName, total }
    for (const s of sz) {
      if (!Array.isArray(s.fig_ids) || s.fig_ids.length === 0) continue;
      const chapId = s.chapter_id ?? null;
      const chapName = s.kapitel || '';
      const inChapter = (chapId != null && chapterIds.has(Number(chapId)))
                     || (chapName && chapterNames.has(chapName));
      if (!inChapter) continue;
      for (const figId of s.fig_ids) {
        let m = counts.get(figId);
        if (!m) { m = { byId: new Map(), byName: new Map(), total: 0 }; counts.set(figId, m); }
        if (chapId != null) m.byId.set(Number(chapId), (m.byId.get(Number(chapId)) || 0) + 1);
        if (chapName) m.byName.set(chapName, (m.byName.get(chapName) || 0) + 1);
        m.total++;
      }
    }

    const lookup = (m, ch) => m.byId.get(Number(ch.id)) ?? m.byName.get(ch.name) ?? 0;

    const candidates = [];
    for (const [figId, m] of counts) {
      const f = figByFigId.get(figId);
      if (!f) continue;
      candidates.push({ id: figId, name: f.kurzname || f.name, m, total: m.total });
    }
    candidates.sort((a, b) => b.total - a.total);
    if (candidates.length === 0) return empty;

    const selected = candidates.slice(0, MAX_COLS);

    const figures = selected.map(c => ({ id: c.id, name: c.name }));
    // Globaler Max über alle Cells: einziger Skala-Bezug. Spalten-Normierung
    // verworfen, weil Figuren oft nur in 1 Kapitel auftauchen → col-pct 100 %
    // selbst bei Wert 1, wodurch sparse Cells fälschlich „voll" wirkten.
    let globalMax = 0;
    for (const c of selected) {
      for (const ch of chapters) {
        const v = lookup(c.m, ch);
        if (v > globalMax) globalMax = v;
      }
    }
    globalMax = Math.max(1, globalMax);

    const rows = chapters.map(ch => ({
      id: ch.id,
      name: ch.name,
      cells: selected.map((c) => {
        const v = lookup(c.m, ch);
        return {
          figureId: c.id,
          figureName: c.name,
          value: v,
          pct: v > 0 ? Math.max(8, Math.round((v / globalMax) * 100)) : 0,
        };
      }),
    }));
    return { figures, rows };
  },
};
