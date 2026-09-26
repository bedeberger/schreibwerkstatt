import { makeChatMethods } from './chat-base.js';
import { fetchJson, escHtml, renderChatMarkdown } from '../utils.js';
import {
  renderResearchAnswer as _renderResearchAnswerText,
  citedSources as _citedSources,
} from './research-chat-render.js';

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

  // Vorschläge einer Assistant-Nachricht (aus context_info.proposals).
  researchProposals(msg) {
    return (msg?.context_info?.proposals) || [];
  },

  // Web-Such-Trefferdokumente (1-basiert, Auftrittsreihenfolge) aus dem Backend.
  researchSources(msg) {
    return (msg?.context_info?.sources) || [];
  },

  // Assistant-Antwort rendern. Delegiert an die pure Funktion (Unit-testbar);
  // die Alpine-Methode bleibt Bindung-Ziel der Templates (Live-Export erhalten).
  _renderResearchAnswer(msg) {
    const app = window.__app;
    return _renderResearchAnswerText({
      text: msg?.content || '',
      sources: this.researchSources(msg),
      renderChatMarkdown,
      escHtml,
      t: (k) => app?.t?.(k) ?? k,
    });
  },

  // Distinkte, in der Antwort tatsächlich zitierte Quellen — für die Quellenliste
  // unter der Antwort. Pure Helper genutzt, das schliesst Drift zwischen Render
  // und Digest aus (vorher zwei handgeschriebene Loops über denselben Regex).
  researchCitedSources(msg) {
    return _citedSources(msg?.content || '', this.researchSources(msg));
  },

  // Stabiler Schlüssel für den Speicher-Status eines Vorschlags (pro Session,
  // Nachricht und Vorschlags-Index). Trägt den UI-Status auf Card-Ebene statt auf
  // dem x-for-Item-Proxy — siehe `_proposalSaved`/`_proposalSaving` in recherche-card.js.
  _proposalKey(msgIdx, pi) { return `${this.researchChatSessionId}:${msgIdx}:${pi}`; },
  isProposalSaved(msgIdx, pi) { return !!this._proposalSaved[this._proposalKey(msgIdx, pi)]; },
  isProposalSaving(msgIdx, pi) { return !!this._proposalSaving[this._proposalKey(msgIdx, pi)]; },

  // Einen vom Chat vorgeschlagenen Eintrag tatsächlich ins Board speichern.
  // Persistiert erst HIER (POST /research) — der Chat hat nur vorgeschlagen.
  async saveResearchProposal(msgIdx, pi, proposal) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    const key = this._proposalKey(msgIdx, pi);
    if (!bookId || !proposal || this._proposalSaved[key] || this._proposalSaving[key]) return;
    this._proposalSaving = { ...this._proposalSaving, [key]: true };
    try {
      await fetchJson('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId,
          kind: proposal.kind || 'note',
          title: proposal.title || '',
          body: proposal.body || '',
          urls: Array.isArray(proposal.urls) ? proposal.urls : [],
          source: proposal.source || '',
          tags: Array.isArray(proposal.tags) ? proposal.tags : [],
        }),
      });
      // Board aus Server-Wahrheit neu laden (respektiert aktive Filter/Sortierung
      // + frischt den Tag-Pool mit) statt das Item blind oben einzufügen.
      await this.loadRecherche();
      this._proposalSaved = { ...this._proposalSaved, [key]: true };
    } catch (e) {
      this.errorMessage = app.t('recherche.chat.saveError');
    } finally {
      const next = { ...this._proposalSaving };
      delete next[key];
      this._proposalSaving = next;
    }
  },

  ...makeChatMethods({
    label: 'ResearchChat',
    props: {
      sessions: 'researchChatSessions',
      messages: 'researchChatMessages',
      sessionId: 'researchChatSessionId',
      input: 'researchChatInput',
      loading: 'researchChatLoading',
      runningSessionId: 'researchChatRunningSessionId',
      status: 'researchChatStatus',
      progress: 'researchChatProgress',
      pollTimer: '_researchChatPollTimer',
      gen: '_researchChatGen',
    },
    scrollElId: 'research-chat-messages',
    activeJobType: 'research-chat',
    canOpen: (ctx) => !!Alpine.store('nav').selectedBookId && !!ctx.$store.config.researchChatEnabled,
    sessionsUrl: (ctx) => '/chat/sessions/research/' + Alpine.store('nav').selectedBookId,
    newSessionUrl: '/chat/session/research',
    newSessionBody: (ctx) => ({
      book_id:   parseInt(Alpine.store('nav').selectedBookId),
      book_name: ctx.$app.selectedBookName,
    }),
    sendUrl: '/jobs/research-chat',
  }),
};
