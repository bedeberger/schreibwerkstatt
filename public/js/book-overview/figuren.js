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
      const ranked = figs
        .map(f => ({
          id: f.id,
          name: f.name,
          kurzname: f.kurzname,
          rolle: f.rolle || null,
          mentions: totals.get(f.id) || 0,
        }))
        .sort((a, b) => b.mentions - a.mentions);
      // Bevorzugt Figuren mit mehreren Szenen; Einmal-Auftritte nur als Fallback,
      // falls keine Figur mehrfach vorkommt (analog Orte-Tile).
      const recurring = ranked.filter(f => f.mentions >= 2);
      const base = recurring.length ? recurring : ranked;
      return base.slice(0, 6);
    });
  },

  // Figuren-Präsenz-Matrix: Kapitel (Zeilen) × Top-Figuren (Spalten).
  // Cell-Wert = Anzahl Szenen, in denen die Figur im Kapitel auftritt
  // (gezählt aus overviewSzenen.fig_ids). Auswahl: Top-MAX_COLS Figuren nach
  // Gesamt-Szenen, bevorzugt mehrfach auftretende (total >= 2); Einmal-Auftritte
  // nur als Fallback. Match Kapitel primär per chapter_id (stabil), Fallback
  // auf Name. Skalierung global über alle Cells.
  overviewFigurePresence() {
    const figs = this.overviewFiguren || [];
    const sz = this.overviewSzenen || [];
    const tree = Alpine.store('nav').tree || [];
    return this._memo('figPresence', [figs, sz, tree],
      () => this._computeFigurePresence(figs, sz));
  },

  _computeFigurePresence(figs, sz) {
    const empty = { figures: [], rows: [] };
    const app = window.__app;
    if (!app || figs.length === 0 || sz.length === 0) return empty;
    // Sub-Kapitel werden auf ihr Wurzel-Kapitel aggregiert — Szenen-Counts
    // landen im Root-Bucket via rootOf(s.chapter_id) bzw. rootOfName(s.kapitel).
    const { roots, rootOf, rootOfName } = this._chapterRollup();
    const chapters = roots.map(c => ({ id: c.id, name: c.name }));
    if (chapters.length === 0) return empty;

    const MAX_COLS = 20;

    const figByFigId = new Map();
    for (const f of figs) figByFigId.set(f.id, f);

    const counts = new Map(); // fig_id -> { byRootId, total }
    for (const s of sz) {
      if (!Array.isArray(s.fig_ids) || s.fig_ids.length === 0) continue;
      const root = (s.chapter_id != null ? rootOf(s.chapter_id) : null)
                 || rootOfName(s.kapitel);
      if (!root) continue;
      const rid = Number(root.id);
      for (const figId of s.fig_ids) {
        let m = counts.get(figId);
        if (!m) { m = { byRootId: new Map(), total: 0 }; counts.set(figId, m); }
        m.byRootId.set(rid, (m.byRootId.get(rid) || 0) + 1);
        m.total++;
      }
    }

    const lookup = (m, ch) => m.byRootId.get(Number(ch.id)) ?? 0;

    const candidates = [];
    for (const [figId, m] of counts) {
      const f = figByFigId.get(figId);
      if (!f) continue;
      candidates.push({ id: figId, name: f.kurzname || f.name, m, total: m.total });
    }
    candidates.sort((a, b) => b.total - a.total);
    if (candidates.length === 0) return empty;

    // Nur mehrfach auftretende Figuren in die Matrix. Einmal-Szenen-Statisten
    // würden die Spalten sonst auffüllen und die wiederkehrenden Figuren optisch
    // verdrängen. Fallback auf alle, falls keine Figur mehrfach vorkommt.
    const recurring = candidates.filter(c => c.total >= 2);
    const selected = (recurring.length ? recurring : candidates).slice(0, MAX_COLS);

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
