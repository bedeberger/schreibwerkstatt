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
  SINGLE_PASS_LIMIT, tps,
} = require('./shared');
const motifsDb = require('../../db/motifs');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');

const VALID_TYP = new Set(['thema', 'motiv']);

async function runMotifBrainstormJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildMotivSystemPrompt, buildMotivBrainstormPrompt, SCHEMA_MOTIV_BRAINSTORM } = await getPrompts();
  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;

    updateJob(jobId, { statusText: 'job.phase.motivBrainstormCollect', progress: 8 });
    const { chMap, pages } = await loadOrderedBookContents(bookId, null);
    const pageContents = await loadPageContents(pages, chMap, 1, null, null, signal());
    let text = pageContents.map(p => p.text).filter(Boolean).join('\n\n').trim();
    if (!text) throw i18nError('job.error.motivNoText');
    if (text.length > SINGLE_PASS_LIMIT) text = text.slice(0, SINGLE_PASS_LIMIT);

    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    const existingThemes = motifsDb.listThemes(bookId, userEmail).map(t => t.name);
    const existingMotifs = motifsDb.listMotifs(bookId, userEmail).map(m => m.name);
    const seen = new Set([...existingThemes, ...existingMotifs].map(n => n.toLowerCase()));

    logger.info(`Motiv-Brainstorm Start: book=${bookId} text=${text.length} Zeichen, Katalog=${seen.size}`);
    updateJob(jobId, { statusText: 'job.phase.motivBrainstorm', progress: 15 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildMotivBrainstormPrompt(text, existingThemes, existingMotifs, BUCH_KONTEXT),
      buildMotivSystemPrompt(),
      15, 95, 3000, 0.3, 2000, undefined, SCHEMA_MOTIV_BRAINSTORM,
    );

    if (!Array.isArray(result?.vorschlaege)) throw i18nError('job.error.motivVorschlaegeMissing');
    const vorschlaege = result.vorschlaege
      .filter(v => v && typeof v.name === 'string' && v.name.trim())
      .map(v => ({
        typ: VALID_TYP.has(v.typ) ? v.typ : 'motiv',
        name: v.name.trim().slice(0, 200),
        beschreibung: typeof v.beschreibung === 'string' ? v.beschreibung.trim().slice(0, 2000) : '',
        trigger_terms: Array.isArray(v.trigger_terms)
          ? v.trigger_terms.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 80)).slice(0, 12)
          : [],
      }))
      // Dubletten zum Katalog raus (case-insensitive), In-Batch-Dubletten auch.
      .filter(v => {
        const key = v.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    completeJob(jobId, { vorschlaege, tokensIn: tok.in, tokensOut: tok.out },
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
