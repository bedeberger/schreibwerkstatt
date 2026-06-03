// Alpine.data('tagebuchRueckblickCard') — Sub-Komponente des Tagebuch-Rückblicks.
// Nur bei Buchtyp 'tagebuch' (Gate via feature-registry requiresBuchtyp).
//
// Eigener State: rueckblickZeitraum, rueckblickResult, rueckblickEmpty,
//   rueckblickLoading, rueckblickProgress, rueckblickStatus, _rueckblickPollTimer.
// Root behält: showTagebuchRueckblickCard (Hash-Router + Exklusivität).
// Job-Polling/run/onVisible: createCardJobFeature. Struktur-Ergebnis wird in
// onDone gespeichert und im Partial via x-for/x-text gerendert (auto-escaped).

import { tagebuchRueckblickMethods } from '../book/tagebuch-rueckblick.js';
import { createCardJobFeature } from './job-feature-card.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerTagebuchRueckblickCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('tagebuchRueckblickCard', () => ({
    rueckblickZeitraum: '',
    rueckblickResult: null,
    rueckblickEmpty: false,
    rueckblickLoading: false,
    rueckblickProgress: 0,
    rueckblickStatus: '',
    rueckblickHistory: [],
    selectedRueckblickId: null,
    _rueckblickPollTimer: null,
    _lifecycle: null,

    init() {
      const onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'rueckblick') return;
        const job = d.job;
        this.rueckblickLoading = true;
        this.rueckblickProgress = job.progress || 0;
        this.rueckblickResult = null;
        this.rueckblickEmpty = false;
        this.rueckblickStatus = `<span class="spinner"></span>${window.__app.t(job.statusText || 'common.analysisRunning', job.statusParams)}`;
        this.startTagebuchRueckblickPoll(d.jobId);
      };

      // Zeitraum-Vorauswahl aus der Overview-Heatmap (warmer Fall: Karte offen).
      // Cold-Open läuft über pendingRueckblickZeitraum im onOpen-Hook.
      const onRueckblickSelect = (e) => {
        const z = e.detail?.zeitraum;
        if (!z || !window.__app.showTagebuchRueckblickCard) return;
        this._applyRueckblickZeitraum(z);
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'tagebuchRueckblick',
        showFlag: 'showTagebuchRueckblickCard',
        timerKeys: ['_rueckblickPollTimer'],
        onShow: () => this._onVisibleRueckblick(),
        resetState: {
          rueckblickResult: null,
          rueckblickEmpty: false,
          rueckblickLoading: false,
          rueckblickProgress: 0,
          rueckblickStatus: '',
          rueckblickHistory: [],
          selectedRueckblickId: null,
        },
        extraListeners: [
          { type: 'job:reconnect', handler: onJobReconnect },
          { type: 'rueckblick:select', handler: onRueckblickSelect },
        ],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...tagebuchRueckblickMethods,

    ...createCardJobFeature({
      name: 'rueckblick',
      endpoint: '/jobs/rueckblick',
      timerProp: '_rueckblickPollTimer',
      methodNames: {
        start:     'startTagebuchRueckblickPoll',
        run:       'runTagebuchRueckblick',
        onVisible: '_onVisibleRueckblick',
      },
      fields: {
        show:     'showTagebuchRueckblickCard',
        loading:  'rueckblickLoading',
        progress: 'rueckblickProgress',
        status:   'rueckblickStatus',
      },
      lsKey: (bookId, self) => `rueckblick_job_${bookId}_${self.rueckblickZeitraum}`,
      i18n: {
        starting:       'rueckblick.starting',
        interrupted:    'job.interrupted',
        alreadyRunning: 'common.analysisAlreadyRunning',
      },
      progressResetDelay: 400,
      beforeRun() {
        this.rueckblickResult = null;
        this.rueckblickEmpty = false;
      },
      buildPayload() {
        return {
          book_id: parseInt(window.__app.selectedBookId),
          zeitraum: this.rueckblickZeitraum,
        };
      },
      async onDone(job) {
        if (job.result?.empty) {
          this.rueckblickResult = null;
          this.rueckblickEmpty = true;
          this.rueckblickStatus = '';
          return;
        }
        this.rueckblickResult = job.result?.rueckblick || null;
        this.rueckblickEmpty = false;
        this.rueckblickStatus = '';
        this.selectedRueckblickId = null;
        // History wurde serverseitig fortgeschrieben → Liste aktualisieren.
        await this.loadRueckblickHistory();
      },
      async onOpen() {
        // Cold-Open via Overview-Heatmap: pending-Zeitraum übernehmen (gewinnt
        // vor dem Default). Sonst jüngster Monat als Default.
        const pending = window.__app.pendingRueckblickZeitraum;
        if (pending) { window.__app.pendingRueckblickZeitraum = null; this.rueckblickZeitraum = pending; }
        if (!this.rueckblickZeitraum) this.rueckblickZeitraum = this.defaultZeitraum();
        await this.loadRueckblickHistory();
        // Vorhandenen Rückblick fürs Pending-Zeitfenster zeigen (kein Auto-Run).
        if (pending) {
          const existing = (this.rueckblickHistory || []).find(en => en.zeitraum === pending);
          if (existing) this.openRueckblickHistory(existing);
        }
      },
    }),
  }));
}
