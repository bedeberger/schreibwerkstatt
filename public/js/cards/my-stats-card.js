// Alpine.data('myStatsCard') — Sub-Komponente „Meine Statistik": aggregierte
// Schreib-Kennzahlen + Entwicklungs-Chart ueber ALLE eigenen Buecher
// (role='owner'). User-bound, nicht buch-bound — `showMyStatsCard` +
// `toggleMyStatsCard` leben im Root (generiert aus EXCLUSIVE_CARDS). Daten:
// `GET /me/profile-stats` (Tiles) + `GET /me/profile-stats-history` (Chart).

import { loadChart } from '../lazy-libs.js';

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Chart-Metriken: content aus book_stats_history (Summe pro Tag), writing aus
// writing_time. Label-Keys werden zur Render-Zeit via t() aufgeloest (Locale-live).
const METRIC_KEYS = {
  chars:         'mystats.metric.chars',
  normseiten:    'mystats.metric.normseiten',
  words:         'mystats.metric.words',
  page_count:    'mystats.metric.pages',
  chapter_count: 'mystats.metric.chapters',
  writing:       'mystats.metric.writing',
};

// Chart.js-Instanz + Theme-Observer ausserhalb von Alpine halten, damit der
// Reaktivitaets-Proxy die Instanz nicht beschaedigt (analog bookstats.js).
let _chart = null;
let _themeObserver = null;

