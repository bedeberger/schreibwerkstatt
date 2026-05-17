const express = require('express');
const { db, upsertBookByName } = require('../db/schema');
const logger = require('../logger');
const { callAIChat, parseJSONLenient, chatTemperature } = require('../lib/ai');
const { toIntId } = require('../lib/validate');
const contentStore = require('../lib/content-store');
const { setContext } = require('../lib/log-context');
const { aclParamGuard, requireBookAccess, sendACLError } = require('../lib/acl');
const appSettings = require('../lib/app-settings');
const { enforceBudget } = require('../lib/budget');
const {
  getPrompts, getBookPrompts,
  getFiguren, getLatestReview, getLatestPageCheck, getOpenIdeen, buildChatMessageHistory,
  htmlToText,
} = require('./jobs/shared');

const router = express.Router();
router.param('book_id', aclParamGuard('viewer'));
const jsonBody = express.json();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/**
 * Normalisiert context_info aus der DB – ältere Einträge speicherten pages als
 * String-Array, neue als Objekt-Array { name, id, slug, book_slug }.
 */
function normalizeContextInfo(ci) {
  if (!ci || !Array.isArray(ci.pages)) return ci;
  ci.pages = ci.pages.map(p => (typeof p === 'string' ? { name: p } : p));
  return ci;
}

// ── Routen ───────────────────────────────────────────────────────────────────

/** Neue Chat-Session erstellen */
router.post('/session', jsonBody, async (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  const page_id = toIntId(req.body?.page_id);
  const userEmail = req.session?.user?.email || null;
  if (!book_id || !page_id || !userEmail) {
    return res.status(400).json({ error_code: 'BOOKID_PAGEID_LOGIN_REQ' });
  }
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  // Snapshot: Seitentext beim Chat-Öffnen einmalig sichern. Ermöglicht später
  // im System-Prompt einen Vergleich „Stand beim Öffnen" vs. „aktueller Stand",
  // damit die KI Änderungen während laufendem Chat erkennt.
  let openingPageText = null;
  try {
    const pd = await contentStore.loadPage(page_id, req);
    openingPageText = htmlToText(pd.html || '');
  } catch (e) {
    const status = e?.status ? ` status=${e.status}` : '';
    logger.warn(`[chat/session] Snapshot-Load fehlgeschlagen page=${page_id}${status}: ${e.message}`);
  }

  // Orphan-Cleanup: vorher angelegte leere Sessions desselben Users für dieselbe
  // Seite löschen, bevor wir eine neue erstellen. So sammeln sich keine Karteileichen
  // an, wenn der User Chat-Karte mehrmals öffnet/schliesst, ohne zu schreiben.
  db.prepare(`
    DELETE FROM chat_sessions
    WHERE page_id = ? AND user_email = ?
      AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = chat_sessions.id)
  `).run(page_id, userEmail);

  upsertBookByName(book_id, book_name);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO chat_sessions (book_id, page_id, user_email, created_at, last_message_at, opening_page_text)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(book_id, page_id, userEmail, now, now, openingPageText);
  res.json({ id: result.lastInsertRowid });
});

