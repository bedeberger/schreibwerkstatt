import { makeChatMethods } from './chat-base.js';

// Buch-Chat-Methoden (werden in Alpine.data('bookChatCard') gespreadet).
// Keine Vorschläge – nur freie Konversation über das gesamte Buch (Agent-Flow).

export const bookChatMethods = {
  ...makeChatMethods({
    label: 'BookChat',
    props: {
      sessions: 'bookChatSessions',
      messages: 'bookChatMessages',
      sessionId: 'bookChatSessionId',
      input: 'bookChatInput',
      loading: 'bookChatLoading',
      runningSessionId: 'bookChatRunningSessionId',
      status: 'bookChatStatus',
      progress: 'bookChatProgress',
      pollTimer: '_bookChatPollTimer',
      gen: '_bookChatGen',
    },
    scrollElId: 'book-chat-messages',
    activeJobType: 'book-chat',
    canOpen: (ctx) => !!Alpine.store('nav').selectedBookId,
    sessionsUrl: (ctx) => '/chat/sessions/book/' + Alpine.store('nav').selectedBookId,
    newSessionUrl: '/chat/session/book',
    newSessionBody: (ctx) => ({
      book_id:   parseInt(Alpine.store('nav').selectedBookId),
      book_name: ctx.$app.selectedBookName,
    }),
    sendUrl: '/jobs/book-chat',
    onBeforeNewSession: async function () {
      await fetch('/jobs/book-chat-cache?book_id=' + Alpine.store('nav').selectedBookId, { method: 'DELETE' });
    },
  }),
};
