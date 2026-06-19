// Alpine.data('myStatsCard') — Sub-Komponente „Meine Statistik": aggregierte
// Schreib-Kennzahlen + Entwicklungs-Chart ueber ALLE eigenen Buecher
// (role='owner'). User-bound, nicht buch-bound — `showMyStatsCard` +
// `toggleMyStatsCard` leben im Root (generiert aus EXCLUSIVE_CARDS). Daten:
// `GET /me/profile-stats` (Tiles) + `GET /me/profile-stats-history` (Chart).

import { loadChart } from '../lazy-libs.js';
import { tzOpts } from '../utils.js';
import { computeWritingStreak, computeWeekdayPattern, computeDerived, computeMilestones } from './my-stats-compute.js';

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Chart-Metriken: content aus book_stats_history (Summe pro Tag), writing aus
// writing_time. Label-Keys werden zur Render-Zeit via t() aufgeloest (Locale-live).
const METRIC_KEYS = {
  chars:         'mystats.metric.chars',
  normseiten:    'mystats.metric.normseiten',
  words:         'mystats.metric.words',
  unique_words:  'mystats.metric.uniqueWords',
  page_count:    'mystats.metric.pages',
  chapter_count: 'mystats.metric.chapters',
  writing:       'mystats.metric.writing',
};

// Meilenstein-Label-Keys pro Kategorie (Wert via {n} interpoliert).
const MILESTONE_LABELS = {
  chars:      'mystats.milestone.chars',
  words:      'mystats.milestone.words',
  activeDays: 'mystats.milestone.activeDays',
  books:      'mystats.milestone.books',
};

