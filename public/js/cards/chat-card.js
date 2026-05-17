// Alpine.data('chatCard') — Sub-Komponente des Seiten-Chats.
// SSE-basierte Konversation über die aktuell offene Seite.
//
// Eigener State: chatSessions, chatMessages, chatSessionId, chatInput,
//   chatLoading, chatProgress, chatStatus, _chatPollTimer, _chatPendingRefresh.
// Root behält: showChatCard (Hash-Router), currentPage, originalHtml,
//   saveApplying, lektoratFindings, checkDone, _checkDoneBeforeChat,
//   _loadApplyAndSave, updatePageView, selectedBookId, t.

import { chatMethods } from '../chat/chat.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerChatCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('chatCard', () => ({
    chatSessions: [],
    chatMessages: [],
    chatSessionId: null,
    chatInput: '',
    chatLoading: false,
    chatProgress: 0,
    chatStatus: '',
    _chatPollTimer: null,
    _chatPendingRefresh: false,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showChatCard',
        timerKeys: ['_chatPollTimer'],
        onShow: async () => {
          await this._onVisibleChat();
          this.$nextTick(() => {
            const ta = this.$el?.querySelector('.chat-input');
            if (ta) ta.focus();
          });
        },
        // book:changed + view:reset reuse resetChat (kein einfaches resetState).
        onBookChanged: () => this.resetChat(),
        onViewReset: () => this.resetChat(),
        extraListeners: [{ type: 'chat:reset', handler: () => this.resetChat() }],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...chatMethods,
  }));
}
