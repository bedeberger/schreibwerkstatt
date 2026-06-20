// Alpine.data('rechercheCard') — Sub-Komponente der Recherche-/Wissensboard-Karte.
// Buchweit geteiltes Archiv (alle Editoren sehen dieselben Schnipsel). Eigener
// fachlicher State + Lifecycle; Root-Zugriffe via window.__app / $app.
import { setupCardLifecycle } from './card-lifecycle.js';
import { rechercheMethods } from '../book/recherche.js';

function _emptyDraft() {
  return { kind: 'note', title: '', body: '', url: '', source: '', tags: '' };
}

export function registerRechercheCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('rechercheCard', () => ({
    items: [],
    tagPool: [],
    linkTargets: {},
    _linkTargetsBookId: null,

    loading: false,
    busy: false,
    errorMessage: '',

    creating: false,
    draft: _emptyDraft(),
    editingId: null,
    editDraft: _emptyDraft(),

    filterKind: '',
    filterTag: '',
    filterLinked: '',
    filterLinkedKind: '',
    filterLinkedTargetId: '',
    filterText: '',
    sortBy: 'updated',
    showArchived: false,

    menuOpenId: null,

    linkPickerItemId: null,
    linkPickerKind: 'figure',
    linkPickerTargetId: '',

    suggestions: {},
    suggestItemId: null,
    suggestStatus: '',
    _suggestTimer: null,

    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'recherche',
        showFlag: 'showRechercheCard',
        timerKeys: ['_suggestTimer'],
        resetState: { creating: false, editingId: null, menuOpenId: null, linkPickerItemId: null, busy: false },
        load: () => this.loadRecherche(),
        onBookChanged: (e, ctx, root) => {
          this.resetRecherche();
          if (root.showRechercheCard && root.selectedBookId) this.loadRecherche();
        },
        onViewReset: () => this.resetRecherche(),
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...rechercheMethods,
  }));
}
