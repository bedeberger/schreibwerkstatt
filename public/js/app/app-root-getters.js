// Computed-Getter der `lektorat`-Alpine-Root-Komponente.
//
// Export als Property-Descriptor-Map: Alpine-Proxy wrappt das Objekt nach
// `Alpine.data(...)`-Return; Getter-Aufrufe gehen durch den Proxy → Reaktivität
// + Dependency-Tracking funktionieren wie bei inline definierten Gettern.
// Object-Spread (`...getters`) würde Getter zur Spread-Zeit einmalig ausführen
// und als statische Werte kopieren — darum descriptor-basiertes
// `Object.defineProperties`.

import { aggregateLiveBookStats } from '../utils.js';

export const rootGetterDescriptors = {
  // Sidebar-Σ: identisch zu Hero-Snapshot (overviewLatest) und Server-Total
  // (routes/sync.js#syncBook). Σ per-Seite-Stats — Titel zählen nicht.
  tokTotals: {
    enumerable: true,
    configurable: true,
    get() {
      const ts = this.tokEsts;
      if (this._tokTotalsCache?.tokRef === ts) {
        return this._tokTotalsCache.value;
      }
      const { chars, words, tok } = aggregateLiveBookStats(ts);
      const value = {
        chars, words, tok,
        normseiten: Math.round((chars / 1500) * 10) / 10,
        any: Object.keys(ts || {}).length > 0,
      };
      this._tokTotalsCache = { tokRef: ts, value };
      return value;
    },
  },
};
