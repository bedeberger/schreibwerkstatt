// Lektorat-Coverage-Donut + Top-Fehler-Bars.
export const coverageMethods = {
  // Donut-Math für Coverage-Ring. Stroke-Dasharray-Approach: kein <path>-Arc nötig.
  // CIRC = 2π·r — 100% = vollständig sichtbarer Stroke.
  overviewCoverageRing() {
    const cov = this.overviewCoverage;
    return this._memo('coverageRing', [cov], () => {
      const pct = Math.max(0, Math.min(100, cov?.pct ?? 0));
      const r = 28;
      const c = 2 * Math.PI * r;
      return { r, c, dash: (pct / 100) * c, gap: c - (pct / 100) * c, pct };
    });
  },

  overviewTopFehler() {
    const heat = this.overviewHeat;
    return this._memo('topFehler', [heat], () => {
      const totals = heat?.totals || {};
      const arr = Object.entries(totals)
        .map(([typ, count]) => ({ typ, count }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      if (arr.length === 0) return arr;
      const max = arr[0].count;
      return arr.map(e => ({ ...e, pct: Math.max(8, Math.round((e.count / max) * 100)) }));
    });
  },
};
