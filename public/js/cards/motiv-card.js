// Motiv-Werkstatt — Alpine.data-Sub-Komponente (Themen & Motive als Konstellation).
// State explizit deklariert; Fachmethoden aus public/js/book/motiv.js gespreadet.
// Root-Zugriffe via window.__app (JS) bzw. $app (Template).

import { motivMethods } from '../book/motiv.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerMotivCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('motivCard', () => ({
    // Daten (Graph-Payload)
    themes: [],
    motifs: [],
    relations: [],
    allBeats: [],
    // UI-Status
    loading: false,
    busy: false,
    errorMessage: '',
    // Auswahl + Fundstellen
    selectedMotifId: null,
    occurrences: [],
    occLoading: false,
    editThemeId: '',
    // Graph-Layer
    layerFigures: false,
    layerBeats: false,
    layerChapters: false,
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
    // interne (nicht-reaktive) Felder
    _beatsLoaded: false,
    _memos: {},
    _motivNetwork: null,
    _motivNodes: null,
    _motivEdges: null,
    _motivHash: '',
    _scanPollTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'motiv',
        showFlag: 'showMotivCard',
        timerKeys: ['_scanPollTimer'],
        onShow: () => this.loadBoard(),
        onBookChanged: () => {
          this.resetMotiv();
          if (window.__app.showMotivCard && this.$store.nav.selectedBookId) this.loadBoard();
        },
        onViewReset: () => this.resetMotiv(),
        onCardRefresh: () => this.loadBoard(),
      });
    },

    destroy() {
      this._destroyGraph();
      this._lifecycle?.destroy();
    },

    ...motivMethods,
  }));
}
