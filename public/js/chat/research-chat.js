import { makeChatMethods } from './chat-base.js';
import { fetchJson, escHtml, renderChatMarkdown } from '../utils.js';

// Private-Use-Sentinels für Inline-Zitatmarker: überleben escHtml + die
// Markdown-Transforms unverändert und werden NACH dem Render durch das
// Superscript-HTML ersetzt. Kollisionsfrei in echtem Chat-/Markdown-Text.
const CITE_OPEN = '';
const CITE_CLOSE = '';
// `<cite index="4-4,4-5">…</cite>` — das Modell schreibt diese Marker als
// Klartext in die final_answer-Antwort (claude.ai-Zitatformat). Die erste Zahl
// jedes Komma-Teils ist der Dokument-Index, die zweite ein Satz-Index (ignoriert).
const CITE_TAG_RE = /<cite\b[^>]*\bindex="([^"]*)"[^>]*>([\s\S]*?)<\/cite>/gi;
const CITE_INDEX_ONLY_RE = /<cite\b[^>]*\bindex="([^"]*)"[^>]*>/gi;

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

  // Web-Such-Trefferdokumente (1-basiert, Auftrittsreihenfolge) aus dem Backend.
  researchSources(msg) {
    return (msg?.context_info?.sources) || [];
  },

  // Dokument-Indizes aus einem `index="4-4,4-5"`-String: erste Zahl pro Komma-
  // Teil (= Dokument), Satz-Index dahinter ignoriert. Distinkt, Reihenfolge erhalten.
  _parseCiteDocNums(idxStr) {
    const nums = [];
    for (const part of String(idxStr || '').split(',')) {
      const n = parseInt(part.trim(), 10); // parseInt stoppt am '-' → führende Zahl
      if (Number.isFinite(n) && !nums.includes(n)) nums.push(n);
    }
    return nums;
  },

  // 1-basiertes Mapping Modell-Index → gesammeltes Trefferdokument. Einzige
  // Stelle der Basis-Annahme (falls je off-by-one, hier zentral korrigierbar).
  _resolveSource(sources, n) {
    return sources[n - 1] || null;
  },

  // Assistant-Antwort rendern: `<cite index="N-…">TEXT</cite>` → TEXT + klickbarer
  // Superscript-Marker [N] (verlinkt auf das N-te Trefferdokument). Ohne Quellen
  // werden die Tags still entfernt. Sentinels umgehen den XSS-Escape von
  // renderChatMarkdown; das injizierte HTML escaped url/title selbst.
  _renderResearchAnswer(msg) {
    const app = window.__app;
    let text = msg?.content || '';
    const i18nMatch = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(text);
    if (i18nMatch) return renderChatMarkdown(app.t(i18nMatch[1]));

    const sources = this.researchSources(msg);
    text = text.replace(CITE_TAG_RE, (_full, idxStr, inner) => {
      if (!sources.length) return inner; // nichts zu verlinken → Tag entfernen
      const marks = this._parseCiteDocNums(idxStr)
        .map(n => `${CITE_OPEN}${n}${CITE_CLOSE}`).join('');
      return inner + marks;
    });
    // Defensiv: etwaige Rest-cite-Tags (ohne index / Fragmente) entwrappen.
    text = text.replace(/<\/?cite\b[^>]*>/gi, '');

    let html = renderChatMarkdown(text);
    html = html.replace(new RegExp(`${CITE_OPEN}(\\d+)${CITE_CLOSE}`, 'g'), (_s, nStr) => {
      const n = parseInt(nStr, 10);
      const src = this._resolveSource(sources, n);
      if (src && src.url) {
        return `<sup class="chat-cite"><a href="${escHtml(src.url)}" target="_blank" rel="noopener noreferrer" data-tip="${escHtml(src.title || src.url)}">${n}</a></sup>`;
      }
      return `<sup class="chat-cite chat-cite--dim">${n}</sup>`;
    });
    return html;
  },

  // Distinkte, in der Antwort tatsächlich zitierte Quellen — für die Quellenliste
  // unter der Antwort. Sortiert nach Index, je URL nur einmal.
  researchCitedSources(msg) {
    const sources = this.researchSources(msg);
    if (!sources.length) return [];
    const text = msg?.content || '';
    const nums = [];
    let m;
    CITE_INDEX_ONLY_RE.lastIndex = 0;
    while ((m = CITE_INDEX_ONLY_RE.exec(text))) {
      for (const n of this._parseCiteDocNums(m[1])) if (!nums.includes(n)) nums.push(n);
    }
    nums.sort((a, b) => a - b);
    const seen = new Set();
    const out = [];
    for (const n of nums) {
      const src = this._resolveSource(sources, n);
      if (src && src.url && !seen.has(src.url)) {
        seen.add(src.url);
        out.push({ n, url: src.url, title: src.title || src.url });
      }
    }
    return out;
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
    const bookId = app?.selectedBookId;
    const key = this._proposalKey(msgIdx, pi);
    if (!bookId || !proposal || this._proposalSaved[key] || this._proposalSaving[key]) return;
    this._proposalSaving = { ...this._proposalSaving, [key]: true };
    try {
      const row = await fetchJson('/research', {
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
      // Ins offene Board einfügen (oben) + Tag-Pool aktualisieren.
      this.items = [row, ...this.items];
      this._loadTags();
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
