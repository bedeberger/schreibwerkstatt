// Alpine.data('ideenCard') — Sub-Komponente für Seiten-Ideen.
// Lebt parallel zum Editor wie der Seiten-Chat (kein _closeOtherMainCards).
// Eigener State; Root behält showIdeenCard, currentPage, selectedBookId, t.

import { ideenMethods } from '../book/ideen.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerIdeenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ideenCard', () => ({
    ideen: [],
    newContent: '',
    editingId: null,
    editingDraft: '',
    movingId: null,
    moveTargetId: '',
    menuOpenId: null,
    menuPos: { top: 0, left: 0 },
    _menuCloseHandler: null,
    loading: false,
    busy: false,
    errorMessage: '',
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showIdeenCard',
        // showNeedsBookId=false: Ideen sind seiten-, nicht buchgebunden — onShow soll
        // auch greifen, wenn kein Buch in der Combobox aktiv ist (currentPage reicht).
        showNeedsBookId: false,
        onShow: async () => {
          await this.loadIdeen();
          this.$nextTick(() => {
            const ta = this.$el?.querySelector('.ideen-input');
            if (ta) ta.focus();
          });
        },
        onBookChanged: () => this.resetIdeen(),
        onViewReset: () => this.resetIdeen(),
        extraListeners: [{ type: 'ideen:reset', handler: () => this.resetIdeen() }],
      });

      this.$watch(() => window.__app.currentPage?.id, async (pid) => {
        if (!pid) { this.resetIdeen(); return; }
        if (window.__app.showIdeenCard) await this.loadIdeen();
      });

      // Move-Picker neben aktive Idee verschieben (DOM-Move, weil Combobox
      // in x-for nicht sauber initialisiert — daher Single-Panel ausserhalb).
      this.$watch('movingId', (id) => {
        const panel = this.$el.querySelector('.idee-move-panel');
        if (!panel) return;
        if (id === null) {
          const list = this.$el.querySelector('.ideen-list');
          if (list && panel.nextSibling !== list) this.$el.insertBefore(panel, list);
          return;
        }
        const item = this.$el.querySelector(`[data-idee-id="${id}"]`);
        if (item && item.parentNode) item.parentNode.insertBefore(panel, item.nextSibling);
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      this._detachMenuListeners?.();
    },

    ...ideenMethods,
  }));
}