/** Neue Buch-Chat-Session erstellen (ohne Seiten-Bezug) */
router.post('/session/book', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  const userEmail = req.session?.user?.email || null;
  if (!book_id || !userEmail) {
    return res.status(400).json({ error_code: 'BOOKID_LOGIN_REQ' });
  }
  setContext({ book: book_id });
  // Buch-Chat: editor+, ausser allow_lektor_book_chat=1 → lektor+.
  {
    const { getBookSettings } = require('../db/schema');
    const bs = getBookSettings(book_id);
    const min = bs?.allow_lektor_book_chat ? 'lektor' : 'editor';
    try { requireBookAccess(req, book_id, min); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }
  // Orphan-Cleanup analog zum Seiten-Chat (siehe Kommentar oben).
  db.prepare(`
    DELETE FROM chat_sessions
    WHERE book_id = ? AND kind = 'book' AND user_email = ?
      AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = chat_sessions.id)
  `).run(book_id, userEmail);

  upsertBookByName(book_id, book_name);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
    VALUES (?, 'book', ?, ?, ?)
  `).run(book_id, userEmail, now, now);
  res.json({ id: result.lastInsertRowid });
});

/** Alle Buch-Chat-Sessions eines Buchs (neueste zuerst, max. 20).
 *  Leere Sessions (ohne Nachrichten) werden ausgefiltert — sie entstehen beim
 *  Öffnen der Chat-Karte (auto-`startNewSession`) und sollen weder in der
 *  History noch im Badge-Count auftauchen, bis der User wirklich schreibt. */
router.get('/sessions/book/:book_id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const rows = db.prepare(`
    SELECT cs.id, cs.book_id, b.name AS book_name, cs.created_at, cs.last_message_at,
           (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at ASC LIMIT 1) AS preview
    FROM chat_sessions cs
    LEFT JOIN books b ON b.book_id = cs.book_id
    WHERE cs.book_id = ? AND cs.kind = 'book' AND cs.user_email = ?
      AND EXISTS (SELECT 1 FROM chat_messages WHERE session_id = cs.id)
    ORDER BY cs.last_message_at DESC
    LIMIT 20
  `).all(bookId, userEmail);
  res.json(rows);
});

/** Alle Sessions einer Seite (neueste zuerst, max. 20).
 *  Siehe Kommentar oben — leere Sessions werden ausgefiltert. */
router.get('/sessions/:page_id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const rows = db.prepare(`
    SELECT cs.id, cs.book_id, cs.page_id, p.page_name, cs.created_at, cs.last_message_at,
           (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at ASC LIMIT 1) AS preview
    FROM chat_sessions cs
    LEFT JOIN pages p ON p.page_id = cs.page_id
    WHERE cs.page_id = ? AND cs.user_email = ?
      AND EXISTS (SELECT 1 FROM chat_messages WHERE session_id = cs.id)
    ORDER BY cs.last_message_at DESC
    LIMIT 20
  `).all(pageId, userEmail);
  res.json(rows);
});

/** Session mit allen Nachrichten laden */
router.get('/session/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const session = db.prepare(`
    SELECT cs.*, p.page_name FROM chat_sessions cs
    LEFT JOIN pages p ON p.page_id = cs.page_id
    WHERE cs.id = ? AND cs.user_email = ?
  `).get(id, userEmail);
  if (!session) return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });

  const messages = db.prepare(`
    SELECT id, role, content, vorschlaege, tokens_in, tokens_out, tps, context_info, created_at
    FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id);

  res.json({
    ...session,
    messages: messages.map(m => ({
      ...m,
      vorschlaege:  m.vorschlaege  ? JSON.parse(m.vorschlaege)  : [],
      context_info: m.context_info ? normalizeContextInfo(JSON.parse(m.context_info)) : null,
    })),
  });
});

/** Session löschen */
router.delete('/session/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  db.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_email = ?')
    .run(id, userEmail);
  res.json({ ok: true });
});

/** Einzelnen Vorschlag einer Assistant-Nachricht als übernommen markieren (oder zurücksetzen) */
router.patch('/message/:id/vorschlag/:idx/applied', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const msgId = toIntId(req.params.id);
  // idx kann 0 sein → toIntId reicht nicht (lehnt 0 ab). Eigene Prüfung auf nicht-negativen Integer.
  const idx = /^(0|[1-9][0-9]*)$/.test(String(req.params.idx ?? '')) ? Number(req.params.idx) : null;
  if (!msgId || idx == null) return res.status(400).json({ error_code: 'INVALID_ID' });
  const applied = req.body?.applied !== false;

  const row = db.prepare(`
    SELECT cm.vorschlaege FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cm.id = ? AND cs.user_email = ?
  `).get(msgId, userEmail);
  if (!row) return res.status(404).json({ error_code: 'MESSAGE_NOT_FOUND' });

  const vorschlaege = row.vorschlaege ? JSON.parse(row.vorschlaege) : [];
  if (!vorschlaege[idx]) return res.status(400).json({ error_code: 'VORSCHLAG_INDEX_INVALID' });

  if (applied) {
    vorschlaege[idx].applied = true;
    vorschlaege[idx].applied_at = new Date().toISOString();
  } else {
    delete vorschlaege[idx].applied;
    delete vorschlaege[idx].applied_at;
  }

  db.prepare('UPDATE chat_messages SET vorschlaege = ? WHERE id = ?')
    .run(JSON.stringify(vorschlaege), msgId);
  res.json({ ok: true });
});

