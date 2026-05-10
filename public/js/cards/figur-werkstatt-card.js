// Alpine.data('figurWerkstattCard') — Sub-Komponente der Figuren-Werkstatt-Karte.
// CRUD über /draft-figures; KI-Buttons (Brainstorm/Konsistenz) folgen in Phase 4.
// Root behält showFigurWerkstattCard, selectedBookId, t, appConfirm.

import { figurWerkstattMethods } from '../figur-werkstatt.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerFigurWerkstattCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('figurWerkstattCard', () => ({
    drafts: [],
    selectedDraftId: null,
    creating: false,
    newName: '',
    editName: '',
    editArchetype: '',
    editNotes: '',
    loading: false,
    busy: false,
    errorMessage: '',
    savedAt: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'figurWerkstatt',
        showFlag: 'showFigurWerkstattCard',
        resetState: { drafts: [], selectedDraftId: null, creating: false, newName: '', editName: '', editArchetype: '', editNotes: '', errorMessage: '' },
        load: () => this.loadDrafts(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    ...figurWerkstattMethods,
  }));
}
