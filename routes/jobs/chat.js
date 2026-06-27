'use strict';
const express = require('express');
const { db } = require('../../db/schema');
const { callAIChat, callAIWithTools, parseJSONLenient, chatTemperature, getContextConfigFor, resolveProvider } = require('../../lib/ai');
const {
  _promptConfig,
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  getPrompts, getBookPrompts,
  htmlToText, jobAbortControllers,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody,
  getFiguren, getLatestReview, buildChatMessageHistory,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { executeTool, validateFinalAnswerCitations } = require('./book-chat-tools');
const { runResearchChatJob } = require('./research-chat');
const { imageGenEnabled } = require('../../lib/image-gen');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const appSettings = require('../../lib/app-settings');
const { recordChatLedgerForMessage } = require('../../db/cost-ledger');

const chatRouter = express.Router();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function _sanitizeVorschlaege(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(v => {
    const orig = typeof v?.original === 'string' ? v.original.trim() : '';
    const ers  = typeof v?.ersatz   === 'string' ? v.ersatz.trim()   : '';
    return orig && ers && orig !== ers;
  });
}

// Modell-Drift bei Sonnet/Claude: schreibt Prosa-Antwort, hängt am Ende
// `\`\`\`json\n{}\n\`\`\`` als Compliance-Theater an. `extractBalancedJson`
// greift dann das leere `{}` → parseJSON wirkt erfolgreich, aber `antwort`
// fehlt. Trailing-Fence vor Speicherung entfernen.
function _stripTrailingEmptyJson(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\s*```(?:json)?\s*\{\s*\}\s*```\s*$/i, '')
    .replace(/\s*\{\s*\}\s*$/, '')
    .trim();
}

function _parseChatResponse(text) {
  // Lenient: bei kaputtem JSON (z.B. unescaptes `"` oder typografische Quotes
  // im Modell-Output) wenigstens `antwort` per Regex retten. Vorschläge gehen
  // nur sicher zu extrahieren, wenn Gesamt-JSON valid ist.
  const r = parseJSONLenient(text, ['antwort']);
  if (r.ok && typeof r.parsed?.antwort === 'string' && r.parsed.antwort.trim()) {
    return {
      antwort: r.parsed.antwort,
      vorschlaege: _sanitizeVorschlaege(r.parsed.vorschlaege),
      fallback: false,
    };
  }
  // r.ok-aber-antwort-leer = Modell schrieb Prosa und trailing leeres `{}`,
  // das extractBalancedJson erwischt hat. Roh-Prosa speichern, fence weg.
  if (r.ok) {
    return { antwort: _stripTrailingEmptyJson(text) || text, vorschlaege: [], fallback: true };
  }
  return {
    antwort: r.partial.antwort ?? _stripTrailingEmptyJson(r.partial._raw ?? text) ?? text,
    vorschlaege: [],
    fallback: true,
  };
}

/**
 * Rolling-Window für den Buch-Chat: erste user+assistant-Runde als Kontext-Anker
 * + die letzten tailMessages Nachrichten. Verhindert unbegrenztes Historien-Wachstum.
 */
function _bookChatBuildHistory(sessionId, tailMessages = 10) {
  const all = buildChatMessageHistory(sessionId);
  if (all.length <= tailMessages + 2) return all;

  // Erste vollständige Runde sichern (Kontext-Anker)
  const anchor = [];
  if (all[0]?.role === 'user')      anchor.push(all[0]);
  if (all[1]?.role === 'assistant') anchor.push(all[1]);

  // Letzte tailMessages Nachrichten
  const tail = all.slice(-tailMessages);

  // Überschneidung: wenn Anchor bereits im Tail liegt, nur Tail zurückgeben
  const anchorInTail = anchor.length > 0 && all.length - tailMessages <= 0;
  return anchorInTail ? tail : [...anchor, ...tail];
}

