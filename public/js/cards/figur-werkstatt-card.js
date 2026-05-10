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
    savedAt: null,
    brainstormLoading: false,
    brainstormProgress: 0,
    brainstormStatus: '',
    brainstormResult: null,
    consistencyLoading: false,
    consistencyProgress: 0,
    consistencyStatus: '',
    consistencyResult: null,
    _jm: null,
    _brainstormPollTimer: null,
    _consistencyPollTimer: null,
    _savedAtTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'figurWerkstatt',
        showFlag: 'showFigurWerkstattCard',
        timerKeys: ['_brainstormPollTimer', '_consistencyPollTimer', '_savedAtTimer'],
        resetState: { drafts: [], selectedDraftId: null, selectedKnotenId: null, creating: false, newName: '', editName: '', editArchetype: '', editNotes: '', errorMessage: '', brainstormResult: null, consistencyResult: null, brainstormLoading: false, consistencyLoading: false },
        load: () => this.loadDrafts(),
      });
    },

    destroy() {
      this._destroyMindmap();
      this._lifecycle?.destroy();
    },

    ...figurWerkstattMethods,
  }));
}
