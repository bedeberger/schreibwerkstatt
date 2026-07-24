// Motiv-Tile: Ist-Präsenz-Matrix Kapitel × Motiv.
// Datenquelle: /motifs?book_id → { motifs: [{ id, name, occChapters:[{chapterId,n}] }] }.
// occChapters ist die Kapitel-Aufschlüsselung der KI-erkannten Fundstellen (Ist,
// score-floor-gefiltert serverseitig, page+scene → chapter_id), das Pendant zum
// kapitel-Breakdown der Orte. Zeigt, welche Motive das Buch tatsächlich
// durchziehen und wo sie fehlen — rein rückwärtsgewandt, kein KI-Job hier.
export const motivMethods = {
  // Motiv-Präsenz-Matrix: Kapitel (Zeilen) × Top-Motive (Spalten).
  // Cell-Wert = Anzahl Ist-Fundstellen des Motivs im (Wurzel-)Kapitel. Auswahl:
  // Top-MAX_COLS Motive nach Gesamt-Fundstellen, bevorzugt mehrfach belegte
  // (total >= 2); Einmal-Treffer nur als Fallback. Match Kapitel primär per
  // chapter_id (stabil), Sub-Kapitel auf Wurzel-Kapitel aggregiert. Skalierung
  // global über alle Cells (wie Figuren/Orte-Matrix).
  overviewMotifPresence() {
    const motifs = this.overviewMotifs?.motifs || [];
    const tree = Alpine.store('nav').tree || [];
    return this._memo('motifPresence', [motifs, tree],
      () => this._computeMotifPresence(motifs));
  },

  _computeMotifPresence(motifs) {
    const empty = { motifs: [], rows: [] };
    const app = window.__app;
    if (!app || motifs.length === 0) return empty;
    const { roots, rootOf } = this._chapterRollup();
    const chapters = roots.map(c => ({ id: c.id, name: c.name }));
    if (chapters.length === 0) return empty;

    const MAX_COLS = 20;

    const candidates = motifs.map(m => {
      const occCh = Array.isArray(m.occChapters) ? m.occChapters : [];
      const byRootId = new Map();
      for (const oc of occCh) {
        const n = Number(oc?.n) || 0;
        if (n <= 0) continue;
        const root = oc?.chapterId != null ? rootOf(oc.chapterId) : null;
        if (!root) continue;
        const rid = Number(root.id);
        byRootId.set(rid, (byRootId.get(rid) || 0) + n);
      }
      let total = 0;
      for (const v of byRootId.values()) total += v;
      return { id: m.id, name: m.name, byRootId, total };
    }).filter(c => c.total > 0);

    if (candidates.length === 0) return empty;
    candidates.sort((a, b) => b.total - a.total);
    // Nur mehrfach belegte Motive in die Matrix; Einmal-Treffer nur als Fallback
    // (analog Figuren/Orte). Sonst fluten sparse Motive die Top-Spalten.
    const recurring = candidates.filter(c => c.total >= 2);
    const selected = (recurring.length ? recurring : candidates).slice(0, MAX_COLS);

    const lookup = (c, ch) => c.byRootId.get(Number(ch.id)) ?? 0;

    const cols = selected.map(c => ({ id: c.id, name: c.name }));
    let globalMax = 0;
    for (const c of selected) {
      for (const ch of chapters) {
        const v = lookup(c, ch);
        if (v > globalMax) globalMax = v;
      }
    }
    globalMax = Math.max(1, globalMax);

    const rows = chapters.map(ch => ({
      id: ch.id,
      name: ch.name,
      cells: selected.map((c) => {
        const v = lookup(c, ch);
        return {
          motifId: c.id,
          motifName: c.name,
          value: v,
          pct: v > 0 ? Math.max(8, Math.round((v / globalMax) * 100)) : 0,
        };
      }),
    }));
    return { motifs: cols, rows };
  },
};
