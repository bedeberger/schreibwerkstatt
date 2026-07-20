'use strict';
// Motiv-Werkstatt: Brainstorm-Job. Die KI liest den Buchtext und schlägt
// wiederkehrende Motive + übergeordnete Themen vor, die noch NICHT katalogisiert
// sind. Rein planend/rückwärtsgewandt — findet Bestehendes im Text, schreibt NIE
// Prosa. Der Autor bestätigt Vorschläge im Frontend (→ POST /motifs[/themes]).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents,
  groupByChapter, splitGroupsIntoChunks, buildSinglePassBookText,
  SINGLE_PASS_LIMIT, PER_CHUNK_LIMIT, tps, _modelName,
} = require('./shared');
const motifsDb = require('../../db/motifs');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');

const VALID_TYP = new Set(['thema', 'motiv']);

// Ein KI-Vorschlag → Katalog-Eintrag normalisieren (Feld-Trim + Typ-Whitelist).
function _normalizeSuggestion(v) {
  return {
    typ: VALID_TYP.has(v.typ) ? v.typ : 'motiv',
    name: v.name.trim().slice(0, 200),
    beschreibung: typeof v.beschreibung === 'string' ? v.beschreibung.trim().slice(0, 2000) : '',
    trigger_terms: Array.isArray(v.trigger_terms)
      ? v.trigger_terms.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 80)).slice(0, 12)
      : [],
  };
}

async function runMotifBrainstormJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildMotivSystemPrompt, buildMotivBrainstormPrompt, SCHEMA_MOTIV_BRAINSTORM } = await getPrompts();
  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;

    updateJob(jobId, { statusText: 'job.phase.motivBrainstormCollect', progress: 8 });
    const { chMap, pages } = await loadOrderedBookContents(bookId, null);
    const pageContents = await loadPageContents(pages, chMap, 1, null, null, signal());
    if (!pageContents.some(p => p.text)) throw i18nError('job.error.motivNoText');

    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    // Bereits katalogisierte Namen + fortlaufend die schon vorgeschlagenen — sowohl
    // für die Dedup als auch als „NICHT wiederholen"-Kontext an die KI (chunk-übergreifend).
    const existingThemes = motifsDb.listThemes(bookId, userEmail).map(t => t.name);
    const existingMotifs = motifsDb.listMotifs(bookId, userEmail).map(m => m.name);
    const seen = new Set([...existingThemes, ...existingMotifs].map(n => n.toLowerCase()));

    const systemPrompt = buildMotivSystemPrompt();
    const tok = { in: 0, out: 0, ms: 0 };
    const vorschlaege = [];

    // Ein Brainstorm-Durchlauf über einen Textausschnitt. Filtert Dubletten
    // (Katalog + bereits vorgeschlagen) und speist neue Namen in `seen` zurück,
    // damit spätere Chunks sie nicht erneut vorschlagen.
    async function brainstormPass(text, progFrom, progTo) {
      const result = await aiCall(jobId, tok,
        buildMotivBrainstormPrompt(text, [...existingThemes], [...existingMotifs], BUCH_KONTEXT),
        systemPrompt, progFrom, progTo, 3000, 0.3, 2000, undefined, SCHEMA_MOTIV_BRAINSTORM,
      );
      if (!Array.isArray(result?.vorschlaege)) throw i18nError('job.error.motivVorschlaegeMissing');
      for (const raw of result.vorschlaege) {
        if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
        const v = _normalizeSuggestion(raw);
        const key = v.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        (v.typ === 'thema' ? existingThemes : existingMotifs).push(v.name);
        vorschlaege.push(v);
      }
    }

    // Kurze Bücher: ein Durchlauf. Lange: Kapitel-Chunks (wie die Komplettanalyse),
    // damit auch Motive in späteren Kapiteln erkannt werden statt beim Head-Slice zu entgehen.
    const totalChars = pageContents.reduce((s, p) => s + (p.text ? p.text.length : 0), 0);
    const { groupOrder, groups } = groupByChapter(pageContents);

    if (totalChars <= SINGLE_PASS_LIMIT) {
      logger.info(`Motiv-Brainstorm Single-Pass: book=${bookId} text=${totalChars} Zeichen, Katalog=${seen.size}`);
      updateJob(jobId, { statusText: 'job.phase.motivBrainstorm', progress: 15 });
      await brainstormPass(buildSinglePassBookText(groups, groupOrder), 15, 95);
    } else {
      const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, PER_CHUNK_LIMIT);
      logger.info(`Motiv-Brainstorm Multi-Pass: book=${bookId} text=${totalChars} Zeichen, ${chunkOrder.length} Chunks, Katalog=${seen.size}`);
      for (let i = 0; i < chunkOrder.length; i++) {
        if (signal()?.aborted) break;
        const group = chunks.get(chunkOrder[i]);
        const from = 15 + Math.floor((i / chunkOrder.length) * 80);
        const to = 15 + Math.floor(((i + 1) / chunkOrder.length) * 80);
        updateJob(jobId, {
          statusText: 'job.phase.motivBrainstormChunk',
          statusParams: { done: i + 1, total: chunkOrder.length },
          progress: from,
        });
        await brainstormPass(buildSinglePassBookText(new Map([[chunkOrder[i], group]]), [chunkOrder[i]]), from, to);
      }
    }

    // Lauf historisieren (best-effort — ein DB-Fehler darf das Ergebnis nicht
    // verschlucken). Nur echte Vorschläge persistieren; leere Läufe sind nicht
    // zum Wiederöffnen wert. runId geht in den Job-Payload → das Frontend markiert
    // den frischen Lauf sofort als ausgewählt, ohne Round-Trip.
    let runId = null;
    if (vorschlaege.length) {
      try {
        runId = motifsDb.insertBrainstormRun({
          bookId, userEmail, vorschlagCount: vorschlaege.length,
          result: { vorschlaege }, model: _modelName(),
        });
      } catch (e) { logger.warn(`Motiv-Brainstorm-Run-Insert fehlgeschlagen book=${bookId}: ${e.message}`); }
    }

    completeJob(jobId, { vorschlaege, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${vorschlaege.length} Vorschläge`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Motiv-Brainstorm Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const motifBrainstormRouter = express.Router();

motifBrainstormRouter.post('/motif-brainstorm', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const existing = findActiveJobId('motif-brainstorm', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('motif-brainstorm', book_id, userEmail, 'job.label.motivBrainstorm', null, book_id);
  enqueueJob(jobId, () => runMotifBrainstormJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

module.exports = { motifBrainstormRouter, runMotifBrainstormJob };
