// Alpine.data('searchCard') — Volltextsuche.
// Liest aus FTS5 ueber GET /search. Filter: Kind-Multiselect + Buch-Scope
// (aktuelles Buch oder alle sichtbaren). Treffer-Klick navigiert via Hash-
// Router (Seite/Kapitel) oder oeffnet die zugehoerige Karte (Figur/Ort).

import { setupCardLifecycle } from './card-lifecycle.js';

const DEBOUNCE_MS = 220;
const DEFAULT_KINDS = ['page', 'chapter'];
const ALL_KINDS = ['page', 'chapter', 'book', 'figure', 'location', 'scene', 'idea'];

export function registerSearchCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('searchCard', () => ({
    q: '',
    hits: [],
    fallback: false,
    loading: false,
    errorMessage: '',
    activeKinds: [...DEFAULT_KINDS],
    scopeMode: 'book', // 'book' | 'all'
    _debounceTimer: null,
    _abortCtrl: null,
    _searchSeq: 0,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'search',
        showFlag: 'showSearchCard',
        showNeedsBookId: false,
        onShow: async () => {
          await this.$nextTick();
          const input = this.$el?.querySelector('.search-q');
          if (input) input.focus();
          if (this.q && !this.hits.length) this.runSearch();
        },
        onBookChanged: () => {
          if (this.scopeMode === 'book') this.runSearch();
        },
        onViewReset: () => this.resetSearch(),
        extraListeners: [{
          type: 'card:refresh',
          handler: (e) => { if (e?.detail?.name === 'search') this.runSearch(); },
        }],
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._abortCtrl?.abort();
    },

    resetSearch() {
      this.q = '';
      this.hits = [];
      this.fallback = false;
      this.errorMessage = '';
      this.loading = false;
    },

    kindOptions() {
      return ALL_KINDS;
    },

    isKindActive(k) {
      return this.activeKinds.includes(k);
    },

    toggleKind(k) {
      const i = this.activeKinds.indexOf(k);
      if (i >= 0) this.activeKinds.splice(i, 1);
      else this.activeKinds.push(k);
      if (!this.activeKinds.length) this.activeKinds = [...DEFAULT_KINDS];
      this.runSearch();
    },

    toggleScope() {
      this.scopeMode = this.scopeMode === 'book' ? 'all' : 'book';
      this.runSearch();
    },

    onInput() {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this.runSearch(), DEBOUNCE_MS);
    },

    async runSearch() {
      const query = (this.q || '').trim();
      if (query.length < 2) {
        this.hits = [];
        this.fallback = false;
        this.errorMessage = '';
        this.loading = false;
        return;
      }
      this._searchSeq += 1;
      const seq = this._searchSeq;
      this._abortCtrl?.abort();
      const ctrl = new AbortController();
      this._abortCtrl = ctrl;
      this.loading = true;
      this.errorMessage = '';

      const params = new URLSearchParams({
        q: query,
        kind: this.activeKinds.join(','),
        limit: '50',
      });
      const bookId = Alpine.store('nav').selectedBookId;
      if (this.scopeMode === 'book' && bookId) params.set('book_id', String(bookId));

      try {
        const r = await fetch('/search?' + params.toString(), {
          credentials: 'same-origin',
          signal: ctrl.signal,
        });
        if (seq !== this._searchSeq) return; // raced
        if (!r.ok) {
          this.errorMessage = `${r.status}`;
          this.hits = [];
          this.fallback = false;
          return;
        }
        const data = await r.json();
        this.hits = Array.isArray(data.hits) ? data.hits : [];
        this.fallback = !!data.fallback;
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (seq !== this._searchSeq) return;
        this.errorMessage = e.message || 'error';
        this.hits = [];
      } finally {
        if (seq === this._searchSeq) this.loading = false;
      }
    },

    hitKindLabel(kind) {
      const root = window.__app;
      return root?.t ? root.t('search.kind.' + kind) : kind;
    },

    // Treffer-Aktivierung: Hash-Router fuer page/chapter, Karten-Trigger fuer
    // figure/location/scene/idea. book → Buch wechseln + Overview.
    async activateHit(hit) {
      const root = window.__app;
      if (!root || !hit) return;
      try {
        switch (hit.kind) {
          case 'page':
            return root.gotoPageById?.(hit.entity_id);
          case 'chapter': {
            const tree = Alpine.store('nav').tree || [];
            const ch = tree.find(t => t.type === 'chapter' && String(t.id) === String(hit.entity_id));
            if (ch && typeof root.openKapitelReviewForChapter === 'function') {
              return root.openKapitelReviewForChapter(hit.entity_id);
            }
            if (ch?.pages?.[0]) return root.selectPage(ch.pages[0]);
            return;
          }
          case 'book': {
            // FTS5 liefert book_id als String, selectedBookId ist numerisch →
            // sonst greift der strikte Vergleich nie und reassignt bei jedem
            // Treffer einen String.
            const bid = Number(hit.book_id);
            if (Number.isFinite(bid) && Alpine.store('nav').selectedBookId !== bid) {
              Alpine.store('nav').selectedBookId = bid;
            }
            root.toggleBookOverviewCard?.();
            return;
          }
          case 'figure':
            return root.openFigurById?.(hit.entity_id);
          case 'location':
            return root.openOrtById?.(hit.entity_id);
          case 'scene':
            return root.openSzeneById?.(hit.entity_id);
          case 'idea':
            // Ideen sind seitengebunden; oeffne die Seite.
            if (hit.book_id) {
              const idea = await this._loadIdeaPage(hit.entity_id);
              if (idea?.page_id) return root.gotoPageById?.(idea.page_id);
            }
            return;
        }
      } catch (e) {
        console.error('[search activate]', e);
      }
    },

    async _loadIdeaPage(ideaId) {
      try {
        const r = await fetch('/ideen/' + encodeURIComponent(ideaId), { credentials: 'same-origin' });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    },
  }));
}
