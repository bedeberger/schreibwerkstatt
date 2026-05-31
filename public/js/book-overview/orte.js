// Schauplatz-Tile: Count + Top-Liste + Präsenz-Matrix.
// Datenquelle: /locations/:book_id liefert pro Ort `kapitel: [{name, haeufigkeit}]`
// (sortiert haeufigkeit desc) und `figuren: [fig_id]`. Kein Geo, keine Koordinaten.
// Ranking: Summe der Kapitel-Häufigkeiten = Gesamt-Präsenz im Buch. Bevorzugt
// mehrfach erwähnte Schauplätze (total >= 2); Einmal-Nennungen nur als Fallback.
export const orteMethods = {
  overviewOrteCount() { return (this.overviewOrte || []).length; },

  overviewTopOrte() {
    const orte = this.overviewOrte || [];
    return this._memo('topOrte', [orte], () => {
      const ranked = orte
        .map(o => {
          const kap = Array.isArray(o.kapitel) ? o.kapitel : [];
          const total = kap.reduce((s, k) => s + (Number(k.haeufigkeit) || 0), 0);
          return { id: o.id, name: o.name, typ: o.typ || 'andere', total };
        })
        .sort((a, b) => b.total - a.total);
      // Bevorzugt mehrfach erwähnte Schauplätze. Einmal-Nennungen (häufig alle aus
      // einem einzelnen Kapitel) verdrängen sonst die wiederkehrenden Orte. Fallback
      // auf die alte Schwelle, falls kein Ort mehrfach vorkommt (z. B. dünne Daten).
      const recurring = ranked.filter(o => o.total >= 2);
      const base = recurring.length ? recurring : ranked.filter(o => o.total > 0 || orte.length <= 6);
      return base.slice(0, 6);
    });
  },

  // Schauplatz-Präsenz-Matrix: Kapitel (Zeilen) × Top-Schauplätze (Spalten).
  // Cell-Wert = location_chapters.haeufigkeit. Match primär per chapter_id
  // (stabil), Fallback auf chapter_name (Backfill-Lücken: alte Einträge ohne
  // aufgelöste ID). Skalierung global über alle Cells.
  overviewOrtPresence() {
    const orte = this.overviewOrte || [];
    const tree = window.__app?.tree || [];
    return this._memo('ortPresence', [orte, tree], () => {
      const empty = { places: [], rows: [] };
      const app = window.__app;
      if (!app || orte.length === 0) return empty;
      // Sub-Kapitel werden auf ihr Wurzel-Kapitel aggregiert — kapitel-rows
      // landen via rootOf bzw. rootOfName im Root-Bucket.
      const { roots, rootOf, rootOfName } = this._chapterRollup();
      const chapters = roots.map(c => ({ id: c.id, name: c.name }));
      if (chapters.length === 0) return empty;

      const MAX_COLS = 20;

      const candidates = orte.map(o => {
        const kap = Array.isArray(o.kapitel) ? o.kapitel : [];
        const byRootId = new Map();
        for (const k of kap) {
          const h = Number(k?.haeufigkeit) || 0;
          if (h <= 0) continue;
          const root = (k?.chapter_id != null ? rootOf(k.chapter_id) : null)
                     || rootOfName(k?.name);
          if (!root) continue;
          const rid = Number(root.id);
          byRootId.set(rid, (byRootId.get(rid) || 0) + h);
        }
        let total = 0;
        for (const v of byRootId.values()) total += v;
        return { id: o.id, name: o.name, typ: o.typ || 'andere', byRootId, total };
      }).filter(c => c.total > 0);

      if (candidates.length === 0) return empty;
      candidates.sort((a, b) => b.total - a.total);
      // Nur mehrfach erwähnte Schauplätze in die Matrix. Einmal-Nennungen aus einem
      // einzelnen Kapitel würden die Top-Spalten sonst fluten und die wiederkehrenden
      // Orte verdrängen. Fallback auf alle, falls kein Ort mehrfach vorkommt.
      const recurring = candidates.filter(c => c.total >= 2);
      const selected = (recurring.length ? recurring : candidates).slice(0, MAX_COLS);

      const lookup = (c, ch) => c.byRootId.get(Number(ch.id)) ?? 0;

      const places = selected.map(c => ({ id: c.id, name: c.name, typ: c.typ }));
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
            ortId: c.id,
            ortName: c.name,
            value: v,
            pct: v > 0 ? Math.max(8, Math.round((v / globalMax) * 100)) : 0,
          };
        }),
      }));
      return { places, rows };
    });
  },
};
