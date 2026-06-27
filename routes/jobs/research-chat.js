'use strict';
// Agentischer Recherche-Chat (Claude-only, mit Anthropic-Web-Suche). Lebt als
// Panel in der Recherche-Karte. Rückwärtsgewandt: recherchiert + sammelt Material,
// schreibt NIE in den Buchtext. Vorschläge (propose_research_item) werden NICHT
// automatisch gespeichert — sie kommen in context_info.proposals zurück, der User
// bestätigt sie im Frontend (POST /research).
//
// Aufbau analog runBookChatJobAgent (routes/jobs/chat.js), aber mit eigenem
// Tool-Set + Web-Suche und ohne Seiten-Vorladen/Zitat-Validierung.

const { db } = require('../../db/schema');
const { callAIWithTools, getContextConfigFor, resolveProvider } = require('../../lib/ai');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  getPrompts, getBookPrompts,
  jobAbortControllers, buildChatMessageHistory,
  getFiguren, getLatestReview,
} = require('./shared');
const { executeResearchTool } = require('./research-chat-tools');
const appSettings = require('../../lib/app-settings');
const { recordChatLedgerForMessage } = require('../../db/cost-ledger');

function _maxToolIter() {
  return parseInt(appSettings.get('jobs.research_chat.max_tool_iter'), 10) || 6;
}
function _stripTrailingEmptyJson(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\s*```(?:json)?\s*\{\s*\}\s*```\s*$/i, '').replace(/\s*\{\s*\}\s*$/, '').trim();
}

// Rolling-Window: erste Runde als Anker + letzte 10 Nachrichten.
function _buildHistory(sessionId, tailMessages = 10) {
  const all = buildChatMessageHistory(sessionId);
  if (all.length <= tailMessages + 2) return all;
  const anchor = [];
  if (all[0]?.role === 'user')      anchor.push(all[0]);
  if (all[1]?.role === 'assistant') anchor.push(all[1]);
  const tail = all.slice(-tailMessages);
  const anchorInTail = anchor.length > 0 && all.length - tailMessages <= 0;
  return anchorInTail ? tail : [...anchor, ...tail];
}

