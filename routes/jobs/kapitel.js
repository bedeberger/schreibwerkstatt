'use strict';
const crypto = require('crypto');
const express = require('express');
const {
  db, getBookSettings, getTokenForRequest, upsertBookByName,
  loadChapterMacroReviewCache, saveChapterMacroReviewCache,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  bsGet, bsGetAll, jobAbortControllers,
  htmlToText, splitGroupsIntoChunks,
  _modelName, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody, BATCH_SIZE, SINGLE_PASS_LIMIT, PER_CHUNK_LIMIT,
} = require('./shared');
const { narrativeLabels } = require('./narrative-labels');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');

function _sigHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 12);
}

const kapitelRouter = express.Router();

// ── Job: Kapitel-Review (Makrobewertung eines einzelnen Kapitels) ────────────
async function runChapterReviewJob(jobId, bookId, chapterId, chapterName, bookName, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts();
  const {
    buildChapterReviewPrompt, buildChapterReviewMultiPassPrompt,
    buildChapterAnalysisPrompt,
    SCHEMA_CHAPTER_REVIEW, SCHEMA_CHAPTER_ANALYSIS,
    getBuchtypReviewSchwerpunkt,
    PROMPTS_VERSION,
  } = prompts;
  const { SYSTEM_KAPITELREVIEW, SYSTEM_KAPITELANALYSE } = await getBookPrompts(bookId, userEmail);
  const bookSettings = getBookSettings(bookId, userEmail);
  const narrative = narrativeLabels(bookSettings);
  const locale = `${bookSettings?.language || 'de'}-${bookSettings?.region || 'CH'}`;
  const reviewSchwerpunkt = getBuchtypReviewSchwerpunkt(locale, bookSettings?.buchtyp || null);

  const bookIdInt = parseInt(bookId);
  const chapterIdInt = parseInt(chapterId);
  const email = userEmail || '';
  const cacheVersion = `${_modelName(process.env.API_PROVIDER || 'claude')}:${PROMPTS_VERSION || ''}`;
  const optionsSig = _sigHash({ narrative, schwerpunkt: reviewSchwerpunkt });
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    // Alle Buchseiten holen; Kapitel-Filter läuft clientseitig – BookStack
    // liefert in `/pages?filter[book_id]=` bereits `chapter_id` pro Seite.
    const allPages = await bsGetAll('pages?filter[book_id]=' + bookId, userToken);
    const pages = allPages
      .filter(p => String(p.chapter_id || '') === String(chapterId))
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));

    if (!pages.length) { completeJob(jobId, { empty: true, chapterName }); return; }
    logger.info(`Start: «${chapterName}» chap=${chapterId}, ${pages.length} Seiten`);

    // pages_sig: jede Seite + ihr updated_at. Ändert sich eine Seite → Cache-Miss.
    // chapterName + bookName + optionsSig + cacheVersion fliessen ebenfalls ein.
    const pagesSig = pages.map(p => `${p.id}:${p.updated_at || ''}`).sort().join('|')
                     + `||${chapterName}||${bookName}||${optionsSig}||${cacheVersion}`;
    const cached = loadChapterMacroReviewCache(bookIdInt, email, chapterIdInt, pagesSig);
    if (cached) {
      logger.info(`«${chapterName}» – Cache-HIT (pages_sig match) – spart Kapitel-Review-Call.`);
      updateJob(jobId, { progress: 97, statusText: 'job.phase.checkpointLoaded' });
      const model = _modelName(process.env.API_PROVIDER || 'claude');
      if (bookName) upsertBookByName(bookIdInt, bookName);
      db.prepare(`INSERT INTO chapter_reviews
        (book_id, chapter_id, reviewed_at, review_json, model, user_email)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(bookIdInt, chapterIdInt,
          new Date().toISOString(), JSON.stringify(cached), model, userEmail || null);
      completeJob(jobId, {
        review: cached,
        chapterId: chapterIdInt,
        chapterName,
        pageCount: pages.length,
        tokensIn: 0,
        tokensOut: 0,
        cached: true,
      }, null, `«${chapterName}» Cache-HIT, Note ${cached.gesamtnote}`);
      return;
    }

    const tok = { in: 0, out: 0, ms: 0 };
    const signal = jobAbortControllers.get(jobId)?.signal;
    const contents = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      updateJob(jobId, {
        progress: Math.round((i / pages.length) * 60),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, pages.length), total: pages.length },
      });
      const results = await Promise.allSettled(pages.slice(i, i + BATCH_SIZE).map(async p => {
        const pd = await bsGet('pages/' + p.id, userToken);
        const text = htmlToText(pd.html).trim();
        if (!text) return null;
        return { title: p.name, text };
      }));
      for (const r of results) if (r.status === 'fulfilled' && r.value) contents.push(r.value);
    }

    if (!contents.length) { completeJob(jobId, { empty: true, chapterName }); return; }

    const totalChars = contents.reduce((s, p) => s + p.text.length, 0);
    let r;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      const chText = contents.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
      updateJob(jobId, { progress: 65, statusText: 'job.phase.aiChapterReview' });
      r = await aiCall(jobId, tok,
        buildChapterReviewPrompt(chapterName, bookName, contents.length, chText, { ...narrative, reviewSchwerpunkt }),
        SYSTEM_KAPITELREVIEW,
        65, 97, 5000, 0.2, null, undefined, SCHEMA_CHAPTER_REVIEW,
      );
    } else {
      // Kapitel sprengt Input-Budget → in Sub-Chunks zerlegen, je Analyse, dann synthetisieren.
      const groupKey = String(chapterId);
      const baseGroups = new Map([[groupKey, { name: chapterName, pages: contents }]]);
      const { chunkOrder, chunks } = splitGroupsIntoChunks(baseGroups, [groupKey], PER_CHUNK_LIMIT);
      logger.info(`Multi-Pass: ${chunkOrder.length} Teilabschnitte (${totalChars} chars > ${SINGLE_PASS_LIMIT})`);

      const subAnalyses = [];
      for (let i = 0; i < chunkOrder.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const chunk = chunks.get(chunkOrder[i]);
        const fromPct = 65 + Math.round((i / chunkOrder.length) * 25);
        const toPct   = 65 + Math.round(((i + 1) / chunkOrder.length) * 25);
        updateJob(jobId, {
          progress: fromPct,
          statusText: 'job.phase.analyzing',
          statusParams: { current: i + 1, total: chunkOrder.length, name: chapterName },
        });
        const chunkText = chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(chapterName, bookName, chunk.pages.length, chunkText, narrative),
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500, 0.2, null, undefined, SCHEMA_CHAPTER_ANALYSIS,
        );
        subAnalyses.push({ pageCount: chunk.pages.length, ...ca });
      }

      updateJob(jobId, { progress: 90, statusText: 'job.phase.finalReview' });
      r = await aiCall(jobId, tok,
        buildChapterReviewMultiPassPrompt(chapterName, bookName, subAnalyses, contents.length, { ...narrative, reviewSchwerpunkt }),
        SYSTEM_KAPITELREVIEW,
        90, 97, 5000, 0.2, null, undefined, SCHEMA_CHAPTER_REVIEW,
      );
    }

    if (r?.gesamtnote == null) throw i18nError('job.error.gesamtnoteMissing');

    saveChapterMacroReviewCache(bookIdInt, email, chapterIdInt, pagesSig, r);

    const model = _modelName(process.env.API_PROVIDER || 'claude');
    if (bookName) upsertBookByName(parseInt(bookId), bookName);
    db.prepare(`INSERT INTO chapter_reviews
      (book_id, chapter_id, reviewed_at, review_json, model, user_email)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(parseInt(bookId), parseInt(chapterId),
        new Date().toISOString(), JSON.stringify(r), model, userEmail || null);

    completeJob(jobId, {
      review: r,
      chapterId: parseInt(chapterId),
      chapterName,
      pageCount: contents.length,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok), `«${chapterName}» ${contents.length} Seiten, Note ${r.gesamtnote}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (chap=${chapterId}): ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
kapitelRouter.post('/chapter-review', jsonBody, (req, res) => {
  const { chapter_name, book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  const chapter_id = toIntId(req.body?.chapter_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!chapter_id) return res.status(400).json({ error_code: 'CHAPTER_ID_REQUIRED' });
  setContext({ book: book_id });
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  // Dedup auf Kapitel-Ebene – parallele Reviews unterschiedlicher Kapitel sind ok.
  const existing = findActiveJobId('chapter-review', chapter_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = chapter_name ? 'job.label.chapterReviewChapter' : 'job.label.chapterReview';
  const labelParams = chapter_name ? { name: chapter_name } : null;
  const jobId = createJob('chapter-review', book_id, userEmail, label, labelParams, chapter_id);
  enqueueJob(jobId, () => runChapterReviewJob(
    jobId, book_id, chapter_id, chapter_name || '', book_name || '', userEmail, userToken,
  ));
  res.json({ jobId });
});

module.exports = { kapitelRouter, runChapterReviewJob };
