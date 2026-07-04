// Card-Getter fuer die neueren „Meine Statistik"-Kacheln — in myStatsCard
// gespreadet (`...myStatsTrendMethods`). Ausgelagert, damit my-stats-card.js
// unter dem 600-LOC-Cap bleibt. Zugriff auf Card-State via `this` (Spread teilt
// den Alpine-Scope): this._memo, this.myStatsWindow(), this.myStatsHistory,
// this.myStatsWriting, this.myStatsSessions, this.myStatsBookGoals().
import { localIsoDate } from '../utils.js';
import { filterByWindow } from './my-stats-compute.js';
import { computePeriodComparison, computeSessionStats,
         computeOverallForecast, computeVocabTrend } from './my-stats-trends.js';

export const myStatsTrendMethods = {
  // ── Vorperioden-Vergleich (nur bei aktivem, nach vorne begrenztem Zeitraum) ──
  // Vergleicht den aktiven Zeitraum mit der gleich langen Periode davor. Braucht
  // ein gesetztes `from`; ein offenes `to` faellt auf heute zurueck.
  myStatsPeriodComparison() {
    const w = this.myStatsWindow();
    const from = w.from;
    const to = w.to || localIsoDate();
    if (!w.active || !from) return { available: false };
    return this._memo('periodCmp', [this.myStatsHistory, this.myStatsWriting, from, to], () =>
      computePeriodComparison(this.myStatsHistory, this.myStatsWriting, from, to));
  },
  get myStatsHasPeriodCmp() { return this.myStatsPeriodComparison().available; },
  // Delta als Anzeige-Text: Prozent, wenn eine Vergleichsbasis existiert; sonst
  // der absolute Zuwachs mit Vorzeichen (Vorperiode war leer → % waere sinnlos).
  myStatsCmpText(d) {
    if (!d) return '';
    if (d.pct == null) return (d.delta > 0 ? '+' : '') + this._myStatsFmt(d.delta);
    return (d.pct > 0 ? '+' : '') + d.pct + '%';
  },

  // ── Session-Kennzahlen (zeitraum-bewusst; Filter auf das Session-Startdatum) ──
  _winSessions() {
    const w = this.myStatsWindow();
    return this._memo('winSessions', [this.myStatsSessions, w.from, w.to], () =>
      filterByWindow(this.myStatsSessions, 'date', w.from, w.to));
  },
  myStatsSessionStats() {
    const win = this._winSessions();
    return this._memo('sessionStats', [win], () => computeSessionStats(win));
  },
  get myStatsHasSessions() { return this.myStatsSessionStats().hasData; },

  // ── Gesamt-Prognose ueber alle Buecher mit offenem Gesamtziel (Lifetime) ──────
  myStatsOverallForecast() {
    const goals = this.myStatsBookGoals();
    return this._memo('overallForecast', [goals], () => computeOverallForecast(goals));
  },
  get myStatsHasOverallForecast() { return this.myStatsOverallForecast().hasData; },
  myStatsOverallForecastLabel() {
    const f = this.myStatsOverallForecast();
    const t = window.__app.t;
    if (!f.hasData) return '';
    if (f.stalled) return t('mystats.overallForecast.stalled', { n: this._myStatsFmt(f.booksOpen) });
    return t('mystats.overallForecast.eta', { n: this._myStatsFmt(f.booksOpen), date: this.myStatsDateLabel(f.forecastDate) });
  },

  // ── Streak-Heatmap-Zellenklasse je Modus ─────────────────────────────────────
  // 'activity' faerbt nach Schreibminuten-Quartil (level 0..4). 'goal' faerbt
  // binaer gegen das Tagesziel: erreicht (goal-hit) / aktiv-aber-verfehlt
  // (goal-miss) / inaktiv (lvl0). Zukunftszellen bleiben ausgegraut.
  myStatsStreakCellClass(cell) {
    if (!cell) return 'overview-streak-cell--empty';
    if (cell.future) return 'overview-streak-cell--future';
    if (this.myStatsStreakMode === 'goal' && this.myStatsHasGoal) {
      if (!cell.active) return 'overview-streak-cell--lvl0';
      const goalMin = this.myStatsGoal().goalMinutes || 0;
      return (cell.minutes || 0) >= goalMin ? 'overview-streak-cell--goal-hit' : 'overview-streak-cell--goal-miss';
    }
    return 'overview-streak-cell--lvl' + cell.level;
  },

  // ── Wortschatz-Trend (Lifetime, analog Lesbarkeit) ───────────────────────────
  myStatsVocabTrend() {
    return this._memo('vocabTrend', [this.myStatsHistory], () => computeVocabTrend(this.myStatsHistory));
  },
  get myStatsHasVocab() { return this.myStatsVocabTrend().hasData; },
};