// Farbpalette fuer Pro-Buch-Linien — mittlere Saettigung, lesbar auf Light+Dark.
const BOOK_COLORS = [
  '#5b6ee1', '#e08a3c', '#3fae6e', '#c45fa0',
  '#c9a93a', '#46a7bd', '#d05a5a', '#8f7ae0',
  '#6aaf4e', '#b06ad0', '#d98f5e', '#4e8fd0',
];

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
    myStatsChartMode: 'total', // 'total' | 'byBook'
    myStatsCumulative: false,  // nur fuer Metrik 'writing' (kumulierte Schreibzeit)
    myStatsLoading: false,
    myStatsError: '',
    _myStatsMemos: {},

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
      this._myStatsMemos = {};
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

    // Ein Memo-Helper pro Modul (CLAUDE.md): Aggregat-Getter werden im Template
    // mehrfach pro Render aufgerufen → Cache mit shallow-Array-Deps. Reset bei
    // jedem Daten-Reload via this._myStatsMemos = {} in loadMyStats().
    _memo(key, deps, fn) {
      const prev = this._myStatsMemos[key];
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
        return prev.val;
      }
      const val = fn();
      this._myStatsMemos[key] = { deps, val };
      return val;
    },

    // ── Schreibrhythmus (alle aus der writing-Zeitreihe) ───────────────────
    myStatsStreak() {
      return this._memo('streak', [this.myStatsWriting], () => computeWritingStreak(this.myStatsWriting));
    },
    myStatsWeekdays() {
      return this._memo('weekdays', [this.myStatsWriting], () => computeWeekdayPattern(this.myStatsWriting));
    },
    myStatsDerived() {
      return this._memo('derived', [this.myStatsData, this.myStatsWriting], () =>
        computeDerived(this.myStatsData, this.myStatsWriting));
    },
    myStatsMilestones() {
      return this._memo('milestones', [this.myStatsData, this.myStatsWriting], () =>
        computeMilestones(this.myStatsData, this.myStatsDerived()));
    },

    get myStatsHasRhythm() {
      return (this.myStatsWriting || []).length > 0;
    },

    // Wochentags-Kurzlabels Mo..So (Locale-aware, TZ-bereinigt).
    myStatsWeekdayLabels() {
      const tag = window.__app.uiLocale === 'en' ? 'en-US' : 'de-CH';
      const fmt = new Intl.DateTimeFormat(tag, tzOpts({ weekday: 'short' }));
      const monRef = new Date(2027, 0, 4); // 2027-01-04 ist ein Montag
      return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(monRef.getTime() + i * 86400000)));
    },

    // Datum eines Streak-/Bestleistungs-Tages lesbar formatieren.
    myStatsDateLabel(iso) {
      if (!iso) return '';
      const tag = window.__app.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return new Date(iso + 'T12:00:00').toLocaleDateString(tag, tzOpts({ day: 'numeric', month: 'short', year: 'numeric' }));
    },

    // Minuten kompakt: „2 h 10 min" / „45 min".
    myStatsMinFmt(min) {
      const total = Math.max(0, Math.round(Number(min) || 0));
      const h = Math.floor(total / 60), m = total % 60;
      const t = window.__app.t;
      return h > 0 ? t('mystats.hm', { h: this._myStatsFmt(h), m }) : t('mystats.m', { m });
    },

    myStatsMilestoneLabel(category, target) {
      return window.__app.t(MILESTONE_LABELS[category] || 'mystats.milestone.chars', { n: this._myStatsFmt(target) });
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

    // Buchname aus der bereits geladenen Root-Buchliste (id → name).
    _bookName(bookId) {
      const b = (window.__app.books || []).find(x => String(x.id) === String(bookId));
      return b?.name || (window.__app.t('mystats.unknownBook') + ' ' + bookId);
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
      const byBook = this.myStatsChartMode === 'byBook';

      // Quelle vereinheitlichen auf { book_id, date, raw }.
      const src = isWriting ? this.myStatsWriting : this.myStatsHistory;
      let rows = src.map(r => ({ book_id: r.book_id, date: r.recorded_at || r.date, raw: r }));
      if (!rows.length) return;

      if (this.myStatsRange > 0) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - this.myStatsRange);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        rows = rows.filter(r => r.date >= cutoffStr);
      }
      if (!rows.length) return;

      // Nur bis zum letzten vollständigen Sync zeigen: book_stats_history bekommt
      // pro Buch eine Tageszeile vom Nacht-Cron. Ein manueller Einzelbuch-Sync
      // mitten am Tag (oder ein noch ausstehender Nachtlauf) erzeugt sonst einen
      // Teil-Tages-Punkt mit weniger Büchern als der Vortag — als künstlicher
      // Einbruch sichtbar. Darum jüngste Tage abschneiden, solange ihre Buch-Zahl
      // unter der des Vortags liegt. Nur für Content-Historie — Schreibzeit ist
      // naturgemäss dünn (nur aktive Tage) und kennt kein „vollständiges" Tagesbild.
      if (!isWriting) {
        const allDates = [...new Set(rows.map(r => r.date))].sort();
        const booksOn = new Map();
        for (const r of rows) {
          if (!booksOn.has(r.date)) booksOn.set(r.date, new Set());
          booksOn.get(r.date).add(r.book_id);
        }
        let last = allDates.length - 1;
        while (last > 0 && booksOn.get(allDates[last]).size < booksOn.get(allDates[last - 1]).size) last--;
        const lastDate = allDates[last];
        rows = rows.filter(r => r.date <= lastDate);
      }

      const valOf = (raw) => {
        if (metric === 'normseiten') return Math.round(((Number(raw.chars) || 0) / 1500) * 10) / 10;
        if (isWriting)              return Math.round((Number(raw.seconds) || 0) / 60);
        return Number(raw[metric]) || 0;
      };

      // X-Achse = sortierte eindeutige Tage über alle Bücher.
      const dates = [...new Set(rows.map(r => r.date))].sort();
      const labels = dates.map(d => { const [y, m, dd] = d.split('-'); return `${dd}.${m}.${y.slice(2)}`; });

      const metricLabel = window.__app.t(METRIC_KEYS[metric] || metric);
      const localeTag = (window.__app.uiLocale === 'en') ? 'en-US' : 'de-CH';
      const isDecimal = metric === 'normseiten';
      const fmt = v => (v == null) ? '' : (isDecimal
        ? v.toLocaleString(localeTag, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : Math.round(v).toLocaleString(localeTag));

      const primary  = cssVar('--color-primary');
      const muted    = cssVar('--color-muted');
      const gridLine = cssVar('--color-border');

      let datasets;
      if (byBook) {
        // Eine Linie pro Buch (Reihenfolge nach erstem Auftreten = stabile Farbe).
        const order = [];
        const perBook = new Map(); // book_id → Map(date → value)
        for (const r of rows) {
          if (!perBook.has(r.book_id)) { perBook.set(r.book_id, new Map()); order.push(r.book_id); }
          perBook.get(r.book_id).set(r.date, valOf(r.raw));
        }
        datasets = order.map((bid, i) => {
          const color = BOOK_COLORS[i % BOOK_COLORS.length];
          const dmap = perBook.get(bid);
          return {
            label: this._bookName(bid),
            data: dates.map(d => dmap.has(d) ? dmap.get(d) : null),
            borderColor: color,
            backgroundColor: color,
            pointBackgroundColor: color,
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 5,
            fill: false,
            spanGaps: true,
          };
        });
      } else {
        // Gesamt: Summe pro Tag über alle Bücher.
        const sumByDate = new Map();
        for (const r of rows) sumByDate.set(r.date, (sumByDate.get(r.date) || 0) + valOf(r.raw));
        let series = dates.map(d => sumByDate.has(d) ? sumByDate.get(d) : 0);
        // Kumuliert nur fuer Schreibzeit sinnvoll (Tages-Deltas aufsummiert →
        // total investierte Zeit). Inhaltsmetriken sind bereits kumulative
        // Snapshot-Groessen, daher dort kein Cumulative-Toggle im UI.
        if (this.myStatsCumulative && isWriting) {
          let acc = 0;
          series = series.map(v => (acc += v));
        }
        datasets = [{
          label: metricLabel,
          data: series,
          borderColor: primary,
          backgroundColor: primary + '12',
          pointBackgroundColor: primary,
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 6,
          fill: true,
          spanGaps: false,
        }];
      }

      this._ensureThemeObserver();

      _chart = new window.Chart(canvas, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              display: byBook,
              position: 'bottom',
              labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 }, color: muted, usePointStyle: true },
            },
            tooltip: { callbacks: { label: ctx => ctx.parsed.y == null ? null : ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
          },
          scales: {
            x: { grid: { color: gridLine }, ticks: { font: { size: 11 }, color: muted, maxTicksLimit: 12 } },
            y: {
              grid: { color: gridLine },
              beginAtZero: isWriting || byBook,
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
