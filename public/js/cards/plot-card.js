// Alpine.data('plotCard') — Sub-Komponente für die Plot-Werkstatt (Beat-Board).
// Buchebenen-Karte (exklusiv): Akte (Spalten) + Beats (Karten) + zwei KI-Jobs
// (Brainstorm, Consistency). Fachdaten leben lokal in der Karte (nicht im
// catalog-store), weil sie rein planend und nicht mit Figuren/Orten geteilt sind.

import { plotMethods } from '../book/plot.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { loadSortable } from '../lazy-libs.js';
import { EVT } from '../events.js';

export function registerPlotCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('plotCard', () => ({
    acts: [],
    // Handlungsstränge (Swimlanes): optionale zweite Ordnungsachse. Leeres Array
    // = flaches Board (heutiges Verhalten). Pro Buch + User, lokal in der Karte.
    threads: [],
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

    // O(1)-Lookup-Map id→Strang (gleiches Referenz-Wechsel-Muster).
    get threadsById() {
      if (this._threadMapRef !== this.threads) {
        this._threadMapRef = this.threads;
        this._threadMap = new Map((this.threads || []).map(t => [t.id, t]));
      }
      return this._threadMap;
    },

    // Filter (Kapitel / Figur / Werkstatt-Figur) — wie szenen/ereignisse; filtert
    // die Beats pro Akt-Spalte rein fürs Rendering (beatsForAct bleibt ungefiltert
    // für Drag&Drop + Order-Persistenz).
    plotFilters: { kapitel: '', figurId: '', draftFigurId: '', status: '', text: '' },

    // Beat-Edit / -Add
    editingBeatId: null,
    beatDraft: { titel: '', beschreibung: '', status: 'geplant', chapter_id: '', intensitaet: null, figure_ids: [], draft_figure_ids: [] },
    addingActId: null,
    // Grid-Add-Beat: Zell-Schlüssel `${actId}:${threadId|null}` (statt addingActId).
    addingCell: null,
    newBeatTitel: '',

    // Akt-Edit / -Add / -Farbe
    editingActId: null,
    actDraft: '',
    addingAct: false,
    newActName: '',
    actColorPickerId: null,
    // Grid-Add-Akt-Scope: false = nicht im Add-Modus, null = geteilter Akt,
    // <threadId> = strang-eigener Akt (Hybrid). Eigene Variable neben `addingAct`
    // (flaches Board), weil das Grid scoped hinzufügt.
    addingActScope: false,

    // Strang-Edit / -Add / -Farbe (Swimlanes)
    editingThreadId: null,
    threadDraft: { name: '', farbe: null, figure_id: '', draft_figure_id: '' },
    addingThread: false,
    newThreadName: '',
    threadColorPickerId: null,
    // Mobile-only: ID der Lane, deren Aktions-Icons aufgeklappt sind (Kebab-Toggle,
    // Single-Select wie die Color-Picker-IDs). Desktop zeigt die Aktionen via CSS
    // immer; dort ist der Toggle ausgeblendet und dieser State unbenutzt.
    threadActionsOpenId: null,

    // Eingeklappte „verworfen"-Beats pro Akt ({ [actId]: true }).
    verworfenOpen: {},

    // Spannungsbogen-Figur-Fokus (Feature: Figurenbogen über die Kurve). Encodierter
    // Wert `c:<figId>` (Katalog) bzw. `w:<draftId>` (Werkstatt), '' = kein Fokus.
    // Hebt die Beats dieser Figur auf der Kurve hervor (Rest gedämpft).
    tensionFocusFigur: '',

    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // horizontaler Platz fürs Akt-Board. Toggle in plotMethods.togglePlotFullscreen.
    plotFullscreen: false,

    // Drag & Drop (SortableJS, eine Instanz pro Beat-Zelle — siehe book/plot/dnd.js).
    _sortables: [],
    _reattachQueued: false,
    // ID des gerade gezogenen Beats (von dnd.js#onBeatSortEnd gesetzt, von
    // beats.js#_dropBeat gelesen).
    _dragBeatId: null,

    // KI: Brainstorm
    brainstormActId: null,
    brainstormThreadId: null,
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

    // Konsistenz-Prüfungs-Historie (persistierte Läufe pro Buch). Klick auf einen
    // Eintrag lädt sein Result in das bestehende Consistency-Panel (selectedRunId).
    consistencyRuns: [],
    selectedRunId: null,

    // Brainstorm-Lauf-Historie (persistierte Läufe pro Buch, zusätzlich pro
    // Akt/Strang). Klick auf einen Eintrag lädt seine Vorschläge zurück in das
    // Inline-Panel des zugehörigen Akts/der Zelle (selectedBrainstormRunId).
    brainstormRuns: [],
    selectedBrainstormRunId: null,

    // Deep-Link-Ziel (#book/X/plot/<beatId>): gemerkt, bis das Board geladen ist.
    _pendingFocusBeatId: null,

    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'plot',
        showFlag: 'showPlotCard',
        timerKeys: ['_brainstormPollTimer', '_consistencyPollTimer'],
        // Sortable vor dem ersten Board-Render laden — _reattachSortables (via
        // loadBoard / $watch) bindet die Beat-Zellen, sobald window.Sortable da ist.
        onShow: async () => { await loadSortable(); await this.loadBoard(); },
        onBookChanged: () => {
          this._destroySortables();
          this.resetPlot();
          if (window.__app.showPlotCard && Alpine.store('nav').selectedBookId) this.loadBoard();
        },
        onViewReset: () => { this._destroySortables(); this.resetPlot(); },
        onCardRefresh: () => this.loadBoard(),
      });

      // Strukturelle Änderungen (Akt-/Strang-CRUD, Fork/Unfork, loadBoard-Reassign)
      // tauschen die Beat-Zell-Container im DOM → SortableJS muss neu binden.
      // Beat-only-Änderungen (Add/Delete/Drop) lassen die Container stehen und
      // brauchen kein Reattach. _scheduleReattach coalesct Mehrfach-Feuer pro Frame.
      this.$watch('acts', () => this._scheduleReattach());
      this.$watch('threads', () => this._scheduleReattach());

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      // $root = die Karten-Wurzel (.card--plot), unabhängig vom Klick-Kontext.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.plotFullscreen = active; },
      });

      // Deep-Link-Permalink #book/X/plot/<beatId>: Hash-Router dispatcht das Event;
      // _focusBeatById fokussiert den Beat (bzw. merkt ihn bis zum Board-Load vor).
      window.addEventListener(EVT.PLOT_FOCUS_BEAT, (e) => {
        this._focusBeatById(e.detail?.beatId);
      }, { signal: this._lifecycle.signal });

      // Cross-Feature: Navigation Werkstatt → Plot. Setzt den Werkstatt-Figur-Filter
      // (plotFilters überlebt den Board-Load, daher kein Parking nötig).
      window.addEventListener(EVT.PLOT_FILTER_DRAFT_FIGURE, (e) => {
        this.applyDraftFigureFilter(e.detail?.draftId);
      }, { signal: this._lifecycle.signal });
    },

    destroy() {
      this._destroySortables();
      this._lifecycle?.destroy();
    },

    ...plotMethods,
  }));
}