async function runResearchChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const {
    buildResearchChatAgentSystemPrompt, RESEARCH_CHAT_TOOLS, RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION,
  } = await getPrompts();
  // Recherche-Chat ist Claude-only (Web-Suche gibt es nur dort). Das Frontend
  // blendet das Panel aus, wenn der effektive Provider != claude — hier zur
  // Sicherheit explizit erzwingen.
  const provider = 'claude';
  const aiCfg = getContextConfigFor(provider);
  try {
    if (resolveProvider({ userEmail }) !== 'claude') throw i18nError('job.error.researchChatClaudeOnly');
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    const session = db.prepare(`
      SELECT cs.*, b.name AS book_name FROM chat_sessions cs
      LEFT JOIN books b ON b.book_id = cs.book_id
      WHERE cs.id = ? AND cs.user_email = ? AND cs.kind = 'research'
    `).get(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');
    logger.info(`Start (Recherche-Chat): «${session.book_name || '-'}» session=${sessionId}, msg-len=${message.length}`);

    const itemCount = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ? AND archived = 0').get(session.book_id)?.n || 0;
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
    const { SYSTEM_BOOK_CHAT } = await getBookPrompts(session.book_id, userEmail);
    const maxToolIter = _maxToolIter();
    const tokenBudget = aiCfg.inputBudgetTokens;
    const baseSystemPrompt = buildResearchChatAgentSystemPrompt(session.book_name || '', itemCount, maxToolIter);
    // Per-Buch-Override (Buchtyp/Autoren-Freitext) als zusätzlicher Kontext anhängen.
    const systemPrompt = SYSTEM_BOOK_CHAT ? `${baseSystemPrompt}\n\n${SYSTEM_BOOK_CHAT}` : baseSystemPrompt;

    const jobSignal = jobAbortControllers.get(jobId)?.signal;
    const ctx = {
      bookId: session.book_id, sessionId: session.id, userEmail, userToken,
      jobSignal, logger,
      proposals: [], // propose_research_item sammelt hier; nach dem Loop in context_info
    };

    const historyWithoutLast = _buildHistory(session.id).slice(0, -1);
    let messages = [...historyWithoutLast, { role: 'user', content: message }];

    let totalTokIn = 0, totalTokOut = 0, totalCacheRead = 0, totalCacheCreation = 0, totalCacheCreation1h = 0;
    let finalText = null, genMs = 0, lastModel = null;
    const toolLog = [];
    let webSearches = 0;
    let iter = 0;

    const accumulate = (result) => {
      totalTokIn  += result.tokensIn;
      totalTokOut += result.tokensOut;
      totalCacheRead       += (result.cacheReadIn || 0);
      totalCacheCreation   += (result.cacheCreationIn || 0);
      totalCacheCreation1h += (result.cacheCreation1hIn || 0);
      if (result.genDurationMs) genMs += result.genDurationMs;
      if (result.model) lastModel = result.model;
      // web_search-Nutzung zählen (server_tool_use-Blöcke in rawContentBlocks).
      for (const b of result.rawContentBlocks || []) {
        if (b.type === 'server_tool_use' && b.name === 'web_search') webSearches++;
      }
      updateJob(jobId, {
        tokensIn: totalTokIn, tokensOut: totalTokOut,
        cacheReadIn: totalCacheRead, cacheCreationIn: totalCacheCreation, cacheCreation1hIn: totalCacheCreation1h,
      });
    };

    for (iter = 0; iter < maxToolIter; iter++) {
      if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      updateJob(jobId, {
        statusText: 'job.phase.agentTools',
        statusParams: { current: iter + 1, total: maxToolIter },
        progress: Math.min(90, 10 + iter * 12),
      });

      const onProgress = ({ chars, tokIn }) => {
        const updates = {};
        if (tokIn > 0) updates.tokensIn  = totalTokIn + tokIn;
        if (chars > 0) updates.tokensOut = totalTokOut + Math.floor(chars / aiCfg.charsPerToken);
        if (Object.keys(updates).length) updateJob(jobId, updates);
      };

      const result = await callAIWithTools(messages, systemPrompt, RESEARCH_CHAT_TOOLS, onProgress, undefined, jobSignal, provider);
      accumulate(result);

      if (result.truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: totalTokIn, tokOut: totalTokOut, total: totalTokIn + totalTokOut });
      if (result.tokensIn > tokenBudget) {
        logger.warn(`Context-Budget überschritten (${result.tokensIn}/${tokenBudget}) – Loop abgebrochen.`);
        finalText = result.text || JSON.stringify({ antwort: '__i18n:chat.errors.contextExceeded__' });
        break;
      }

      // final_answer = Pflicht-Endpunkt.
      const finalUse = result.toolUses.find(tu => tu.name === 'final_answer');
      if (finalUse) {
        const antwort = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
        toolLog.push({ name: 'final_answer', input: { antwort_chars: antwort.length }, ok: true, durationMs: 0, resultBytes: antwort.length, truncated: false, iter: iter + 1 });
        logger.info(`tool=final_answer antwort_chars=${antwort.length} iter=${iter + 1} (terminal)`);
        finalText = JSON.stringify({ antwort });
        break;
      }

      if (result.stopReason !== 'tool_use') {
        // Modell beendete mit Prosa (oder reiner Web-Suche) statt final_answer → Prosa IST die Antwort.
        const raw = (result.text || '').trim();
        finalText = raw.startsWith('{') ? raw : JSON.stringify({ antwort: _stripTrailingEmptyJson(raw) || raw });
        break;
      }

      // Custom-Tools ausführen (web_search läuft serverseitig, taucht nicht in toolUses auf).
      messages.push({ role: 'assistant', content: result.rawContentBlocks });
      const toolResults = [];
      for (const tu of result.toolUses) {
        if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const t0 = Date.now();
        let out, ok = true, errMsg = null;
        try { out = await executeResearchTool(tu.name, tu.input, ctx); }
        catch (e) {
          if (e.name === 'AbortError') throw e;
          ok = false; errMsg = e.message; out = { error: e.message };
        }
        const content = JSON.stringify(out);
        toolLog.push({ name: tu.name, input: tu.input, ok, durationMs: Date.now() - t0, resultBytes: content.length, truncated: false, iter: iter + 1, ...(errMsg ? { error: errMsg } : {}) });
        if (ok) logger.info(`tool=${tu.name} bytes=${content.length} iter=${iter + 1}`);
        else    logger.warn(`tool=${tu.name} iter=${iter + 1} FAILED: ${errMsg}`);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content, ...(out && out.error ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (finalText == null) {
      // Iterationen erschöpft → erzwungener Synthese-Turn (nur final_answer anbieten).
      logger.warn(`Max-Iterationen (${maxToolIter}) erreicht – erzwinge Synthese.`);
      updateJob(jobId, { statusText: 'job.phase.agentSynthesize', progress: 92 });
      messages.push({ role: 'user', content: RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION });
      const finalOnlyTools = RESEARCH_CHAT_TOOLS.filter(t => t.name === 'final_answer');
      try {
        const result = await callAIWithTools(messages, systemPrompt, finalOnlyTools, () => {}, undefined, jobSignal, provider);
        accumulate(result);
        const finalUse = result.toolUses?.find(tu => tu.name === 'final_answer');
        if (finalUse) {
          finalText = JSON.stringify({ antwort: typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '' });
        } else {
          const raw = (result.text || '').trim();
          if (raw) finalText = raw.startsWith('{') ? raw : JSON.stringify({ antwort: _stripTrailingEmptyJson(raw) || raw });
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Synthese-Turn fehlgeschlagen: ${e.message}`);
      }
      if (finalText == null) finalText = JSON.stringify({ antwort: '__i18n:chat.errors.maxIterReached__' });
    }

    let antwort = '';
    try { antwort = JSON.parse(finalText)?.antwort || ''; }
    catch { antwort = _stripTrailingEmptyJson(finalText) || finalText; }
    if (!antwort) antwort = '__i18n:chat.errors.maxIterReached__';

    const assistantNow = new Date().toISOString();
    const tpsVal = (genMs > 0 && totalTokOut > 0) ? totalTokOut / (genMs / 1000) : null;
    const contextInfo = {
      mode: 'research',
      tool_calls: toolLog,
      iterations: iter + 1,
      web_searches: webSearches,
      // Speicher-Vorschläge — Frontend rendert sie als „Als … speichern"-Buttons.
      ...(ctx.proposals.length ? { proposals: ctx.proposals } : {}),
    };
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, context_info, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, antwort, totalTokIn, totalTokOut, totalCacheRead, totalCacheCreation, totalCacheCreation1h, 'claude', (lastModel || appSettings.get('ai.claude.model') || 'claude-sonnet-4-6'), tpsVal, JSON.stringify(contextInfo), assistantNow);
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);

    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn: totalTokIn, tokensOut: totalTokOut,
      toolCalls: toolLog.length, iterations: iter + 1, proposals: ctx.proposals.length,
    }, tpsVal, `Recherche-Chat session=${sessionId}, ${toolLog.length} Tool-Calls, ${webSearches} Web-Suchen, ${ctx.proposals.length} Vorschläge`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Recherche-Chat-Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

module.exports = { runResearchChatJob };
