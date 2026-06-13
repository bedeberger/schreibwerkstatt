// Alpine.data('plotCard') — Sub-Komponente für die Plot-Werkstatt (Beat-Board).
// Buchebenen-Karte (exklusiv): Akte (Spalten) + Beats (Karten) + zwei KI-Jobs
// (Brainstorm, Consistency). Fachdaten leben lokal in der Karte (nicht im
// catalog-store), weil sie rein planend und nicht mit Figuren/Orten geteilt sind.

import { plotMethods } from '../book/plot.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerPlotCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('plotCard', () => ({
    acts: [],
    beats: [],
    loading: false,
    busy: false,
    errorMessage: '',
    _memos: {},

    // Filter (Kapitel / Figur) — wie szenen/ereignisse; filtert die Beats pro
    // Akt-Spalte rein fürs Rendering (beatsForAct bleibt ungefiltert für
    // Drag&Drop + Order-Persistenz).
    plotFilters: { kapitel: '', figurId: '' },

    // Beat-Edit / -Add
    editingBeatId: null,
    beatDraft: { titel: '', beschreibung: '', status: 'geplant', chapter_id: '', figure_ids: [] },
    addingActId: null,
    newBeatTitel: '',

    // Akt-Edit / -Add
    editingActId: null,
    actDraft: '',
    addingAct: false,
    newActName: '',

    // Drag & Drop
    _dragBeatId: null,
    _dragOverActId: null,

    // KI: Brainstorm
    brainstormActId: null,
    brainstormLoading: false,
    brainstormStatus: '',
    brainstormProgress: 0,
    brainstormResult: null,
    _brainstormJobId: null,
    _brainstormPollTimer: null,

    // KI: Consistency
    consistencyLoading: false,
    consistencyStatus: '',
    consistencyProgress: 0,
    consistencyResult: null,
    selectedKonfliktIdx: null,
    _consistencyJobId: null,
    _consistencyPollTimer: null,

    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'plot',
        showFlag: 'showPlotCard',
        timerKeys: ['_brainstormPollTimer', '_consistencyPollTimer'],
        onShow: () => this.loadBoard(),
        onBookChanged: () => {
          this.resetPlot();
          if (window.__app.showPlotCard && window.__app.selectedBookId) this.loadBoard();
        },
        onViewReset: () => this.resetPlot(),
        onCardRefresh: () => this.loadBoard(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...plotMethods,
  }));
}
