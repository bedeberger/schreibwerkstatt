'use strict';
// Seiten-Chat-Job (kind='page'): klassischer Chat neben dem Editor; Antwort-
// Envelope mit `vorschlaege` (zeichengenaue Textersetzung) + updatedAt-Staleness.

const { db } = require('../../../db/schema');
const { getSessionRow } = require('../../../db/chat-sessions');
const { callAIChat, chatTemperature, getContextConfigFor, resolveProvider } = require('../../../lib/ai');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  getPrompts, getBookPrompts,
  htmlToText, jobAbortControllers,
  getFiguren, getLatestReview, getLatestPageCheck, getOpenIdeen, buildChatMessageHistory,
} = require('../shared');
const contentStore = require('../../../lib/content-store');
const { generateSessionTitle } = require('../chat-title');
const { recordChatLedgerForMessage } = require('../../../db/cost-ledger');
const { _parseChatResponse, figurenBlockChars } = require('./shared');
const { pageChatBudget, computePageChangeHunks, fitHistory } = require('./page-chat-context');

async function runChatJob(jobId, sessionId, userMsgId, message, userEmail) {
  const logger = makeJobLogger(jobId);
  const {
    buildChatSystemPrompt, SCHEMA_CHAT, formatHistoryVorschlaege, historyTrimNote, formatPageChange,
  } = await getPrompts(userEmail);
  const aiCfg = getContextConfigFor(resolveProvider({ userEmail }));
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    const session = getSessionRow(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');

    // Seiteninhalt frisch laden (via content-store). Name und Kapitel kommen aus
    // derselben Zeile — das Kapitel filtert unten die Figuren. Ohne Seite gibt es
    // keinen Seiten-Chat: ein Fehlschlag endet als Job-Fehler, nicht als Antwort
    // „über" eine leere Seite (deren Vorschläge auf nichts zeigen könnten).
    if (!(session.page_id > 0)) throw i18nError('job.error.pageChatLoadFailed');
    let pd;
    try {
      pd = await contentStore.loadPage(session.page_id);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      logger.warn(`Seiteninhalt konnte nicht geladen werden: ${e.message}`);
      throw i18nError('job.error.pageChatLoadFailed');
    }
    const pageText = htmlToText(pd.html || '');
    const pageUpdatedAt = pd.updated_at || null;
    const pageChapterId = pd.chapter_id ?? null;
    session.page_name = pd.name || null;

    // Budget (routes/jobs/chat/page-chat-context.js): Seitentext gedeckelt, Stand
    // beim Chat-Start nur als Diff, Verlauf auf den Rest gekürzt.
    const budget = pageChatBudget(aiCfg);
    if (pageText.length > budget.pageMax) {
      throw i18nError('job.error.pageChatPageTooLarge', { chars: pageText.length, max: budget.pageMax });
    }
    logger.info(`Start: «${session.page_name || '-'}» session=${sessionId}, page=${session.page_id || '-'}, msg-len=${message.length}`);

    // Kontext aus DB laden – nur Figuren/Szenen/Orte des aktuellen Kapitels
    const figuren = getFiguren(session.book_id, userEmail, pageChapterId);
    const review  = getLatestReview(session.book_id, userEmail);
    const ideen    = getOpenIdeen(session.page_id, userEmail);
    const lektorat = getLatestPageCheck(session.page_id, userEmail);
    const { SYSTEM_CHAT: chatSysPrompt } = await getBookPrompts(session.book_id, userEmail);
    // opening_page_text: Snapshot beim Chat-Öffnen. Hat der Autor seither
    // editiert, geht nur ein kompakter Wort-Diff an die KI — nie eine zweite
    // Vollfassung neben dem aktuellen Stand.
    const pageChange = computePageChangeHunks(session.opening_page_text, pageText, { maxChars: budget.changeNoteMax });
    const pageChangeNote = pageChange ? formatPageChange(pageChange) : null;
    // Figuren sind hier kapitel-gefiltert, aber ebenfalls Volldossiers → gebudgetet
    // (gleicher Deckel wie im Buch-Chat, siehe figurenBlockChars).
    const systemPrompt = buildChatSystemPrompt(session.page_name || '–', pageText, figuren, review,
      chatSysPrompt, pageChangeNote, ideen, lektorat, { figurenMaxChars: figurenBlockChars(aiCfg) });

    // Konversationshistorie: frühere Vorschläge samt Status als Anhang der
    // jeweiligen Antwort, dann auf das Restbudget gekürzt (älteste zuerst).
    const sysChars = systemPrompt.reduce((n, b) => n + (b.text || '').length, 0);
    const historyBudget = budget.total - sysChars - message.length;
    if (historyBudget < 0) {
      throw i18nError('job.error.pageChatContextFull', { chars: sysChars + message.length, max: budget.total });
    }
    const annotate = (r) => {
      if (r.role !== 'assistant' || !r.vorschlaege) return '';
      try { return formatHistoryVorschlaege(JSON.parse(r.vorschlaege)); } catch { return ''; }
    };
    const fullHistory = buildChatMessageHistory(session.id, { annotate }).slice(0, -1);
    const { messages: history, dropped } = fitHistory(fullHistory, historyBudget);
    const aiMessages = [...history, { role: 'user', content: message }];
    if (dropped > 0) {
      aiMessages[0] = { ...aiMessages[0], content: `${historyTrimNote(dropped)}\n\n${aiMessages[0].content}` };
      logger.info(`Verlauf gekürzt: ${dropped} ältere Nachricht(en) weggelassen (Budget ${historyBudget} Zeichen).`);
    }

    updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 10 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 10 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
      updateJob(jobId, updates);
    };

    const signal = jobAbortControllers.get(jobId)?.signal;
    // cacheLastMessage=true: Seiten-Chat hat über die Turns einer Session einen
    // stabilen System-Prompt (Block 1 buch-stabil, Block 2 seiten-stabil), daher
    // greift das Multi-Turn-Caching der Konversationshistorie.
    const { text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, provider, model, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, signal, undefined, SCHEMA_CHAT, chatTemperature(), true);
    // Job-State auf echte Provider-Werte setzen, damit Status-Anzeige und
    // gespeicherte Chat-Nachricht dieselben Tokens zeigen (statt eines
    // Streaming-Zwischenstands).
    updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
    if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

    const { antwort, vorschlaege, titel_varianten: titelVarianten, fallback, lostVorschlaege } = _parseChatResponse(text);
    if (fallback) {
      logger.warn(`Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert${lostVorschlaege ? ', Vorschläge verloren' : ''}.`);
    }
    // Seiten-Chat-Metadaten im vorhandenen `context_info`-JSON (keine eigene
    // Spalte): Parse-Fallback + verlorene Vorschläge (UI-Hinweis), Titelvarianten,
    // gekürzter Verlauf.
    const contextInfo = {
      ...(fallback ? { parse_fallback: true } : {}),
      ...(lostVorschlaege ? { lost_vorschlaege: true } : {}),
      ...(titelVarianten.length ? { titel_varianten: titelVarianten } : {}),
      ...(dropped > 0 ? { history_trimmed: dropped } : {}),
    };

    // Assistant-Nachricht in DB speichern
    const assistantNow = new Date().toISOString();
    const chatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, vorschlaege, context_info, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, antwort,
      vorschlaege.length > 0 ? JSON.stringify(vorschlaege) : null,
      Object.keys(contextInfo).length > 0 ? JSON.stringify(contextInfo) : null,
      tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, provider, model, chatTps, assistantNow
    );
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      updatedAt: pageUpdatedAt,
      tokensIn, tokensOut,
      // Titel folgt asynchron (unten); das Frontend holt ihn mit der Historie nach.
      titlePending: !session.title,
    }, chatTps, `«${session.page_name || '-'}» session=${sessionId}, ${vorschlaege.length} Vorschläge`);
    // Titel NACH completeJob: ein zweiter KI-Call vor dem Job-Ende hielt die
    // fertige Antwort um seine ganze Laufzeit zurück. Non-fatal, persistiert selbst.
    void generateSessionTitle({ session, userMessage: message, assistantAnswer: antwort, provider, logger });
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

module.exports = { runChatJob };