export function registerMyStatsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('myStatsCard', () => ({
    myStatsData: null,
    myStatsHistory: [],
    myStatsWriting: [],
    myStatsMetric: 'chars',
    myStatsRange: 0,
    myStatsLoading: false,
    myStatsError: '',

    init() {
      this.$watch(() => window.__app.showMyStatsCard, (visible) => {
        if (visible) this.loadMyStats();
        else this._destroyChart();
      });
      this._onRefresh = (ev) => {
        if (ev?.detail?.name === 'myStats') this.loadMyStats();
      };
      window.addEventListener('card:refresh', this._onRefresh);
    },

    destroy() {
      if (this._onRefresh) window.removeEventListener('card:refresh', this._onRefresh);
      this._destroyChart();
      if (_themeObserver) { _themeObserver.disconnect(); _themeObserver = null; }
    },

    async loadMyStats() {
      this.myStatsLoading = true;
      this.myStatsError = '';
      try {
        const [statsR, histR] = await Promise.all([
          fetch('/me/profile-stats', { credentials: 'same-origin' }),
          fetch('/me/profile-stats-history', { credentials: 'same-origin' }),
        ]);
        if (!statsR.ok) throw new Error('HTTP ' + statsR.status);
        this.myStatsData = await statsR.json();
        const hist = histR.ok ? await histR.json() : { history: [], writing: [] };
        this.myStatsHistory = Array.isArray(hist.history) ? hist.history : [];
        this.myStatsWriting = Array.isArray(hist.writing) ? hist.writing : [];
      } catch (e) {
        console.error('[myStats load]', e);
        this.myStatsError = window.__app.t('mystats.loadError');
        this.myStatsData = null;
        this.myStatsHistory = [];
        this.myStatsWriting = [];
      } finally {
        this.myStatsLoading = false;
      }
      // rAF in $nextTick: Canvas erst nach Layout-Pass vermessen (sonst 0×0).
      this.$nextTick(() => requestAnimationFrame(() => this.renderMyStatsChart()));
    },

    get myStatsHasChart() {
      return this.myStatsHistory.length > 0 || this.myStatsWriting.length > 0;
    },

    _destroyChart() {
      if (_chart) { _chart.destroy(); _chart = null; }
    },

    _ensureThemeObserver() {
      if (_themeObserver) return;
      _themeObserver = new MutationObserver(() => {
        if (!_chart || !window.__app.showMyStatsCard) return;
        _chart.destroy();
        _chart = null;
        this.renderMyStatsChart();
      });
      _themeObserver.observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-theme'],
      });
    },

    async renderMyStatsChart() {
      const canvas = document.getElementById('my-stats-chart');
      if (!canvas) return;
      if (typeof window.Chart === 'undefined') {
        try { await loadChart(); }
        catch (e) {
          const ph = document.createElement('div');
          ph.className = 'muted-msg muted-msg--block';
          ph.textContent = e.message;
          canvas.replaceWith(ph);
          return;
        }
      }
      // Immer frisch aufbauen (Update-Pfad liest keine neuen Canvas-Dimensionen).
      if (_chart) { _chart.destroy(); _chart = null; }

      const metric = this.myStatsMetric;
      const isWriting = metric === 'writing';
      let rows = isWriting
        ? this.myStatsWriting.map(d => ({ recorded_at: d.date, seconds: d.seconds }))
        : this.myStatsHistory;
      if (!rows.length) return;

      if (this.myStatsRange > 0) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - this.myStatsRange);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        rows = rows.filter(r => r.recorded_at >= cutoffStr);
      }
      if (!rows.length) return;

      let data;
      if (metric === 'normseiten') data = rows.map(r => Math.round(((Number(r.chars) || 0) / 1500) * 10) / 10);
      else if (isWriting)         data = rows.map(r => Math.round((Number(r.seconds) || 0) / 60));
      else                        data = rows.map(r => Number(r[metric]) || 0);

      const labels = rows.map(r => {
        const [y, m, d] = r.recorded_at.split('-');
        return `${d}.${m}.${y.slice(2)}`;
      });

      const metricLabel = window.__app.t(METRIC_KEYS[metric] || metric);
      const localeTag = (window.__app.uiLocale === 'en') ? 'en-US' : 'de-CH';
      const isDecimal = metric === 'normseiten';
      const fmt = v => isDecimal
        ? v.toLocaleString(localeTag, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : Math.round(v).toLocaleString(localeTag);

      const primary  = cssVar('--color-primary');
      const muted    = cssVar('--color-muted');
      const gridLine = cssVar('--color-border');

      this._ensureThemeObserver();

      _chart = new window.Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: metricLabel,
            data,
            borderColor: primary,
            backgroundColor: primary + '12',
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointBackgroundColor: primary,
            fill: true,
            spanGaps: false,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
          },
          scales: {
            x: { grid: { color: gridLine }, ticks: { font: { size: 11 }, color: muted } },
            y: {
              grid: { color: gridLine },
              beginAtZero: isWriting,
              ticks: {
                font: { size: 11 }, color: muted,
                callback: v => fmt(v),
                stepSize: (metric === 'page_count' || metric === 'chapter_count') ? 1 : undefined,
              },
            },
          },
        },
      });
    },

    // Locale-aware Tausender-Trennung (Swiss: de-CH = Apostroph).
    _myStatsFmt(n) {
      const loc = window.__app.uiLocale === 'de' ? 'de-CH' : 'en-US';
      return Number(n || 0).toLocaleString(loc);
    },

    // Normseite = 1500 Zeichen (primaere Umfangs-Kennzahl).
    myStatsNormpages() {
      return this._myStatsFmt(Math.round((this.myStatsData?.chars || 0) / 1500));
    },

    // Schreibzeit kompakt: „12 h 30 min" bzw. „45 min".
    myStatsWritingTime() {
      const total = Math.max(0, Math.round((this.myStatsData?.writing_seconds || 0) / 60));
      const h = Math.floor(total / 60);
      const m = total % 60;
      const t = window.__app.t;
      if (h > 0) return t('mystats.hm', { h: this._myStatsFmt(h), m });
      return t('mystats.m', { m });
    },

    get myStatsIsEmpty() {
      return !this.myStatsLoading && !this.myStatsError && (!this.myStatsData || this.myStatsData.books === 0);
    },
  }));
}
