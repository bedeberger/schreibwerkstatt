// Alpine.data('chatCard') — Sub-Komponente des Seiten-Chats.
// SSE-basierte Konversation über die aktuell offene Seite.
//
// Eigener State: chatSessions, chatMessages, chatSessionId, chatInput,
//   chatLoading, chatRunningSessionId, chatProgress, chatStatus, _chatPollTimer,
//   _chatPendingRefresh.
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
    // Session, für die der laufende Job arbeitet (null = kein Lauf).
    // Die Ladeanzeigen hängen daran, nicht an chatLoading — siehe chat-base.js.
    chatRunningSessionId: null,
    chatProgress: 0,
    chatStatus: '',
    _chatPollTimer: null,
    _chatGen: 0,               // Generationszähler gegen späte Responses nach Reset (chat-base.js)
    _chatPendingRefresh: false,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showChatCard',
        timerKeys: ['_chatPollTimer'],
        onShow: async () => {
          // Seiten-Chat verbirgt die Lektorat-Findings, solange er offen ist;
          // toggleChatCard/toggleIdeenCard stellen checkDone aus dem Snapshot
          // wieder her. Nur hier: Buch- und Recherche-Chat liegen nicht neben
          // dem Editor und fassen den Lektorat-State nicht an.
          const root = window.__app;
          if (root?.currentPage) {
            root._checkDoneBeforeChat = root.checkDone;
            root.checkDone = false;
          }
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
