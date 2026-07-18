// Alpine.data('redundanzCard') — Redundanz-Radar (buchweite Doppelungs-Suche).
// Job-Polling implementiert die Karte selbst (manueller Flow). Fachlicher State
// lebt hier; der showRedundanzCard-Flag bleibt im Root (Hash-Router, Exklusivität).

import { redundanzMethods } from '../book/redundanz.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerRedundanzCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('redundanzCard', () => ({
    redundanzThreshold: 'loose', // 'strict' | 'medium' | 'loose' — Default locker (zeigt auch thematisch Nahes)
    redundanzResult: null,
    redundanzLoading: false,
    redundanzProgress: 0,
    redundanzStatus: '',
    redundanzIndexInfo: null,
    _redundanzPollTimer: null,
    _lifecycle: null,

    // Getter inline (nicht in redundanzMethods gespreadet — Spread-Getter-Falle):
    // Backend + Buch vorhanden (Vektoren leben pro Buch).
    get redundanzAvailable() {
      return !!this.$store.config?.semanticSearchEnabled && !!Alpine.store('nav').selectedBookId;
    },
    // Ob ein Seiten-Index existiert (nur Seiten werden verglichen).
    get redundanzHasIndex() {
      const bk = this.redundanzIndexInfo?.byKind || [];
      return bk.some(k => k.kind === 'page' && k.chunks > 0);
    },

    init() {
      const doReset = (ctx) => {
        if (ctx._redundanzPollTimer) { clearTimeout(ctx._redundanzPollTimer); ctx._redundanzPollTimer = null; }
        ctx.redundanzResult = null;
        ctx.redundanzLoading = false;
        ctx.redundanzProgress = 0;
        ctx.redundanzStatus = '';
        ctx.redundanzIndexInfo = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'redundanz',
        showFlag: 'showRedundanzCard',
        timerKeys: ['_redundanzPollTimer'],
        onShow: async () => {
          if (this.redundanzAvailable) await this.loadRedundanzIndexStatus();
        },
        onBookChanged: async (e, ctx, root) => {
          doReset(ctx);
          if (!root.showRedundanzCard) return;
          if (ctx.redundanzAvailable) await ctx.loadRedundanzIndexStatus();
        },
        onViewReset: (e, ctx) => doReset(ctx),
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...redundanzMethods,
  }));
}
