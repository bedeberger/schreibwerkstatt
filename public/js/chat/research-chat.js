import { makeChatMethods } from './chat-base.js';
import { fetchJson } from '../utils.js';

// Recherche-Chat-Methoden (gespreadet in die rechercheCard). Agentischer Chat
// NEBEN dem Wissensboard: recherchiert im Netz + im vorhandenen Material und
// schlägt Fundstücke als neue Recherche-Items vor (User bestätigt). Claude-only.

export const researchChatMethods = {
  // Panel auf-/zuklappen. Beim ersten Öffnen Sessions laden (onVisible-Pfad).
  async toggleResearchChat() {
    this.researchChatOpen = !this.researchChatOpen;
    if (this.researchChatOpen) {
      await this._onVisibleResearchChat();
      this.$nextTick(() => {
        const ta = this.$root?.querySelector('.research-chat-input');
        if (ta) ta.focus();
      });
    }
  },

  // Tool-Call-Zusammenfassung eines Agent-Turns (nach Name gruppiert).
  _researchToolSummary(toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
    const byName = new Map();
    for (const tc of toolCalls) {
      if (tc.name === 'final_answer') continue;
      const e = byName.get(tc.name) || { name: tc.name, count: 0, errors: 0 };
      e.count++;
      if (tc.ok === false) e.errors++;
      byName.set(tc.name, e);
    }
    return Array.from(byName.values());
  },

  // Vorschläge einer Assistant-Nachricht (aus context_info.proposals).
  researchProposals(msg) {
    return (msg?.context_info?.proposals) || [];
  },

  // Einen vom Chat vorgeschlagenen Eintrag tatsächlich ins Board speichern.
  // Persistiert erst HIER (POST /research) — der Chat hat nur vorgeschlagen.
  async saveResearchProposal(msg, proposal) {
    const app = window.__app;
    const bookId = app?.selectedBookId;
    if (!bookId || !proposal || proposal._saved || proposal._saving) return;
    proposal._saving = true;
    try {
      const row = await fetchJson('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId,
          kind: proposal.kind || 'note',
          title: proposal.title || '',
          body: proposal.body || '',
          url: proposal.url || '',
          source: proposal.source || '',
          tags: Array.isArray(proposal.tags) ? proposal.tags : [],
        }),
      });
      // Ins offene Board einfügen (oben) + Tag-Pool aktualisieren.
      this.items = [row, ...this.items];
      this._loadTags();
      proposal._saved = true;
    } catch (e) {
      this.errorMessage = app.t('recherche.chat.saveError');
    } finally {
      proposal._saving = false;
    }
  },

  ...makeChatMethods({
    label: 'ResearchChat',
    props: {
      show: 'researchChatOpen',
      sessions: 'researchChatSessions',
      messages: 'researchChatMessages',
      sessionId: 'researchChatSessionId',
      input: 'researchChatInput',
      loading: 'researchChatLoading',
      status: 'researchChatStatus',
      progress: 'researchChatProgress',
      pollTimer: '_researchChatPollTimer',
    },
    scrollElId: 'research-chat-messages',
    activeJobType: 'research-chat',
    canOpen: (ctx) => !!ctx.$app.selectedBookId && !!ctx.$app.researchChatEnabled,
    sessionsUrl: (ctx) => '/chat/sessions/research/' + ctx.$app.selectedBookId,
    newSessionUrl: '/chat/session/research',
    newSessionBody: (ctx) => ({
      book_id:   parseInt(ctx.$app.selectedBookId),
      book_name: ctx.$app.selectedBookName,
    }),
    sendUrl: '/jobs/research-chat',
    onPollProgress: function (job) {
      this.researchChatStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
    },
    onPollDone: async function () {
      const sid = this.researchChatSessionId;
      const sessions = this.researchChatSessions || [];
      const idx = sessions.findIndex(s => s.id === sid);
      const nowIso = new Date().toISOString();
      if (idx >= 0) {
        const row = { ...sessions[idx], last_message_at: nowIso };
        const next = sessions.slice();
        next.splice(idx, 1);
        next.unshift(row);
        this.researchChatSessions = next;
      } else {
        const firstUserMsg = (this.researchChatMessages || []).find(m => m.role === 'user');
        const root = window.__app;
        this.researchChatSessions = [
          { id: sid, book_id: parseInt(root.selectedBookId), book_name: root.selectedBookName, created_at: nowIso, last_message_at: nowIso, preview: firstUserMsg ? firstUserMsg.content : '' },
          ...sessions,
        ];
      }
    },
  }),
};
