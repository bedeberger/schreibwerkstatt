// Alpine.data('rechercheCard') — Sub-Komponente der Recherche-/Wissensboard-Karte.
// Buchweit geteiltes Archiv (alle Editoren sehen dieselben Schnipsel). Eigener
// fachlicher State + Lifecycle; Root-Zugriffe via window.__app / $app.
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { rechercheMethods } from '../book/recherche.js';

function _emptyDraft() {
  return { kind: 'note', title: '', body: '', url: '', source: '', tags: '', fileName: '' };
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

    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) —
    // mehr Platz fürs Karten-Board. Toggle in rechercheMethods.toggleRechercheFullscreen.
    rechercheFullscreen: false,

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
        extraListeners: [
          { type: 'recherche:filter-page', handler: (e) => this.filterToPage(e.detail?.pageId) },
          { type: 'recherche:filter-chapter', handler: (e) => this.filterToChapter(e.detail?.chapterId) },
        ],
        onBookChanged: (e, ctx, root) => {
          this.resetRecherche();
          if (root.showRechercheCard && root.selectedBookId) this.loadRecherche();
        },
        onViewReset: () => this.resetRecherche(),
      });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      // $root = die Karten-Wurzel (.card--recherche), unabhängig vom Klick-Kontext.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.rechercheFullscreen = active; },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...rechercheMethods,
  }));
}
