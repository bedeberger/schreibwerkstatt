// Alpine.data('plotCard') — Sub-Komponente für die Plot-Werkstatt (Beat-Board).
// Buchebenen-Karte (exklusiv): Akte (Spalten) + Beats (Karten) + zwei KI-Jobs
// (Brainstorm, Consistency). Fachdaten leben lokal in der Karte (nicht im
// catalog-store), weil sie rein planend und nicht mit Figuren/Orten geteilt sind.

import { plotMethods } from '../book/plot.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';

export function registerPlotCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('plotCard', () => ({
    acts: [],
    beats: [],
    // Werkstatt-Figuren (draft_figures) des Buchs, fürs Beat-Picker + Badges.
    // Lokal in der Karte geladen (nicht im catalog-store — wie die Plot-Daten).
    draftFiguren: [],
    loading: false,
    busy: false,
    errorMessage: '',
    _memos: {},

    // O(1)-Lookup-Map id→Draft (gleiches Muster wie $app.figurenById): Getter
    // baut nur bei Referenz-Wechsel neu (loadBoard reassignt draftFiguren).
    get draftFigurenById() {
      if (this._draftFigMapRef !== this.draftFiguren) {
        this._draftFigMapRef = this.draftFiguren;
        this._draftFigMap = new Map((this.draftFiguren || []).map(d => [d.id, d]));
      }
      return this._draftFigMap;
    },

    // Filter (Kapitel / Figur / Werkstatt-Figur) — wie szenen/ereignisse; filtert
    // die Beats pro Akt-Spalte rein fürs Rendering (beatsForAct bleibt ungefiltert
    // für Drag&Drop + Order-Persistenz).
    plotFilters: { kapitel: '', figurId: '', draftFigurId: '' },

    // Beat-Edit / -Add
    editingBeatId: null,
    beatDraft: { titel: '', beschreibung: '', status: 'geplant', chapter_id: '', intensitaet: null, figure_ids: [], draft_figure_ids: [] },
    addingActId: null,
    newBeatTitel: '',

    // Akt-Edit / -Add / -Farbe
    editingActId: null,
    actDraft: '',
    addingAct: false,
    newActName: '',
    actColorPickerId: null,

    // Eingeklappte „verworfen"-Beats pro Akt ({ [actId]: true }).
    verworfenOpen: {},

    // Spannungsbogen ein-/ausgeklappt (nur sichtbar, wenn ≥2 Beats Intensität tragen).
    tensionOpen: true,

    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // horizontaler Platz fürs Akt-Board. Toggle in plotMethods.togglePlotFullscreen.
    plotFullscreen: false,

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

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      // $root = die Karten-Wurzel (.card--plot), unabhängig vom Klick-Kontext.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.plotFullscreen = active; },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...plotMethods,
  }));
}
