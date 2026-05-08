// Alpine.data('kontinuitaetCard') — Sub-Komponente der Kontinuitätsprüfung.
// Job-Polling implementiert die Karte selbst (manueller Flow, kein createCardJobFeature).

import { kontinuitaetMethods } from '../kontinuitaet.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerKontinuitaetCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('kontinuitaetCard', () => ({
    kontinuitaetResult: null,
    kontinuitaetLoading: false,
    kontinuitaetProgress: 0,
    kontinuitaetStatus: '',
    kontinuitaetFilters: { figurId: '', kapitel: '', schwere: '' },
    selectedKontinuitaetIssueKey: null,
    kontinuitaetSummaryOpen: false,
    _kontinuitaetPollTimer: null,
    _lifecycle: null,

    init() {
      const resetState = {
        kontinuitaetResult: null,
        kontinuitaetLoading: false,
        kontinuitaetProgress: 0,
        kontinuitaetStatus: '',
        'kontinuitaetFilters.figurId': '',
        'kontinuitaetFilters.kapitel': '',
        'kontinuitaetFilters.schwere': '',
        selectedKontinuitaetIssueKey: null,
      };
      // resetState mit verschachtelten Filter-Keys: Object.assign greift nicht
      // tief — eigene Reset-Override für korrektes Zurücksetzen der Filter.
      const doReset = (ctx) => {
        ctx.kontinuitaetResult = null;
        ctx.kontinuitaetLoading = false;
        ctx.kontinuitaetProgress = 0;
        ctx.kontinuitaetStatus = '';
        ctx.kontinuitaetFilters.figurId = '';
        ctx.kontinuitaetFilters.kapitel = '';
        ctx.kontinuitaetFilters.schwere = '';
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
