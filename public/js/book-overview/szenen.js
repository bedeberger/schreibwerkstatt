// Szenen-Tile: Count + Stacked-Bar Wertungs-Verteilung.
export const szenenMethods = {
  overviewSzenenCount() { return (this.overviewSzenen || []).length; },

  overviewSzenenWertung() {
    const sz = this.overviewSzenen || [];
    return this._memo('szenenWertung', [sz], () => {
      const out = { stark: 0, mittel: 0, schwach: 0, ohne: 0 };
      for (const s of sz) {
        if (s.wertung === 'stark') out.stark++;
        else if (s.wertung === 'mittel') out.mittel++;
        else if (s.wertung === 'schwach') out.schwach++;
        else out.ohne++;
      }
      return out;
    });
  },
};
