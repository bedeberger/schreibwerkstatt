// Alpine.data('werkbankCard') — die Karte, die die drei Werkstätten zusammen
// liest (Figuren × Akte + die gemessenen Befunde). Rein lesend: bearbeitet wird
// in der jeweiligen Werkstatt, hierher führt nur der Sprung zurück.
//
// Root behält showWerkbankCard, selectedBookId, t und die Navigations-Methoden.

import { werkbankMethods } from '../book/werkbank.js';
import { memoMethods } from './card-memo.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerWerkbankCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('werkbankCard', () => ({
    // Matrix-Payload (GET /werkbank): { akte, figuren, kerne, scanned }.
    werkbank: null,
    // Befund-Payload (GET /werkbank/befunde): { befunde, scanned }. Lazy —
    // erst beim Umschalten in die Befund-Ansicht geholt.
    werkbankBefunde: null,
    werkbankView: 'matrix',
    werkbankFilter: '',
    werkbankLoading: false,
    werkbankBefundeLoading: false,
    werkbankError: '',
    // Speicher des geteilten _memo-Helpers (cards/card-memo.js); pro Instanz.
    _memos: {},

    init() {
      setupCardLifecycle(this, {
        name: 'werkbank',
        showFlag: 'showWerkbankCard',
        load: () => this.loadWerkbank(),
        // Ein Buchwechsel wirft beide Payloads weg und laedt nur nach, wenn die
        // Karte offen ist — sonst holt der naechste `load` sie.
        onBookChanged: async () => {
          this.resetWerkbank();
          if (!window.__app?.showWerkbankCard) return;
          if (!window.Alpine?.store('nav').selectedBookId) return;
          await this.loadWerkbank();
        },
        onViewReset: () => this.resetWerkbank(),
        // Re-Klick laedt beide Sichten neu: die Werkbank ist eine Momentaufnahme
        // dreier Werkstaetten, und genau dafuer klickt man sie erneut an.
        onCardRefresh: async () => {
          this.werkbankBefunde = null;
          await this.loadWerkbank();
        },
      });
    },

    ...werkbankMethods,
    ...memoMethods,
  }));
}