// ── Job: Chat ─────────────────────────────────────────────────────────────────
async function runChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildChatSystemPrompt, SCHEMA_CHAT } = await getPrompts();
  const aiCfg = getContextConfigFor(resolveProvider({ userEmail }));
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    const session = db.prepare(`
      SELECT cs.*, p.page_name FROM chat_sessions cs
      LEFT JOIN pages p ON p.page_id = cs.page_id
      WHERE cs.id = ? AND cs.user_email = ?
    `).get(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');
    logger.info(`Start: «${session.page_name || '-'}» session=${sessionId}, page=${session.page_id || '-'}, msg-len=${message.length}`);

    // Seiteninhalt frisch laden (via content-store)
    let pageText = '';
    let pageUpdatedAt = null;
    if (session.page_id && session.page_id > 0) {
      try {
        const pd = await contentStore.loadPage(session.page_id, userToken);
        pageText = htmlToText(pd.html || '');
        pageUpdatedAt = pd.updated_at || null;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Seiteninhalt konnte nicht geladen werden: ${e.message}`);
      }
    }

    // Kontext aus DB laden – nur Figuren/Szenen/Orte des aktuellen Kapitels
    const pageRow = session.page_id
      ? db.prepare('SELECT chapter_id FROM pages WHERE page_id = ?').get(session.page_id)
      : null;
    const figuren = getFiguren(session.book_id, userEmail, pageRow?.chapter_id ?? null);
    const review  = getLatestReview(session.book_id, userEmail);
    const { SYSTEM_CHAT: chatSysPrompt } = await getBookPrompts(session.book_id, userEmail);
    // opening_page_text: Snapshot, der beim Chat-Öffnen gesichert wurde. Wird als
    // Vergleichsbasis nur an die KI gegeben, wenn er sich vom aktuellen Stand
    // unterscheidet (sonst wäre er redundant + kostet nur Tokens).
    const openingPageText = (session.opening_page_text && session.opening_page_text.trim() && session.opening_page_text.trim() !== pageText.trim())
      ? session.opening_page_text
      : null;
    const systemPrompt = buildChatSystemPrompt(session.page_name || 'Unbekannte Seite', pageText, figuren, review, chatSysPrompt, openingPageText);

    // Konversationshistorie aufbauen
    const historyWithoutLast = buildChatMessageHistory(session.id).slice(0, -1);
    const aiMessages = [...historyWithoutLast, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 10 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 10 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
      updateJob(jobId, updates);
    };

    const signal = jobAbortControllers.get(jobId)?.signal;
    const { text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, provider, model, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, signal, undefined, SCHEMA_CHAT, chatTemperature());
    // Job-State auf echte Provider-Werte setzen, damit Status-Anzeige und
    // gespeicherte Chat-Nachricht dieselben Tokens zeigen (statt eines
    // Streaming-Zwischenstands).
    updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
    if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

    const { antwort, vorschlaege, fallback } = _parseChatResponse(text);
    if (fallback) {
      logger.warn('Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
    }

    // Assistant-Nachricht in DB speichern
    const assistantNow = new Date().toISOString();
    const chatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, vorschlaege, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, antwort,
      vorschlaege.length > 0 ? JSON.stringify(vorschlaege) : null,
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
    }, chatTps, `«${session.page_name || '-'}» session=${sessionId}, ${vorschlaege.length} Vorschläge`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Job: Buch-Chat ────────────────────────────────────────────────────────────

// Fallback-Stoppwörter für Book-Chat (Default-Locale); wird pro Job locale-spezifisch überschrieben
const _BOOK_CHAT_STOPWORDS = new Set(
  (() => {
    const def = _promptConfig.defaultLocale || 'de-CH';
    return (_promptConfig.locales?.[def]?.stopwords) || _promptConfig.stopwords || [];
  })()
);

// Seiten-Cache: Key `${bookId}:${userEmail}` → { pages, loadedAt }
// TTL 10 Minuten, max. 20 Einträge (FIFO-Eviction).
const _bookPageCache = new Map();
const _BOOK_PAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const _BOOK_PAGE_CACHE_MAX = 20;

function _scorePageRelevance(query, text, stopwords = _BOOK_CHAT_STOPWORDS) {
  const tokens = query.toLowerCase()
    .split(/[\s,\.!?;:«»"'()\[\]{}]+/)
    .filter(w => w.length >= 3 && !stopwords.has(w));
  if (!tokens.length) return 0;
  const textLow = text.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    const re = new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    score += Math.min((textLow.match(re) || []).length, 5);
  }
  return score;
}

// Per-Job-Claude-Override für den Buch-Chat (klassisch + agentisch), analog zur
// Komplettanalyse (_komplettClaudeOverrides in routes/jobs/komplett/job.js). Nur wirksam,
// wenn in den App-Settings gesetzt und der effektive Provider Claude ist; leer/0 = folgt
// dem globalen Wert. Erlaubt z.B. Opus für den agentischen Tool-Loop, während global
// Sonnet 4.6 läuft. Kein eigener Timeout-Default (anders als komplett) – der Buch-Chat
// macht pro Call nur eine Tool-Use-Runde, der globale 10-Min-Timeout reicht.
function _bookChatClaudeOverrides(effectiveProvider) {
  if (effectiveProvider !== 'claude') return null;
  const model = String(appSettings.get('ai.claude.model.bookchat') || '').trim();
  const contextWindow = parseInt(appSettings.get('ai.claude.context_window.bookchat'), 10) || 0;
  const maxTokensOut = parseInt(appSettings.get('ai.claude.max_tokens_out.bookchat'), 10) || 0;
  const timeoutMs = parseInt(appSettings.get('ai.claude.timeout_ms.bookchat'), 10) || 0;
  // effort (output_config) für Opus 4.5+/Sonnet 4.6: low|medium|high|xhigh|max. Leer = API-Default
  // (high). lib/ai.js klemmt Tier-Mismatch (max→Opus-only, xhigh→Opus-4.7+) automatisch auf high.
  const effort = String(appSettings.get('ai.claude.effort.bookchat') || '').trim();
  const patch = {};
  if (model) patch.claudeModel = model;
  if (contextWindow > 0) patch.claudeContextWindow = contextWindow;
  if (maxTokensOut > 0) patch.claudeMaxTokensOut = maxTokensOut;
  if (timeoutMs > 0) patch.claudeTimeoutMs = timeoutMs;
  if (effort) patch.claudeEffort = effort;
  return Object.keys(patch).length ? patch : null;
}

// Override via ALS-Context binden (greift für alle Claude-Calls dieses Jobs, ohne globale
// Calls zu beeinflussen). MUSS vor getContextConfigFor() laufen, damit das aiCfg (Token-
// Budget, Tool-Result-Cap) das Buch-Chat-Kontextfenster/Output-Cap reflektiert.
function _applyBookChatClaudeOverrides(effectiveProvider, logger) {
  const overrides = _bookChatClaudeOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    logger.info(`Buch-Chat-Claude-Override: ${JSON.stringify(overrides)} (global model=${appSettings.get('ai.claude.model')}).`);
  }
  return overrides;
}

async function runBookChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildBookChatSystemPrompt, SCHEMA_BOOK_CHAT } = await getPrompts();
  const effectiveProvider = resolveProvider({ userEmail });
  _applyBookChatClaudeOverrides(effectiveProvider, logger);
  const aiCfg = getContextConfigFor(effectiveProvider);
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    const session = db.prepare(`
      SELECT cs.*, b.name AS book_name FROM chat_sessions cs
      LEFT JOIN books b ON b.book_id = cs.book_id
      WHERE cs.id = ? AND cs.user_email = ?
    `).get(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');
    logger.info(`Start: «${session.book_name || '-'}» session=${sessionId}, msg-len=${message.length}`);

    const { SYSTEM_BOOK_CHAT: bookChatSys, STOPWORDS: bookChatSW } = await getBookPrompts(session.book_id, userEmail);
    const bookChatStopwords = new Set(bookChatSW || []);

    const cacheKey = `${session.book_id}:${userEmail}`;
    const jobSignal = jobAbortControllers.get(jobId)?.signal;

    // ── Schritt 1: Seiten aus Cache oder frisch via Content-Store laden ─────────
    let pageContents;
    const cached = _bookPageCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < _BOOK_PAGE_CACHE_TTL_MS) {
      pageContents = cached.pages;
      updateJob(jobId, { statusText: 'job.phase.pagesFromCache', progress: 40 });
    } else {
      updateJob(jobId, { statusText: 'job.phase.pageListLoading', progress: 8 });
      let pages;
      try { pages = await contentStore.listPages(session.book_id, userToken); }
      catch (e) {
        if (e?.status) throw i18nError('job.error.contentStorePageList', { status: e.status });
        throw e;
      }

      const BATCH = 5;
      pageContents = [];
      for (let i = 0; i < pages.length; i += BATCH) {
        if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        updateJob(jobId, {
          statusText: 'job.phase.loadingPagesBatch',
          statusParams: { loaded: Math.min(i + BATCH, pages.length), total: pages.length },
          progress: 10 + Math.round((i / Math.max(pages.length, 1)) * 30),
        });
        const batch = pages.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(async p => {
          try {
            const pd = await contentStore.loadPage(p.id, userToken);
            const text = htmlToText(pd.html || '').trim();
            return text ? { name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text } : null;
          } catch { return null; }
        }));
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) pageContents.push(r.value);
        }
      }
      // FIFO-Eviction: ältesten Eintrag entfernen wenn Cache voll
      if (_bookPageCache.size >= _BOOK_PAGE_CACHE_MAX) {
        const firstKey = _bookPageCache.keys().next().value;
        _bookPageCache.delete(firstKey);
      }
      _bookPageCache.set(cacheKey, { pages: pageContents, loadedAt: Date.now() });
    }

    // ── Schritt 2: Historien-Rolling-Window (Anker + letzte 10 Nachrichten) ─────
    const historyWithoutLast = _bookChatBuildHistory(session.id).slice(0, -1);
    const historyChars = historyWithoutLast.reduce((s, m) => s + (m.content?.length || 0), 0);

    // ── Schritt 3: Dynamisches Text-Budget ──────────────────────────────────────
    // aiCfg.inputBudgetChars = (context_window − max_tokens_out − Sicherheitspuffer) · chars_per_token
    // pro effektivem Provider. Davon noch Platz für System-Prompt und History reservieren.
    const SYSTEM_OVERHEAD_CHARS = 8000;   // ~2k Tokens für System-Prompt-Overhead
    const TEXT_CHAR_BUDGET = Math.max(
      20000,
      Math.floor((aiCfg.inputBudgetChars - historyChars - SYSTEM_OVERHEAD_CHARS) * 0.98)
    );

    // ── Schritt 4: Relevanz-Scoring + Seitenauswahl ─────────────────────────────
    updateJob(jobId, { statusText: 'job.phase.selectingPages', progress: 42 });
    const scored = pageContents.map(p => ({ ...p, score: _scorePageRelevance(message, p.text, bookChatStopwords) }));
    const anyScore = scored.some(p => p.score > 0);
    if (anyScore) scored.sort((a, b) => b.score - a.score);

    const selectedPages = [];
    let usedChars = 0;
    if (!anyScore && scored.length > 0) {
      // Gleichmässige Verteilung: jede Seite bekommt denselben Anteil → Querschnitt durch das Buch
      const perPage = Math.floor(TEXT_CHAR_BUDGET / scored.length);
      for (const p of scored) {
        const text = p.text.slice(0, perPage);
        if (text.length >= 100) {
          selectedPages.push({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text });
          usedChars += text.length;
        }
      }
    } else {
      // Relevanz-sortiert: Top-Seiten zuerst bis Budget erschöpft
      for (const p of scored) {
        if (usedChars >= TEXT_CHAR_BUDGET) break;
        const remaining = TEXT_CHAR_BUDGET - usedChars;
        const text = p.text.slice(0, remaining);
        selectedPages.push({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug, text });
        usedChars += text.length;
      }
    }

    const cacheAge = _bookPageCache.has(cacheKey)
      ? Math.round((Date.now() - _bookPageCache.get(cacheKey).loadedAt) / 1000) + 's'
      : 'MISS';
    logger.info(
      `Kontext: ${selectedPages.length}/${pageContents.length} Seiten ` +
      `(${usedChars}/${TEXT_CHAR_BUDGET} Zeichen, Hist ${Math.round(historyChars / 1000)}k Zeichen, ` +
      `${anyScore ? 'Keyword-Scoring' : 'Gleichverteilung'}, Cache ${cacheAge}).`
    );

    // ── System-Prompt + KI-Aufruf ───────────────────────────────────────────────
    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
    const systemPrompt = buildBookChatSystemPrompt(session.book_name || '', selectedPages, figuren, review, bookChatSys);
    const contextInfo = {
      pages:      selectedPages.map(p => ({ name: p.name, id: p.id, slug: p.slug, book_slug: p.book_slug })),
      totalPages: pageContents.length,
      figuren:    figuren.length > 0,
      review:     !!review,
    };

    const aiMessages = [...historyWithoutLast, { role: 'user', content: message }];

    updateJob(jobId, { statusText: 'job.phase.aiReply', progress: 50 });

    const onProgress = ({ chars, tokIn }) => {
      const updates = { progress: Math.min(97, 50 + Math.round(chars / 50)) };
      if (tokIn > 0)  updates.tokensIn  = tokIn;
      if (chars > 0)  updates.tokensOut = Math.floor(chars / aiCfg.charsPerToken);
      updateJob(jobId, updates);
    };

    const { text, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, provider, model, genDurationMs } = await callAIChat(aiMessages, systemPrompt, onProgress, null, jobSignal, undefined, SCHEMA_BOOK_CHAT, chatTemperature(), '{"antwort":"');
    // Job-State auf echte Provider-Werte setzen (Ollama/Llama melden prompt_tokens
    // erst am Streaming-Ende; ohne diesen Update bleibt die Status-Anzeige auf
    // einem Zwischenstand und weicht von der DB-Nachricht ab).
    updateJob(jobId, { tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn });
    if (truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: tokensIn, tokOut: tokensOut, total: tokensIn + tokensOut });

    const { antwort, fallback } = _parseChatResponse(text);
    if (fallback) {
      logger.warn('Buch-Chat-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
    }

    // Assistant-Nachricht in DB speichern (vorschlaege=NULL)
    const assistantNow = new Date().toISOString();
    const bookChatTps = (genDurationMs != null && tokensOut > 0) ? tokensOut / (genDurationMs / 1000) : null;
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, provider, model, tps, context_info, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, antwort, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, provider, model, bookChatTps, JSON.stringify(contextInfo), assistantNow);
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);
    recordChatLedgerForMessage(asstMsgResult.lastInsertRowid);
    completeJob(jobId, {
      session_id: session.id,
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokensIn, tokensOut,
      pagesUsed: selectedPages.length,
      pagesTotal: pageContents.length,
    }, bookChatTps, `«${session.book_name || '-'}» session=${sessionId}, ${selectedPages.length}/${pageContents.length} Seiten`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Gemeinsamer Route-Handler ────────────────────────────────────────────────

function _handleChatPost(req, res, { jobType, sessionSelect, labelFn, runFn }) {
  const { message } = req.body;
  const session_id = toIntId(req.body?.session_id);
  const clientMsgId = typeof req.body?.client_msg_id === 'string' && req.body.client_msg_id.length <= 64
    ? req.body.client_msg_id
    : null;
  if (!session_id || !message?.trim()) return res.status(400).json({ error_code: 'SESSION_ID_MSG_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  // Idempotency: gleicher client_msg_id in selber Session → bestehende jobId zurück,
  // KEIN zweiter Insert. Schützt vor Doppel-Send bei Connection-Loss-Retry.
  if (clientMsgId) {
    const dup = db.prepare(
      `SELECT job_id FROM chat_messages WHERE session_id = ? AND client_msg_id = ?`
    ).get(session_id, clientMsgId);
    if (dup) return res.json({ jobId: dup.job_id || null, existing: true });
  }

  const existing = findActiveJobId(jobType, session_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const session = db.prepare(sessionSelect).get(session_id, userEmail);
  if (!session) return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });
  if (session.book_id) setContext({ book: session.book_id });

  // ACL-Guard. Page-Chat: lektor+. Buch-Chat: editor+, ausser
  // book_settings.allow_lektor_book_chat=1 setzt es auf lektor+.
  if (session.book_id) {
    const { requireBookAccess, sendACLError, ACLError } = require('../../lib/acl');
    const { getBookSettings } = require('../../db/schema');
    let minRole = 'lektor';
    if (jobType === 'book-chat') {
      const bs = getBookSettings(session.book_id);
      minRole = bs?.allow_lektor_book_chat ? 'lektor' : 'editor';
    } else if (jobType === 'research-chat') {
      // Recherche-Board ist editor-scoped → Recherche-Chat ebenso.
      minRole = 'editor';
    }
    try { requireBookAccess(req, session.book_id, minRole); }
    catch (e) {
      if (e instanceof ACLError) { sendACLError(res, e); return; }
      throw e;
    }
  }

  const now = new Date().toISOString();
  const userMsgResult = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, created_at, client_msg_id) VALUES (?, 'user', ?, ?, ?)`
  ).run(session.id, message.trim(), now, clientMsgId);
  db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

  const userToken = null;

  const { key: label, params: labelParams } = labelFn(session);
  const jobId = createJob(jobType, session.book_id || 0, userEmail, label, labelParams, session_id);
  db.prepare('UPDATE chat_messages SET job_id = ? WHERE id = ?').run(jobId, userMsgResult.lastInsertRowid);
  enqueueJob(jobId, () => runFn(jobId, session_id, userMsgResult.lastInsertRowid, message.trim(), userEmail, userToken));
  res.json({ jobId });
}

// ── Job: Agentic Buch-Chat (Tool-Use) ─────────────────────────────────────────
// Ersetzt runBookChatJob bei API_PROVIDER=claude (und BOOK_CHAT_MODE != 'classic').
// Der Agent ruft Tools aus routes/jobs/book-chat-tools.js auf, um Fragen
// über den gesamten Buchindex zu beantworten, statt alle Seiten vorab zu laden.
function _bookChatMaxToolIter() {
  return parseInt(appSettings.get('jobs.book_chat.max_tool_iter'), 10) || 6;
}
// Per-Iteration-Limit für Input-Tokens (Context-Window-Schutz, nicht kumulativ).
// Default = `ai.<provider>.context_window` − `ai.<provider>.max_tokens_out` − Puffer.
// Prompt-Caching macht wiederholte Tokens ohnehin billig, deshalb kein Summen-Budget.
function _bookChatTokenBudget(aiCfg) {
  return parseInt(appSettings.get('jobs.book_chat.token_budget'), 10) || aiCfg.inputBudgetTokens;
}
// Per-Tool-Result-Cap: damit eine einzelne Tool-Antwort nicht allein das Budget sprengt.
// Annahme: bis zu 6 Iterationen × ~3 Tool-Calls × Sicherheitsfaktor 2 ⇒ /36.
// Min 4000 Zeichen, damit Tool-Results bei kleinen Kontextfenstern noch brauchbar sind.
function _toolResultCapChars(maxIter, aiCfg) {
  return Math.max(4000, Math.floor(aiCfg.inputBudgetChars / (maxIter * 6)));
}

function _bookChatUseAgent() {
  const provider = appSettings.get('ai.provider') || 'claude';
  const mode = String(appSettings.get('jobs.book_chat.mode') || 'auto').toLowerCase();
  if (mode === 'classic') return false;
  if (mode === 'agent')   return provider === 'claude';
  return provider === 'claude'; // 'auto'
}

// final_answer-Tool-Use auswerten: Zitate validieren (Beweisspur, nicht blockierend),
// toolLog-Eintrag schreiben und den antwort-Envelope zurückgeben. Geteilt zwischen
// der regulären Loop-Terminierung und dem erzwungenen Synthese-Turn.
async function _consumeFinalAnswer(finalUse, ctx, toolLog, iterNum, logger) {
  const antwort = typeof finalUse.input?.antwort === 'string' ? finalUse.input.antwort : '';
  const zitate  = Array.isArray(finalUse.input?.zitate) ? finalUse.input.zitate : null;
  let citationValidation = null;
  let invalidCount = 0;
  if (zitate && zitate.length) {
    try {
      citationValidation = await validateFinalAnswerCitations(zitate, ctx);
      invalidCount = citationValidation.filter(v => !v.valid).length;
      if (invalidCount > 0) {
        logger.warn(`final_answer: ${invalidCount}/${citationValidation.length} Zitate ungültig (siehe context_info).`);
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      logger.warn(`final_answer-Zitat-Validierung fehlgeschlagen: ${e.message}`);
      citationValidation = [{ valid: false, reason: `validator_error: ${e.message}` }];
      invalidCount = 1;
    }
  }
  toolLog.push({
    name: 'final_answer',
    input: {
      antwort_chars: antwort.length,
      ...(zitate ? { zitate_count: zitate.length } : {}),
    },
    ok: true,
    durationMs: 0,
    resultBytes: antwort.length,
    truncated: false,
    iter: iterNum,
    ...(citationValidation ? {
      citation_validation: citationValidation,
      citations_invalid: invalidCount,
    } : {}),
  });
  logger.info(`tool=final_answer antwort_chars=${antwort.length} zitate=${zitate?.length || 0} invalid=${invalidCount} iter=${iterNum} (terminal)`);
  return JSON.stringify({ antwort });
}

async function runBookChatJobAgent(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildBookChatAgentSystemPrompt, BOOK_CHAT_TOOLS, BOOK_CHAT_FORCE_FINAL_INSTRUCTION } = await getPrompts();
  const effectiveProvider = resolveProvider({ userEmail });
  _applyBookChatClaudeOverrides(effectiveProvider, logger);
  const aiCfg = getContextConfigFor(effectiveProvider);
  try {
    updateJob(jobId, { statusText: 'job.phase.preparing', progress: 5 });

    const session = db.prepare(`
      SELECT cs.*, b.name AS book_name FROM chat_sessions cs
      LEFT JOIN books b ON b.book_id = cs.book_id
      WHERE cs.id = ? AND cs.user_email = ?
    `).get(parseInt(sessionId), userEmail);
    if (!session) throw i18nError('job.error.sessionNotFound');
    logger.info(`Start (Agent): «${session.book_name || '-'}» session=${sessionId}, msg-len=${message.length}`);

    const figuren = getFiguren(session.book_id, userEmail);
    const review  = getLatestReview(session.book_id, userEmail);
    const { SYSTEM_BOOK_CHAT: bookChatSys } = await getBookPrompts(session.book_id, userEmail);
    const maxToolIter = _bookChatMaxToolIter();
    const tokenBudget = _bookChatTokenBudget(aiCfg);
    const toolResultCap = _toolResultCapChars(maxToolIter, aiCfg);
    const systemPrompt = buildBookChatAgentSystemPrompt(
      session.book_name || '', figuren, review, bookChatSys, maxToolIter
    );

    // generate_image nur anbieten, wenn der Bild-Endpunkt konfiguriert ist —
    // sonst spart das Input-Tokens und das Modell ruft kein totes Werkzeug.
    const activeTools = imageGenEnabled()
      ? BOOK_CHAT_TOOLS
      : BOOK_CHAT_TOOLS.filter(t => t.name !== 'generate_image');

    const jobSignal = jobAbortControllers.get(jobId)?.signal;
    const ctx = {
      bookId: session.book_id,
      sessionId: session.id,
      userEmail,
      userToken,
      jobSignal,
      logger,
      // generate_image-Tool sammelt hier {image_id, prompt, mime}; wird nach dem
      // Loop in context_info.images persistiert (Frontend-Anzeige im Verlauf).
      images: [],
      // Input-Budget des effektiven Providers (inkl. Bookchat-Override) — list_chapters
      // leitet daraus ab, ob das ganze Buch in den Kontext passt und gibt dem Agenten
      // einen entsprechenden Lade-Hinweis (Voll-Lektüre statt search_passages-Raten).
      inputBudgetChars: aiCfg.inputBudgetChars,
    };

    // Historien-Rolling-Window (Anker + letzte 10 Nachrichten)
    const historyWithoutLast = _bookChatBuildHistory(session.id).slice(0, -1);
    let messages = [...historyWithoutLast, { role: 'user', content: message }];

    let totalTokIn = 0, totalTokOut = 0, totalCacheRead = 0, totalCacheCreation = 0, totalCacheCreation1h = 0;
    let finalText = null;
    let genMs = 0;
    let lastModel = null; // tatsächlich genutztes Claude-Modell (reflektiert ggf. den Bookchat-Override)
    const toolLog = []; // für context_info
    let iter = 0;

    for (iter = 0; iter < maxToolIter; iter++) {
      if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      updateJob(jobId, {
        statusText: 'job.phase.agentTools',
        statusParams: { current: iter + 1, total: maxToolIter },
        progress: Math.min(90, 10 + iter * 12),
      });

      const onProgress = ({ chars, tokIn }) => {
        const updates = {};
        if (tokIn > 0)  updates.tokensIn  = totalTokIn + tokIn;
        if (chars > 0)  updates.tokensOut = totalTokOut + Math.floor(chars / aiCfg.charsPerToken);
        if (Object.keys(updates).length) updateJob(jobId, updates);
      };

      const result = await callAIWithTools(
        messages, systemPrompt, activeTools, onProgress,
        undefined, jobSignal, undefined
      );
      totalTokIn  += result.tokensIn;
      totalTokOut += result.tokensOut;
      totalCacheRead       += (result.cacheReadIn || 0);
      totalCacheCreation   += (result.cacheCreationIn || 0);
      totalCacheCreation1h += (result.cacheCreation1hIn || 0);
      if (result.genDurationMs) genMs += result.genDurationMs;
      if (result.model) lastModel = result.model;

      // UI mit echten Claude-Zahlen nachziehen (onProgress liefert nur chars-basierte Schätzung,
      // die bei reinen Tool-Use-Iterationen ohne Text-Stream 0 bleibt).
      updateJob(jobId, {
        tokensIn: totalTokIn, tokensOut: totalTokOut,
        cacheReadIn: totalCacheRead, cacheCreationIn: totalCacheCreation,
        cacheCreation1hIn: totalCacheCreation1h,
      });

      if (result.truncated) throw i18nError('job.error.aiTruncated', { max: aiCfg.maxTokensOut, tokIn: totalTokIn, tokOut: totalTokOut, total: totalTokIn + totalTokOut });

      if (result.tokensIn > tokenBudget) {
        logger.warn(`Context-Budget überschritten (${result.tokensIn}/${tokenBudget} Input-Tokens) – Loop abgebrochen.`);
        finalText = result.text || JSON.stringify({ antwort: '__i18n:chat.errors.contextExceeded__' });
        break;
      }

      if (result.stopReason !== 'tool_use') {
        // Modell beendet mit Prosa statt final_answer-Tool (Sonnet-Drift).
        // Prosa IST die finale Antwort — direkt als antwort-Envelope verpacken,
        // statt sie durch _parseChatResponse/parseJSON zu schicken (sonst
        // JSON-Parse-Fehler-ERROR + ai_parse_fails-Dump auf validem Klartext).
        // Ausnahme: Modell lieferte bereits {antwort:…}-JSON — dann unverändert.
        const raw = (result.text || '').trim();
        finalText = raw.startsWith('{')
          ? raw
          : JSON.stringify({ antwort: _stripTrailingEmptyJson(raw) || raw });
        break;
      }

      // final_answer ist Pflicht-Endpunkt: extrahiert antwort aus Tool-Input,
      // beendet Loop ohne executeTool/Reply-Round. Wenn das Modell daneben
      // weitere Tool-Uses emittiert, ignorieren — final_answer terminiert.
      const finalUse = result.toolUses.find(tu => tu.name === 'final_answer');
      if (finalUse) {
        finalText = await _consumeFinalAnswer(finalUse, ctx, toolLog, iter + 1, logger);
        break;
      }

      // Tool-Use: alle tool_uses ausführen und als user-tool_result an messages anhängen.
      messages.push({ role: 'assistant', content: result.rawContentBlocks });
      const toolResults = [];
      for (const tu of result.toolUses) {
        if (jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const t0 = Date.now();
        let out;
        let ok = true;
        let errMsg = null;
        try {
          out = await executeTool(tu.name, tu.input, ctx);
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          ok = false;
          errMsg = e.message;
          out = { error: e.message };
        }
        const durationMs = Date.now() - t0;
        const content = JSON.stringify(out);
        const resultBytes = content.length;
        const truncated = resultBytes > toolResultCap;
        toolLog.push({
          name: tu.name,
          input: tu.input,
          ok,
          durationMs,
          resultBytes,
          truncated,
          iter: iter + 1,
          ...(errMsg ? { error: errMsg } : {}),
        });
        if (ok) {
          logger.info(`tool=${tu.name} dur=${durationMs}ms bytes=${resultBytes}${truncated ? ' truncated' : ''} iter=${iter + 1}`);
        } else {
          logger.warn(`tool=${tu.name} dur=${durationMs}ms bytes=${resultBytes} iter=${iter + 1} FAILED: ${errMsg}`);
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: truncated ? content.slice(0, toolResultCap) + '…' : content,
          ...(out && out.error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    if (finalText == null) {
      // Iterationen erschöpft, ohne dass final_answer gerufen wurde (z.B. breite
      // Recherche-Aufgaben wie "Zitate aus 10–20 Kapiteln"). Statt mit einem
      // Fehler aufzugeben: ein erzwungener Synthese-Turn. Die bereits gesammelten
      // tool_results hängen in `messages`; wir bieten dem Modell nur noch
      // final_answer als Werkzeug an (kein tool_choice-Forcing — das kollidiert
      // mit adaptive thinking; die Werkzeug-Beschränkung reicht: das Modell ruft
      // final_answer oder antwortet in Prosa, beides terminal).
      logger.warn(`Max-Iterationen (${maxToolIter}) erreicht – erzwinge Synthese aus dem bereits gesammelten Kontext.`);
      updateJob(jobId, { statusText: 'job.phase.agentSynthesize', progress: 92 });
      messages.push({ role: 'user', content: BOOK_CHAT_FORCE_FINAL_INSTRUCTION });
      const finalOnlyTools = BOOK_CHAT_TOOLS.filter(t => t.name === 'final_answer');
      try {
        const result = await callAIWithTools(
          messages, systemPrompt, finalOnlyTools,
          ({ chars, tokIn }) => {
            const updates = {};
            if (tokIn > 0) updates.tokensIn  = totalTokIn + tokIn;
            if (chars > 0) updates.tokensOut = totalTokOut + Math.floor(chars / aiCfg.charsPerToken);
            if (Object.keys(updates).length) updateJob(jobId, updates);
          },
          undefined, jobSignal, undefined
        );
        totalTokIn  += result.tokensIn;
        totalTokOut += result.tokensOut;
        totalCacheRead       += (result.cacheReadIn || 0);
        totalCacheCreation   += (result.cacheCreationIn || 0);
        totalCacheCreation1h += (result.cacheCreation1hIn || 0);
        if (result.genDurationMs) genMs += result.genDurationMs;
        if (result.model) lastModel = result.model;
        updateJob(jobId, {
          tokensIn: totalTokIn, tokensOut: totalTokOut,
          cacheReadIn: totalCacheRead, cacheCreationIn: totalCacheCreation,
          cacheCreation1hIn: totalCacheCreation1h,
        });
        const finalUse = result.toolUses?.find(tu => tu.name === 'final_answer');
        if (finalUse) {
          finalText = await _consumeFinalAnswer(finalUse, ctx, toolLog, maxToolIter + 1, logger);
        } else {
          // Modell antwortete in Prosa statt via final_answer — Prosa IST die Antwort.
          const raw = (result.text || '').trim();
          if (raw) finalText = raw.startsWith('{') ? raw : JSON.stringify({ antwort: _stripTrailingEmptyJson(raw) || raw });
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`Synthese-Turn fehlgeschlagen: ${e.message}`);
      }
      if (finalText == null) {
        logger.warn('Synthese-Turn lieferte keine Antwort – Fallback-Meldung.');
        finalText = JSON.stringify({ antwort: '__i18n:chat.errors.maxIterReached__' });
      }
    }

    const { antwort, fallback } = _parseChatResponse(finalText);
    if (fallback) {
      logger.warn('Agent-Antwort kein valides JSON – Rohtext (gesäubert) wird gespeichert.');
    }

    // Assistant-Nachricht in DB speichern
    const assistantNow = new Date().toISOString();
    const tpsVal = (genMs > 0 && totalTokOut > 0) ? totalTokOut / (genMs / 1000) : null;
    const contextInfo = {
      mode: 'agent',
      tool_calls: toolLog,
      iterations: iter + 1,
      // Im Chat generierte Bilder (Weltaufbau-/Chat-Visualisierung) — Frontend
      // rendert sie unter der Antwort und bietet Download via /chat/image/:id.
      ...(ctx.images.length ? { images: ctx.images } : {}),
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
      toolCalls: toolLog.length,
      iterations: iter + 1,
    }, tpsVal, `Agent session=${sessionId}, ${toolLog.length} Tool-Calls, ${iter + 1} Iter`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Agent-Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Dispatcher: wählt zwischen Agent-Pfad und klassischem Pfad.
function runBookChatJobDispatch(jobId, sessionId, userMsgId, message, userEmail, userToken) {
  if (_bookChatUseAgent()) {
    return runBookChatJobAgent(jobId, sessionId, userMsgId, message, userEmail, userToken);
  }
  return runBookChatJob(jobId, sessionId, userMsgId, message, userEmail, userToken);
}

// ── Routen ────────────────────────────────────────────────────────────────────

chatRouter.post('/chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'chat',
  // book_name aus books-Tabelle (Mig 77), page_name via pages-JOIN (Mig 78).
  sessionSelect: `SELECT cs.id, cs.book_id, p.page_name, b.name AS book_name
                  FROM chat_sessions cs
                  LEFT JOIN books b ON b.book_id = cs.book_id
                  LEFT JOIN pages p ON p.page_id = cs.page_id
                  WHERE cs.id = ? AND cs.user_email = ?`,
  labelFn: s => s.page_name
    ? { key: 'job.label.chatPage', params: { name: s.page_name } }
    : { key: 'job.label.chat', params: null },
  runFn: runChatJob,
}));

chatRouter.post('/book-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'book-chat',
  sessionSelect: `SELECT cs.id, cs.book_id, b.name AS book_name
                  FROM chat_sessions cs
                  LEFT JOIN books b ON b.book_id = cs.book_id
                  WHERE cs.id = ? AND cs.user_email = ?`,
  labelFn: s => s.book_name
    ? { key: 'job.label.bookChatBook', params: { name: s.book_name } }
    : { key: 'job.label.bookChat', params: null },
  runFn: runBookChatJobDispatch,
}));

chatRouter.post('/research-chat', jsonBody, (req, res) => _handleChatPost(req, res, {
  jobType: 'research-chat',
  sessionSelect: `SELECT cs.id, cs.book_id, b.name AS book_name
                  FROM chat_sessions cs
                  LEFT JOIN books b ON b.book_id = cs.book_id
                  WHERE cs.id = ? AND cs.user_email = ? AND cs.kind = 'research'`,
  labelFn: s => s.book_name
    ? { key: 'job.label.researchChatBook', params: { name: s.book_name } }
    : { key: 'job.label.researchChat', params: null },
  runFn: runResearchChatJob,
}));

chatRouter.delete('/book-chat-cache', (req, res) => {
  const book_id = toIntId(req.query.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  const { requireBookAccess, sendACLError } = require('../../lib/acl');
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  const key = `${book_id}:${userEmail}`;
  _bookPageCache.delete(key);
  res.json({ ok: true });
});

/**
 * Verwirft alle Cache-Einträge eines Buchs (alle User). Wird nach Sync-Operationen
 * aufgerufen, damit Buch-Chat nicht 10 Min lang auf veraltetem Content antwortet.
 * Cache-Key-Format: `${bookId}:${userEmail}` – Prefix-Match räumt alle User-
 * Varianten gleichzeitig ab (BookStack-Permissions ändern sich selten und
 * verlieren beim Sync ohnehin ihre Aktualität).
 */
function invalidateBookPageCache(bookId) {
  const prefix = `${bookId}:`;
  for (const key of _bookPageCache.keys()) {
    if (key.startsWith(prefix)) _bookPageCache.delete(key);
  }
}

module.exports = { chatRouter, invalidateBookPageCache };