/**
 * Nachricht senden + KI-Antwort als SSE streamen.
 * Body: { session_id, message, page_text }
 *
 * SSE-Events:
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
 *   data: {"type":"meta","message_id":42,"tokens_in":100,"tokens_out":200}
 *   data: [DONE]
 */
router.post('/send', jsonBody, enforceBudget, async (req, res) => {
  const { message, page_text } = req.body;
  const session_id = toIntId(req.body?.session_id);
  const userEmail = req.session?.user?.email || null;

  if (!session_id || !message?.trim() || !userEmail) {
    return res.status(400).json({ error_code: 'SESSION_MSG_LOGIN_REQ' });
  }

  // Alles in einem try/catch – Express 4 fängt async-Fehler nicht automatisch ab.
  // Ohne diesen Wrapper würde ein Fehler die Verbindung ohne HTTP-Antwort schliessen
  // → Browser sieht "fetch failed".
  let sseStarted = false;
  try {
    // Session validieren
    const session = db.prepare(`
      SELECT cs.*, p.page_name FROM chat_sessions cs
      LEFT JOIN pages p ON p.page_id = cs.page_id
      WHERE cs.id = ? AND cs.user_email = ?
    `).get(session_id, userEmail);
    if (!session) return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });
    setContext({ book: session.book_id });
    if (session.book_id) {
      try { requireBookAccess(req, session.book_id, 'lektor'); }
      catch (e) { if (sendACLError(res, e)) return; throw e; }
    }
    logger.info(`[chat/send] «${session.page_name}» session=${session_id} user=${userEmail} book=${session.book_id}`);

    const now = new Date().toISOString();

    // User-Nachricht in DB speichern
    const userMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, created_at)
      VALUES (?, 'user', ?, ?)
    `).run(session.id, message.trim(), now);
    const userMsgId = userMsgResult.lastInsertRowid;

    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(now, session.id);

    // Kontext aus DB laden – nur Figuren/Szenen/Orte des aktuellen Kapitels
    const pageRow = session.page_id
      ? db.prepare('SELECT chapter_id FROM pages WHERE page_id = ?').get(session.page_id)
      : null;
    const figuren = getFiguren(session.book_id, userEmail, pageRow?.chapter_id ?? null);
    const review  = getLatestReview(session.book_id, userEmail);
    const ideen   = getOpenIdeen(session.page_id, userEmail);
    const lektorat = getLatestPageCheck(session.page_id, userEmail);

    // System-Prompt aus prompts.js (Single Source of Truth)
    const { buildChatSystemPrompt, SCHEMA_CHAT } = await getPrompts();
    const { SYSTEM_CHAT: chatSys } = await getBookPrompts(session.book_id, userEmail);
    const openingPageText = (session.opening_page_text && session.opening_page_text.trim() && session.opening_page_text.trim() !== (page_text || '').trim())
      ? session.opening_page_text
      : null;
    const systemPrompt = buildChatSystemPrompt(
      session.page_name || 'Unbekannte Seite',
      page_text || '',
      figuren,
      review,
      chatSys,
      openingPageText,
      ideen,
      lektorat,
    );

    // Konversationshistorie aufbauen (aktuelle User-Nachricht nicht doppelt senden)
    const historyWithoutLast = buildChatMessageHistory(session.id).slice(0, -1);
    const messages = [
      ...historyWithoutLast,
      { role: 'user', content: message.trim() },
    ];

    // SSE-Header erst setzen wenn alle vorbereitenden Schritte erfolgreich
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    sseStarted = true;

    // Alle drei Provider laufen jetzt über callAIChat; der onProgress-Callback
    // relayed Text-Deltas als Anthropic-kompatibles SSE-Event an den Client.
    // (Lokale Provider bekommen das Schema für Grammar-Constrained-JSON.)
    const provider = appSettings.get('ai.provider') || 'claude';
    const schema = (provider === 'ollama' || provider === 'llama') ? SCHEMA_CHAT : null;
    const temperatureOverride = (provider === 'ollama' || provider === 'llama') ? chatTemperature() : null;
    const { text: fullText, truncated, tokensIn, tokensOut, cacheReadIn = 0, cacheCreationIn = 0, model: usedModel } = await callAIChat(
      messages, systemPrompt,
      ({ delta }) => {
        if (delta) {
          res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta } })}\n\n`);
        }
      },
      null, null, provider, schema, temperatureOverride,
    );
    logger.info(`[chat] ${provider} call model=${usedModel}`);
    if (truncated) {
      logger.warn(`[chat/send] «${session.page_name}» session=${session_id} Antwort abgeschnitten (max_tokens) – ${tokensIn}↑ ${tokensOut}↓.`);
    }

    // Vollständige Antwort parsen (mehrstufiger Fallback: JSON.parse → balanced extract → jsonrepair)
    // Bei truncated=true ist das Parsing best-effort; jsonrepair liefert oft
    // partielle Daten zurück. Frontend erhält truncated-Flag im Meta-Event.
    let antwort = fullText;
    let vorschlaege = [];
    if (!truncated) {
      // Lenient: bei kaputtem JSON (z.B. unescaptes `"` in Vorschlag-Feld)
      // wird wenigstens `antwort` per Regex gerettet, vorschlaege bleibt leer.
      const r = parseJSONLenient(fullText, ['antwort']);
      if (r.ok) {
        antwort     = r.parsed.antwort     ?? fullText;
        vorschlaege = r.parsed.vorschlaege ?? [];
      } else {
        logger.warn(`[chat/send] «${session.page_name}» session=${session_id} KI-Antwort kein valides JSON – Fallback-Extraktion.`);
        antwort = r.partial.antwort ?? r.partial._raw ?? fullText;
      }
    }

    // Assistant-Nachricht in DB speichern
    const assistantNow = new Date().toISOString();
    const asstMsgResult = db.prepare(`
      INSERT INTO chat_messages (session_id, role, content, vorschlaege, tokens_in, tokens_out, cache_read_in, cache_creation_in, provider, model, created_at)
      VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      antwort,
      vorschlaege.length > 0 ? JSON.stringify(vorschlaege) : null,
      tokensIn,
      tokensOut,
      cacheReadIn,
      cacheCreationIn,
      provider,
      usedModel,
      assistantNow
    );
    db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(assistantNow, session.id);

    if (userEmail) {
      const notify = require('../lib/notify');
      notify.maybeNotifyBudgetOverrun(userEmail)
        .catch(e => logger.warn(`[chat/send] notify budget: ${e.message}`));
    }

    // Meta-Event mit IDs + Token-Counts + Vorschlägen ans Frontend
    res.write(`data: ${JSON.stringify({
      type: 'meta',
      user_message_id: userMsgId,
      assistant_message_id: asstMsgResult.lastInsertRowid,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      vorschlaege,
      truncated: !!truncated,
    })}\n\n`);
    logger.info(`[chat/send] «${session.page_name}» session=${session_id} abgeschlossen (${tokensIn}↑ ${tokensOut}↓, ${vorschlaege.length} Vorschläge).`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    logger.error(`[chat/send] session=${session_id} user=${userEmail} Fehler: ${err.message}`, { stack: err.stack });
    if (!sseStarted) {
      // Noch keine SSE-Headers gesendet → normale JSON-Fehlerantwort
      return res.status(502).json({ error: err.message });
    }
    // SSE bereits offen → Fehler-Event senden damit das Frontend reagieren kann
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch { /* res möglicherweise bereits geschlossen */ }
  }
});

module.exports = router;
