'use strict';
const crypto = require('crypto');
const express = require('express');
const {
  db, getBookSettings, upsertBookByName,
  loadChapterReviewCache, saveChapterReviewCache,
  loadBookReviewCache, saveBookReviewCache,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents, groupByChapter, splitGroupsIntoChunks, buildSinglePassBookText,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers, settledAll,
  _modelName, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody,
} = require('./shared');
const { narrativeLabels } = require('./narrative-labels');
const { loadReviewKomplettContext } = require('./review-context');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const appSettings = require('../../lib/app-settings');
const { resolveProvider } = require('../../lib/ai');

// Stabile, kurze Signatur für strukturierte Prompt-Vars (narrative,
// reviewSchwerpunkt, komplettContext). Identischer Inhalt → identische Sig.
function _sigHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 12);
}

// pages_sig pro Chunk (analog Komplettanalyse): page_id:updated_at sortiert,
// plus alle Prompt-Vars, die das Kapitelanalyse-Ergebnis beeinflussen.
function buildChapterPagesSig(chunk, { narrativeSig, cacheVersion }) {
  const pages = chunk.pages.map(p => `${p.id}:${p.updated_at || ''}`).sort().join('|');
  return `${pages}||${chunk.name}||${narrativeSig}||${cacheVersion}`;
}

// pages_sig fürs ganze Buch (Single-Pass-Review).
function buildBookReviewPagesSig(pageContents, { bookName, optionsSig, cacheVersion }) {
  const pages = pageContents
    .map(p => `${p.id}:${p.updated_at || ''}|${p.chapter_id ?? ''}:${p.chapter ?? ''}`)
    .sort()
    .join('|');
  return `${pages}||${bookName}||${optionsSig}||${cacheVersion}`;
}

const reviewRouter = express.Router();

