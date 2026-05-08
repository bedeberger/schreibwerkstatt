// Bewertungs-Tile: 6 Sterne + Trend-Pfeil zur Vorbewertung.
export const reviewMethods = {
  // Sterne-Rendering: gesamtnote 0..6, Score in halbe Sterne aufgelöst.
  overviewStars(score) {
    const s = Math.max(0, Math.min(6, Number(score) || 0));
    const out = [];
    for (let i = 1; i <= 6; i++) {
      if (s >= i) out.push({ full: true });
      else if (s >= i - 0.5) out.push({ half: true });
      else out.push({ empty: true });
    }
    return out;
  },

  // ARIA-Label nur wenn `gesamtnote` numerisch — sonst kein Label (statt "– / 6").
  overviewStarsAriaLabel() {
    const n = Number(this.overviewLastReview?.review_json?.gesamtnote);
    return Number.isFinite(n) ? `${n} / 6` : null;
  },

  // Trend zur Vorbewertung: Delta in Sternen (für Pfeil ↑/↓).
  // Null bei keiner Vorbewertung ODER bei Gleichstand.
  overviewReviewTrend() {
    const cur = Number(this.overviewLastReview?.review_json?.gesamtnote);
    const prev = Number(this.overviewPrevReview?.review_json?.gesamtnote);
    if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
    const delta = cur - prev;
    if (Math.abs(delta) < 0.05) return null;
    return { dir: delta > 0 ? 'up' : 'down', delta: Math.round(delta * 10) / 10 };
  },

  // Fertig formatierter Trend-String (statt Triple-Ternary im Template).
  // up: "↑ +0.5", down: "↓ 0.5". `null` wenn kein Trend → x-show greift.
  overviewReviewTrendDisplay() {
    const t = this.overviewReviewTrend();
    if (!t) return null;
    const arrow = t.dir === 'up' ? '↑ +' : '↓ ';
    return arrow + Math.abs(t.delta);
  },
};
