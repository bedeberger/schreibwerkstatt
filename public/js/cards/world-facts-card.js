// Alpine.data('worldFactsCard') — Welt-Fakten/Weltregeln-Karte (read-only).
//
// Selbstständige Karte: hält eigenen State + fetcht /world-facts/:bookId. Daten
// stammen ausschliesslich aus der Komplettanalyse (kein Edit-Pfad im Frontend).
// Gruppierung nach Kategorie; Filter über Suche + Kategorie-Combobox.
import { setupCardLifecycle } from './card-lifecycle.js';
import { fetchJson } from '../utils.js';

export function registerWorldFactsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('worldFactsCard', () => ({
    fakten: [],
    wfUpdatedAt: null,
    wfLoading: false,
    wfFilters: { suche: '', kategorie: '' },
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'weltfakten',
        showFlag: 'showWorldFactsCard',
        resetState: { fakten: [], wfUpdatedAt: null, wfLoading: false },
        load: () => this.loadWorldFacts(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    async loadWorldFacts() {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      this.wfLoading = true;
      try {
        const data = await fetchJson('/world-facts/' + bookId);
        this.fakten = data?.fakten || [];
        this.wfUpdatedAt = data?.updated_at || null;
      } catch (e) {
        console.error('[loadWorldFacts]', e);
      } finally {
        this.wfLoading = false;
      }
    },

    get wfKategorieListe() {
      return [...new Set(this.fakten.map(f => f.kategorie).filter(Boolean))].sort();
    },

    get wfFiltered() {
      const q = this.wfFilters.suche.trim().toLowerCase();
      const kat = this.wfFilters.kategorie;
      return this.fakten.filter(f => {
        if (kat && f.kategorie !== kat) return false;
        if (!q) return true;
        return (f.fakt || '').toLowerCase().includes(q)
          || (f.subjekt || '').toLowerCase().includes(q)
          || (f.kategorie || '').toLowerCase().includes(q);
      });
    },

    // Gefilterte Fakten nach Kategorie gruppiert: [{ kategorie, fakten[] }].
    get wfGrouped() {
      const groups = new Map();
      for (const f of this.wfFiltered) {
        const k = f.kategorie || window.__app.t('weltfakten.uncategorized');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(f);
      }
      return [...groups.entries()].map(([kategorie, fakten]) => ({ kategorie, fakten }));
    },
  }));
}
