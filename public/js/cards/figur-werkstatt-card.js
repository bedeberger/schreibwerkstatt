// Alpine.data('figurWerkstattCard') — Sub-Komponente der Figuren-Werkstatt-Karte.
// CRUD + jsMind-Editor + KI-Brainstorm + Konsistenz-Check.
// Root behält showFigurWerkstattCard, selectedBookId, t, appConfirm.

import { figurWerkstattMethods } from '../figur-werkstatt.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerFigurWerkstattCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('figurWerkstattCard', () => ({
    drafts: [],
    selectedDraftId: null,
    selectedKnotenId: null,
    creating: false,
    newName: '',
    editName: '',
    editArchetype: '',
    editNotes: '',
    loading: false,
    busy: false,
    errorMessage: '',
    brainstormLoading: false,
    brainstormProgress: 0,
    brainstormStatus: '',
    brainstormResult: null,
    consistencyLoading: false,
    consistencyProgress: 0,
    consistencyStatus: '',
    consistencyResult: null,
    mindmapFullscreen: false,
    contextMenuOpen: false,
    contextMenuNodeId: null,
    contextMenuPos: { left: 0, top: 0 },
    importing: false,
    importables: [],
    importablesLoading: false,
    selectedImportFigureId: '',
    runs: { brainstorm: [], consistency: [] },
    runsLoadedDraftId: null,
    runsLoading: false,
    selectedRunId: null,
    selectedKonfliktIdx: null,
    helpExpanded: false,
    _runsLoadDraftId: null,
    _mindmapDirty: false,
    _jm: null,
    _jmDraftId: null,
    _mindmapEl: null,
    _topicMarkers: null,
    _brainstormJobId: null,
    _brainstormJobDraftId: null,
    _consistencyJobId: null,
    _consistencyJobDraftId: null,
    _brainstormPollTimer: null,
    _consistencyPollTimer: null,
    _fsListener: null,
    _ctxOutsideHandler: null,
    _ctxEscHandler: null,
    _pendingDraftId: null,
    _pendingKnotenId: null,
    _lifecycle: null,

    toggleHelp() {
      this.helpExpanded = !this.helpExpanded;
      try { localStorage.setItem('werkstatt.helpExpanded', this.helpExpanded ? '1' : '0'); } catch {}
    },

    init() {
      try { this.helpExpanded = localStorage.getItem('werkstatt.helpExpanded') === '1'; } catch {}
      // Sub → Root spiegeln: Hash-Router liest werkstattDraftId vom Root.
      // selectedDraftId bleibt SSoT in der Sub; jede Mutation (selectDraft,
      // resetState bei book:changed/view:reset, _doDelete) wird via Watcher
      // auf den Root durchgereicht.
      this.$watch('selectedDraftId', (id) => {
        if (window.__app) window.__app.werkstattDraftId = id || null;
      });
      // Drafts-Liste auf den Root spiegeln, damit die Command-Palette
      // (figuren-Provider) auch werkstatt-Drafts findet, ohne selbst zu fetchen,
      // sobald die Karte mindestens einmal geladen hat.
      this.$watch('drafts', (list) => {
        if (window.__app) window.__app.werkstattDrafts = Array.isArray(list) ? list : [];
      });

      // Hash-Router → Sub: Permalink `#book/:b/werkstatt/:draftId` dispatcht
      // `figur-werkstatt:select`. Drafts evtl. noch nicht geladen → ID parken,
      // loadDrafts() wendet sie nach dem Fetch an.
      const onSelectDraft = (e) => {
        const id = parseInt(e.detail?.draftId);
        if (!id) return;
        const knotenId = e.detail?.knotenId || null;
        if (!this.drafts.length) {
          this._pendingDraftId = id;
          this._pendingKnotenId = knotenId;
          return;
        }
        if (!this.drafts.some(d => d.id === id)) return;
        if (this.selectedDraftId !== id) {
          this._pendingKnotenId = knotenId;
          this.selectDraft(id);
        } else if (knotenId) {
          this._selectNodeQuiet(knotenId);
        }
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'figurWerkstatt',
        showFlag: 'showFigurWerkstattCard',
        timerKeys: ['_brainstormPollTimer', '_consistencyPollTimer'],
        resetState: { drafts: [], selectedDraftId: null, selectedKnotenId: null, creating: false, newName: '', editName: '', editArchetype: '', editNotes: '', errorMessage: '', brainstormResult: null, consistencyResult: null, brainstormLoading: false, consistencyLoading: false, mindmapFullscreen: false, contextMenuOpen: false, contextMenuNodeId: null, importing: false, importables: [], selectedImportFigureId: '', runs: { brainstorm: [], consistency: [] }, runsLoadedDraftId: null, selectedRunId: null, selectedKonfliktIdx: null, _mindmapDirty: false, _pendingDraftId: null, _pendingKnotenId: null},
        load: () => this.loadDrafts(),
        onCardRefresh: async () => {
          if (this.isDirty()) {
            const ok = await window.__app.appConfirm({
              message: window.__app.t('werkstatt.confirmReload'),
              confirmLabel: window.__app.t('edit.discardEdit'),
              danger: true,
            });
            if (!ok) return;
          }
          this._mindmapDirty = false;
          await this.loadDrafts();
        },
        extraListeners: [{
          type: 'keydown',
          handler: (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
            if ((e.key || '').toLowerCase() !== 's') return;
            if (!window.__app?.showFigurWerkstattCard) return;
            if (!this.selectedDraftId) return;
            e.preventDefault();
            this.saveDraft();
          },
        }, {
          // Browser-Reload (F5/Cmd+R) und Tab-Close: native Prompt zeigen,
          // wenn Werkstatt geöffnet ist und ungespeicherte Änderungen vorliegen.
          // Custom appConfirm geht hier nicht — Browser blockiert Modals in
          // beforeunload. Pendant zum Editor-beforeunload in app.js.
          type: 'beforeunload',
          handler: (e) => {
            if (!window.__app?.showFigurWerkstattCard) return;
            if (!this.isDirty()) return;
            e.preventDefault();
            e.returnValue = '';
          },
        }, {
          type: 'figur-werkstatt:select',
          handler: onSelectDraft,
        }],
      });
    },

    destroy() {
      this._destroyMindmap();
      this._lifecycle?.destroy();
    },

    ...figurWerkstattMethods,
  }));
}
