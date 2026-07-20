// Motiv-Werkstatt — Alpine.data-Sub-Komponente (Themen & Motive als Konstellation).
// State explizit deklariert; Fachmethoden aus public/js/book/motiv.js gespreadet.
// Root-Zugriffe via window.__app (JS) bzw. $app (Template).

import { motivMethods } from '../book/motiv.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';

export function registerMotivCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('motivCard', () => ({
    // Daten (Graph-Payload)
    themes: [],
    motifs: [],
    relations: [],
    allBeats: [],
    allActs: [],
    // Werkstatt-Figuren (draft_figures) fürs Figuren-Verknüpfungs-Combobox (Gruppe „Plotwerkstatt")
    allDraftFiguren: [],
    // UI-Status
    loading: false,
    busy: false,
    errorMessage: '',
    // Auswahl + Fundstellen
    selectedMotifId: null,
    occurrences: [],
    occLoading: false,
    // Fundstellen-Sektion auf-/zugeklappt (pro Motiv in localStorage persistiert,
    // gesetzt bei jeder Auswahl in selectMotif; Default offen).
    occExpanded: true,
    // Edit-Puffer der Kern-Felder (Name/Thema/Beschreibung/Trigger) — explizit
    // gespeichert via Save/Cancel-Leiste, kein Feld-Autosave.
    editThemeId: '',
    editName: '',
    editBeschreibung: '',
    editTriggers: '',
    // Graph-Layer
    layerFigures: false,
    layerBeats: false,
    layerChapters: false,
    // Graph-Kontextmenü (Rechtsklick)
    graphMenuOpen: false,
    graphMenuNodeId: null,
    graphMenuPos: { top: 0, left: 0 },
    // Offener Thema-Farbwähler (Themen-Liste im Panel), null = keiner
    themeColorPickerId: null,
    // Eingabe-Drafts
    newThemeName: '',
    newMotifName: '',
    newMotifThemeId: '',
    newRelationTargetId: '',
    newRelationTyp: '',
    // Verknüpfungs-Combobox-Tempwerte (werden nach Auswahl geleert)
    linkFigTmp: '',
    linkBeatTmp: '',
    linkChapTmp: '',
    linkPageTmp: '',
    // Scan-Job
    scanning: false,
    scanProgress: 0,
    motivScanJobId: null,
    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // Platz für die Konstellation. Toggle in graphMethods.toggleMotivFullscreen.
    motivFullscreen: false,
    // Embedding-Index-Refresh (für semantische Erkennung)
    indexing: false,
    // Index in dieser Sitzung schon aktualisiert? Blendet den Refresh-Hinweis aus.
    indexRefreshed: false,
    // Brainstorm-Job (KI-Vorschläge)
    brainstorming: false,
    motivBrainstormJobId: null,
    suggestions: [],
    // interne (nicht-reaktive) Felder
    _beatsLoaded: false,
    _draftFigurenLoaded: false,
    _memos: {},
    _motivNetwork: null,
    _motivNodes: null,
    _motivEdges: null,
    _motivHash: '',
    _scanPollTimer: null,
    _brainstormPollTimer: null,
    _embedPollTimer: null,
    _layoutSaveTimer: null,
    // Persistiertes Knoten-Layout (node_id → {x,y}); aus loadBoard, beim Ziehen gespeichert.
    _savedPositions: null,
    _graphMenuCloseHandler: null,
    // SortableJS-Instanz der Themen-Liste (Reihenfolge per Drag)
    _themeSortable: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'motiv',
        showFlag: 'showMotivCard',
        timerKeys: ['_scanPollTimer', '_brainstormPollTimer', '_embedPollTimer', '_layoutSaveTimer'],
        onShow: () => this.loadBoard(),
        onBookChanged: () => {
          this.resetMotiv();
          if (window.__app.showMotivCard && this.$store.nav.selectedBookId) this.loadBoard();
        },
        onViewReset: () => this.resetMotiv(),
        onCardRefresh: () => this.loadBoard(),
      });

      // Auf-/Zuklappen der Fundstellen-Sektion pro Motiv persistieren.
      this.$watch('occExpanded', (v) => {
        if (this.selectedMotifId) this._persistOccExpanded(this.selectedMotifId, v);
      });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit) und den
      // vis-network-Graph auf die neue Containergrösse neu zeichnen.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.motivFullscreen = active;
          this.$nextTick(() => this._motivNetwork?.redraw());
        },
      });
    },

    destroy() {
      // Ausstehende Layout-Speicherung noch flushen, solange das Netzwerk lebt.
      if (this._layoutSaveTimer) { clearTimeout(this._layoutSaveTimer); this._layoutSaveTimer = null; this._saveLayout(); }
      this._detachGraphMenuListeners();
      this._destroyThemeSortable();
      this._destroyGraph();
      this._lifecycle?.destroy();
    },

    ...motivMethods,
  }));
}
