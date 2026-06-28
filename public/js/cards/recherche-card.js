// Alpine.data('rechercheCard') — Sub-Komponente der Recherche-/Wissensboard-Karte.
// Buchweit geteiltes Archiv (alle Editoren sehen dieselben Schnipsel). Eigener
// fachlicher State + Lifecycle; Root-Zugriffe via window.__app / $app.
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { rechercheMethods } from '../book/recherche.js';
import { researchChatMethods } from '../chat/research-chat.js';

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

    // Recherche-Chat-Panel (Claude-only, mit Web-Suche). Eigener Sub-State neben
    // dem Board; Methoden aus researchChatMethods (makeChatMethods-Factory).
    researchChatOpen: false,
    researchChatSessions: [],
    researchChatMessages: [],
    researchChatSessionId: null,
    researchChatInput: '',
    researchChatLoading: false,
    researchChatProgress: 0,
    researchChatStatus: '',
    _researchChatPollTimer: null,

    // Saving-/Saved-Status der Chat-Speicher-Vorschläge — Card-Level statt auf dem
    // verschachtelten proposal-Objekt, weil Mutationen am x-for-Item-Proxy nach
    // einem await nicht zuverlässig ins Template durchschlagen (Reactive-Proxy-
    // Identity). Schlüssel: `${sessionId}:${msgIdx}:${pi}`. Reassign (kein In-Place-
    // Mutate), damit Alpine die Änderung sicher sieht.
    _proposalSaved: {},
    _proposalSaving: {},

    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'recherche',
        showFlag: 'showRechercheCard',
        timerKeys: ['_suggestTimer', '_researchChatPollTimer'],
        resetState: { creating: false, editingId: null, menuOpenId: null, linkPickerItemId: null, busy: false },
        load: () => this.loadRecherche(),
        extraListeners: [
          { type: 'recherche:filter-page', handler: (e) => this.filterToPage(e.detail?.pageId) },
          { type: 'recherche:filter-chapter', handler: (e) => this.filterToChapter(e.detail?.chapterId) },
        ],
        onBookChanged: (e, ctx, root) => {
          this.resetRecherche();
          this.resetResearchChat();
          this.researchChatOpen = false;
          if (root.showRechercheCard && Alpine.store('nav').selectedBookId) this.loadRecherche();
        },
        onViewReset: () => { this.resetRecherche(); this.resetResearchChat(); this.researchChatOpen = false; },
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
    ...researchChatMethods,
  }));
}
