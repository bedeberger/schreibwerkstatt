// Seiten-Volltextsuche in der Sidebar. Geht ueber contentRepo.search →
// /content/search; AbortController + seq-Guard erhalten, da die Suche
// debounced auf jedem Tastendruck feuert.

import { contentRepo } from './repo/content.js';

export const bookstackSearchMethods = {
  onBookstackSearchInput() {
    if (this._bookstackSearchTimer) clearTimeout(this._bookstackSearchTimer);
    this.bookstackSearchActiveIndex = 0;
    const term = (this.bookstackSearch || '').trim();
    if (term.length < 2) {
      this.bookstackSearchResults = [];
      this.bookstackSearchError = '';
      this.bookstackSearchLoading = false;
      this.bookstackSearched = false;
      if (this._bookstackSearchAbort) { this._bookstackSearchAbort.abort(); this._bookstackSearchAbort = null; }
      return;
    }
    this.bookstackSearchLoading = true;
    this._bookstackSearchTimer = setTimeout(() => this.runBookstackSearch(), 300);
  },

  async runBookstackSearch() {
    const bookId = this.selectedBookId;
    const term = (this.bookstackSearch || '').trim();
    if (!bookId || term.length < 2) return;

    if (this._bookstackSearchAbort) this._bookstackSearchAbort.abort();
    const ctrl = new AbortController();
    this._bookstackSearchAbort = ctrl;
    const seq = ++this._bookstackSearchSeq;

    this.bookstackSearchLoading = true;
    this.bookstackSearchError = '';

    try {
      // contentRepo macht das Query-Augmenting ({type:page} {in_book:N})
      // server-seitig. AbortSignal ueber repo zu schleifen waere ein
      // separater Schritt — bisher reicht der seq-Guard unten, weil
      // alte Antworten ignoriert werden.
      const data = await contentRepo.search(term, { bookId, count: 20 });
      if (seq !== this._bookstackSearchSeq) return;
      const bookIdNum = parseInt(bookId);
      this.bookstackSearchResults = (data.hits || [])
        .filter(h => h.book_id === bookIdNum);
      this.bookstackSearchActiveIndex = 0;
      this.bookstackSearched = true;
    } catch (e) {
      if (ctrl.signal.aborted || e.name === 'AbortError') return;
      if (seq !== this._bookstackSearchSeq) return;
      console.error('[bookstackSearch]', e);
      this.bookstackSearchError = this.t('book.search.error');
      this.bookstackSearchResults = [];
      this.bookstackSearched = true;
    } finally {
      if (seq === this._bookstackSearchSeq) this.bookstackSearchLoading = false;
    }
  },

  clearBookstackSearch() {
    if (this._bookstackSearchTimer) { clearTimeout(this._bookstackSearchTimer); this._bookstackSearchTimer = null; }
    if (this._bookstackSearchAbort) { this._bookstackSearchAbort.abort(); this._bookstackSearchAbort = null; }
    this._bookstackSearchSeq++;
    this.bookstackSearch = '';
    this.bookstackSearchResults = [];
    this.bookstackSearchError = '';
    this.bookstackSearchLoading = false;
    this.bookstackSearched = false;
    this.bookstackSearchActiveIndex = 0;
  },

  selectPageFromBookstackSearch(hit) {
    if (this.currentPage && this.currentPage.id === hit.id) return;
    const page = this.pages.find(p => p.id === hit.id) || { id: hit.id, name: hit.name };
    this.clearBookstackSearch();
    this.selectPage(page);
  },

  // Enter im Volltextsuche-Feld: aktiven (oder ersten) Treffer öffnen.
  selectActiveBookstackHit() {
    const list = this.bookstackSearchResults || [];
    if (!list.length) return;
    const idx = Math.max(0, Math.min(this.bookstackSearchActiveIndex, list.length - 1));
    const hit = list[idx];
    if (hit) this.selectPageFromBookstackSearch(hit);
  },

  // ArrowDown/Up: aktiven Treffer wechseln und in Sicht scrollen.
  onBookstackSearchKeydown(event) {
    const k = event.key;
    if (k !== 'ArrowDown' && k !== 'ArrowUp') return;
    const len = (this.bookstackSearchResults || []).length;
    if (!len) return;
    event.preventDefault();
    if (k === 'ArrowDown') this.bookstackSearchActiveIndex = (this.bookstackSearchActiveIndex + 1) % len;
    else this.bookstackSearchActiveIndex = (this.bookstackSearchActiveIndex - 1 + len) % len;
    this.$nextTick(() => {
      const el = document.querySelector(`.bookstack-search-item[data-bs-idx="${this.bookstackSearchActiveIndex}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
  },
};
