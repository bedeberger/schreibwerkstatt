// Alpine.data('kontinuitaetCard') — Sub-Komponente der Kontinuitätsprüfung.
// Job-Polling implementiert die Karte selbst (manueller Flow, kein createCardJobFeature).

import { kontinuitaetMethods } from '../book/kontinuitaet.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerKontinuitaetCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('kontinuitaetCard', () => ({
    kontinuitaetResult: null,
    kontinuitaetLoading: false,
    kontinuitaetProgress: 0,
    kontinuitaetStatus: '',
    selectedKontinuitaetIssueKey: null,
    kontinuitaetSummaryOpen: false,
    _kontinuitaetPollTimer: null,
    _lifecycle: null,

    init() {
      // kontinuitaetFilters lebt am Root (FILTER_SCOPES, localStorage-Persist).
      // Reset/Restore übernimmt der Root via book:changed / view:reset.
      const doReset = (ctx) => {
        ctx.kontinuitaetResult = null;
        ctx.kontinuitaetLoading = false;
        ctx.kontinuitaetProgress = 0;
        ctx.kontinuitaetStatus = '';
        ctx.selectedKontinuitaetIssueKey = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'kontinuitaet',
        showFlag: 'showKontinuitaetCard',
        timerKeys: ['_kontinuitaetPollTimer'],
        onShow: async (root) => {
          if (!root.figuren?.length) await root.loadFiguren(root.selectedBookId);
          await this._loadKontinuitaetHistory();
        },
        load: () => this._loadKontinuitaetHistory(),
        onBookChanged: async (e, ctx, root) => {
          if (ctx._kontinuitaetPollTimer) {
            clearInterval(ctx._kontinuitaetPollTimer);
            ctx._kontinuitaetPollTimer = null;
          }
          doReset(ctx);
          if (!root.showKontinuitaetCard) return;
          if (!root.selectedBookId) return;
          await ctx._loadKontinuitaetHistory();
        },
        onViewReset: (e, ctx) => {
          if (ctx._kontinuitaetPollTimer) {
            clearInterval(ctx._kontinuitaetPollTimer);
            ctx._kontinuitaetPollTimer = null;
          }
          doReset(ctx);
        },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...kontinuitaetMethods,
  }));
}