// ── Job: Buchbewertung ────────────────────────────────────────────────────────
async function runReviewJob(jobId, bookId, bookName, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts();
  const { buildBookReviewSinglePassPrompt, buildChapterAnalysisPrompt, buildBookReviewMultiPassPrompt, SCHEMA_REVIEW, SCHEMA_CHAPTER_ANALYSIS, getBuchtypReviewSchwerpunkt, PROMPTS_VERSION } = prompts;
  const { SYSTEM_BUCHBEWERTUNG_BLOCKS: SYSTEM_BUCHBEWERTUNG, SYSTEM_KAPITELANALYSE_BLOCKS: SYSTEM_KAPITELANALYSE } = await getBookPrompts(bookId, userEmail);
  const bookSettings = getBookSettings(bookId, userEmail);
  const narrative = narrativeLabels(bookSettings);
  // Genre-Schwerpunkt aus prompt-config.json laden und in Buchreview-Prompts
  // einkippen. Kapitelanalyse bleibt schwerpunkt-frei (würde Synthese verzerren).
  const locale = `${bookSettings?.language || 'de'}-${bookSettings?.region || 'CH'}`;
  const reviewSchwerpunkt = getBuchtypReviewSchwerpunkt(locale, bookSettings?.buchtyp || null);
  // Komplett-Daten sind optional: ohne vorhergehende Komplettanalyse bleiben
  // die Buckets leer und der Prompt injiziert keinen Strukturdaten-Block.
  const komplettContext = loadReviewKomplettContext(bookId, userEmail);
  const reviewOptions = { ...narrative, reviewSchwerpunkt, komplettContext };

  const bookIdInt = parseInt(bookId);
  const email = userEmail || '';
  const effectiveProvider = resolveProvider({ userEmail });
  const { singlePass: SINGLE_PASS_LIMIT, perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(effectiveProvider);
  // Cache-Version: Modellname + Prompts-Schema-Version. Ändert sich eins davon,
  // werden alle persistierten Review-Caches automatisch verworfen.
  const cacheVersion = `${_modelName(effectiveProvider)}:${PROMPTS_VERSION || ''}`;
  const narrativeSig = _sigHash(narrative);
  const optionsSig = _sigHash({ schwerpunkt: reviewSchwerpunkt, komplettContext, narrative });
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, pages } = await loadOrderedBookContents(bookId, userToken)
      .catch(e => { throw contentHttpError(e); });

    if (!pages.length) { completeJob(jobId, { empty: true }); return; }
    const tok = { in: 0, out: 0, ms: 0 }; // akkumulierte Token über alle KI-Calls
    logger.info(`Start: «${bookName}» ${pages.length} Seiten`);
    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 60),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    updateJob(jobId, { progress: 65 });
    const { groupOrder, groups } = groupByChapter(pageContents);
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let r;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 65, statusText: 'job.phase.aiBookReview' });
      const bookText = buildSinglePassBookText(groups, groupOrder);
      const bookPagesSig = buildBookReviewPagesSig(pageContents, { bookName, optionsSig, cacheVersion });
      const cached = loadBookReviewCache(bookIdInt, email, bookPagesSig, effectiveProvider);
      if (cached) {
        logger.info(`Single-Pass-Review – Cache-HIT (pages_sig match) – spart Review-Call.`);
        updateJob(jobId, { progress: 97, statusText: 'job.phase.checkpointLoaded' });
        r = cached;
      } else {
        r = await aiCall(jobId, tok,
          buildBookReviewSinglePassPrompt(bookName, pageContents.length, bookText, reviewOptions),
          SYSTEM_BUCHBEWERTUNG,
          65, 97, 5000, 0.2, null, undefined, SCHEMA_REVIEW,
        );
        saveBookReviewCache(bookIdInt, email, bookPagesSig, r, effectiveProvider);
      }
    } else {
      const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, PER_CHUNK_LIMIT);
      const chapterAnalyses = [];
      let completed = 0;
      let cacheHits = 0;

      const thunks = chunkOrder.map((key, gi) => async () => {
        if (jobAbortControllers.get(jobId)?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const chunk = chunks.get(key);
        const fromPct = 65 + Math.round((gi / chunkOrder.length) * 25);
        const toPct   = 65 + Math.round(((gi + 1) / chunkOrder.length) * 25);
        const pagesSig = buildChapterPagesSig(chunk, { narrativeSig, cacheVersion });
        const cached = loadChapterReviewCache(bookIdInt, email, key, pagesSig, effectiveProvider);
        if (cached) {
          cacheHits++;
          completed++;
          updateJob(jobId, {
            progress: toPct,
            statusText: 'job.phase.analyzing',
            statusParams: { current: gi + 1, total: chunkOrder.length, name: chunk.name },
          });
          logger.info(`[${completed}/${chunkOrder.length}] «${chunk.name}» – Cache-HIT`);
          return { name: chunk.name, pageCount: chunk.pages.length, ...cached };
        }
        updateJob(jobId, {
          progress: fromPct,
          statusText: 'job.phase.analyzing',
          statusParams: { current: gi + 1, total: chunkOrder.length, name: chunk.name },
        });
        const chText = chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(chunk.name, bookName, chunk.pages.length, chText, narrative),
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500, 0.2, null, undefined, SCHEMA_CHAPTER_ANALYSIS,
        );
        saveChapterReviewCache(bookIdInt, email, key, pagesSig, ca, effectiveProvider);
        completed++;
        logger.info(`[${completed}/${chunkOrder.length}] «${chunk.name}» analysiert (${chunk.pages.length} Seiten)`);
        return { name: chunk.name, pageCount: chunk.pages.length, ...ca };
      });

      const results = await settledAll(thunks);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        chapterAnalyses.push(result.value);
      }
      if (cacheHits > 0) {
        logger.info(`Kapitelanalyse: ${cacheHits}/${chunkOrder.length} aus Cache (Delta-Cache spart Calls).`);
      }

      updateJob(jobId, {
        progress: 90,
        statusText: 'job.phase.finalReview',
      });
      r = await aiCall(jobId, tok,
        buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, pageContents.length, reviewOptions),
        SYSTEM_BUCHBEWERTUNG,
        90, 97, 5000, 0.2, null, undefined, SCHEMA_REVIEW,
      );
    }

    if (r?.gesamtnote == null) throw i18nError('job.error.gesamtnoteMissing');

    const model = _modelName(appSettings.get('ai.provider') || 'claude');
    if (bookName) upsertBookByName(parseInt(bookId), bookName);
    db.prepare('INSERT INTO book_reviews (book_id, reviewed_at, review_json, model, user_email) VALUES (?, ?, ?, ?, ?)')
      .run(parseInt(bookId), new Date().toISOString(), JSON.stringify(r), model, userEmail || null);

    completeJob(jobId, { review: r, pageCount: pageContents.length, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `«${bookName}» ${pageContents.length} Seiten, Note ${r.gesamtnote}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
reviewRouter.post('/review', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  const { requireBookAccess, sendACLError } = require('../../lib/acl');
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  const userToken = null;
  const existing = findActiveJobId('review', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.reviewBook' : 'job.label.review';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('review', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runReviewJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

module.exports = { reviewRouter, runReviewJob };
