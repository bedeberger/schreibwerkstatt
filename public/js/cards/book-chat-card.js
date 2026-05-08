// Alpine.data('bookChatCard') — Sub-Komponente des Buch-Chats.
// Freie Konversation über das gesamte Buch (Agent mit Tool-Use).
//
// Eigener State: bookChatSessions, bookChatMessages, bookChatSessionId,
//   bookChatInput, bookChatLoading, bookChatProgress, bookChatStatus,
//   _bookChatPollTimer.
// Root behält: showBookChatCard (Hash-Router), selectedBookId,
//   selectedBookName, t.

import { bookChatMethods } from '../book-chat.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerBookChatCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookChatCard', () => ({
    bookChatSessions: [],
    bookChatMessages: [],
    bookChatSessionId: null,
    bookChatInput: '',
    bookChatLoading: false,
    bookChatProgress: 0,
    bookChatStatus: '',
    _bookChatPollTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookChatCard',
        timerKeys: ['_bookChatPollTimer'],
        onShow: async () => {
          await this._onVisibleBookChat();
          this.$nextTick(() => {
            const ta = this.$el?.querySelector('.chat-input');
            if (ta) ta.focus();
          });
        },
        onBookChanged: () => this.resetBookChat(),
        onViewReset: () => this.resetBookChat(),
        extraListeners: [{ type: 'book-chat:reset', handler: () => this.resetBookChat() }],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...bookChatMethods,
  }));
}
