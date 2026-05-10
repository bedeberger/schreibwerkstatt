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
    _mindmapDirty: false,
    _jm: null,
    _jmDraftId: null,
    _brainstormJobId: null,
    _consistencyJobId: null,
    _brainstormPollTimer: null,
    _consistencyPollTimer: null,
    _fsListener: null,
    _ctxOutsideHandler: null,
    _ctxEscHandler: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'figurWerkstatt',
        showFlag: 'showFigurWerkstattCard',
        timerKeys: ['_brainstormPollTimer', '_consistencyPollTimer'],
        resetState: { drafts: [], selectedDraftId: null, selectedKnotenId: null, creating: false, newName: '', editName: '', editArchetype: '', editNotes: '', errorMessage: '', brainstormResult: null, consistencyResult: null, brainstormLoading: false, consistencyLoading: false, mindmapFullscreen: false, contextMenuOpen: false, contextMenuNodeId: null, _mindmapDirty: false },
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
