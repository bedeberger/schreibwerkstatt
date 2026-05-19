'use strict';

// Folder-Import-Job. Empfaengt ein ZIP-Archiv (Struktur YYYY/Monat/Tagesdatei),
// entpackt es, erkennt Datumsformate via Regel-Heuristik (+AI-Fallback wenn
// Confidence < Threshold), parst .docx via mammoth und .odt via eigenem Mini-
// Parser, und legt Kapitel pro Jahr + Seiten pro Tag via Content-Store an.
//
// ZIP-Buffer landet beim POST in `importBuffers`-Map und wird vom Worker konsumiert.

const express = require('express');
const JSZip = require('jszip');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, jobs, createJob, enqueueJob, findActiveJobId,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { detectDate, scoreSample } = require('../../lib/import-parsers/date-detect');
const { parseImportFile, extOf } = require('../../lib/import-parsers/dispatch');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { resolveProvider } = require('../../lib/ai');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const logger = require('../../logger');

const router = express.Router();

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CONFIDENCE_THRESHOLD = 0.8;
const AI_SAMPLE_SIZE = 30;
const BUFFER_TTL_MS = 30 * 60 * 1000;

// jobId -> { buffer, mode, bookName, bookId }
const importBuffers = new Map();

function _scheduleBufferCleanup(jobId) {
  const t = setTimeout(() => importBuffers.delete(jobId), BUFFER_TTL_MS);
  t.unref?.();
}

function _parsePath(p) {
  // Erwartet: "<YYYY>/<Monat>/<Datei>". Trim Mac-Resource-Forks und Hidden-Files.
  const norm = p.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = norm.split('/');
  if (parts.length < 3) return null;
  if (parts.some(seg => seg.startsWith('._') || seg === '.DS_Store' || seg === '__MACOSX')) return null;
  const baseFile = parts[parts.length - 1];
  if (!baseFile || baseFile.startsWith('.')) return null;
  // Erstes Element mit 4-stelliger Jahreszahl als Jahr-Ordner nehmen.
  let yearIdx = -1;
  for (let i = 0; i < parts.length - 2; i += 1) {
    if (/^\d{4}$/.test(parts[i])) { yearIdx = i; break; }
  }
  if (yearIdx < 0) return null;
  const year = parseInt(parts[yearIdx], 10);
  const monthRaw = parts[yearIdx + 1];
  const file = parts.slice(yearIdx + 2).join('/');
  return { year, monthRaw, file, fullPath: parts.slice(yearIdx).join('/') };
}

function _monthFromRaw(monthRaw) {
  const { parseMonthToken } = require('../../lib/import-parsers/date-detect');
  return parseMonthToken(monthRaw);
}

async function _detectDatesViaAI(samples, log) {
  try {
    const prompts = await getPrompts();
    const { buildDateDetectPrompt, SCHEMA_DATE_DETECT } = prompts;
    const SYSTEM = 'Du bist ein Assistent fuer das Erkennen von Datumsformaten in Dateinamen. Du antwortest ausschliesslich mit einem JSON-Objekt.';
    const prompt = buildDateDetectPrompt(samples);
    // Use minimal jobId stub so aiCall does not error if jobId missing — actually
    // it needs jobs.get(jobId) for abort signal. Call inside worker with real jobId.
    return { prompt, system: SYSTEM, schema: SCHEMA_DATE_DETECT };
  } catch (e) {
    log.warn(`AI date-detect prompt build failed: ${e.message}`);
    return null;
  }
}

async function runFolderImportJob(jobId, { userEmail, mode, bookName, bookId }) {
  const log = makeJobLogger(jobId);
  try {
    const entry = importBuffers.get(jobId);
    if (!entry) throw i18nError('job.error.importBufferMissing');
    const { buffer } = entry;

    updateJob(jobId, { progress: 5, statusText: 'job.folder-import.unpacking' });
    const zip = await JSZip.loadAsync(buffer);

    const files = [];
    const skipped = [];
    zip.forEach((relativePath, file) => {
      if (file.dir) return;
      const parsed = _parsePath(relativePath);
      if (!parsed) {
        skipped.push({ path: relativePath, reason: 'BAD_PATH' });
        return;
      }
      const ext = extOf(parsed.file);
      if (ext !== 'docx' && ext !== 'odt') {
        skipped.push({ path: relativePath, reason: 'UNSUPPORTED_EXT' });
        return;
      }
      files.push({ relativePath, zipEntry: file, ...parsed });
    });

    if (!files.length) {
      throw i18nError('job.error.emptyArchive');
    }
    log.info(`folder-import: ${files.length} Dateien gefunden, ${skipped.length} skipped`);

    updateJob(jobId, { progress: 10, statusText: 'job.folder-import.detectingDates' });

    // Sample fuer Pattern-Scoring (erste 20 Filenames mit Path-Context)
    const samplePool = files.slice(0, 20).map(f => ({
      filename: f.file,
      year: f.year,
      month: _monthFromRaw(f.monthRaw),
    }));
    const score = scoreSample(samplePool);
    log.info(`date-detect score: ${(score.confidence * 100).toFixed(0)}% (pattern=${score.pattern || 'none'})`);

    let aiDateMap = null;
    if (score.confidence < CONFIDENCE_THRESHOLD) {
      log.info(`Confidence < ${CONFIDENCE_THRESHOLD * 100}% -> AI-Fallback`);
      updateJob(jobId, { progress: 15, statusText: 'job.folder-import.aiDateDetect' });
      try {
        const aiSamples = files.slice(0, AI_SAMPLE_SIZE).map(f => ({
          path: f.fullPath,
          year: f.year,
          month: _monthFromRaw(f.monthRaw),
        }));
        const prompts = await getPrompts();
        const { buildDateDetectPrompt, SCHEMA_DATE_DETECT } = prompts;
        const SYSTEM = 'Du bist ein Assistent fuer das Erkennen von Datumsformaten in Dateinamen. Antworte ausschliesslich mit einem JSON-Objekt.';
        const tok = { in: 0, out: 0, ms: 0 };
        const result = await aiCall(
          jobId, tok,
          buildDateDetectPrompt(aiSamples),
          SYSTEM,
          15, 25, 2000, 0.2, 4000, undefined, SCHEMA_DATE_DETECT,
        );
        if (Array.isArray(result?.dateien)) {
          aiDateMap = new Map();
          for (const d of result.dateien) {
            if (d && typeof d.path === 'string' && typeof d.iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.iso)) {
              aiDateMap.set(d.path, d.iso);
            }
          }
          log.info(`AI date-detect: ${aiDateMap.size}/${aiSamples.length} resolved`);
        }
      } catch (e) {
        log.warn(`AI date-detect failed: ${e.message}`);
      }
    }

    // Pro Datei Datum bestimmen
    const enriched = [];
    for (const f of files) {
      const month = _monthFromRaw(f.monthRaw);
      const ctx = { year: f.year, month };
      let isoDate = null;
      const ruleResult = detectDate(f.file, ctx);
      if (ruleResult) isoDate = ruleResult.iso;
      if (!isoDate && aiDateMap) {
        const aiIso = aiDateMap.get(f.fullPath);
        if (aiIso) isoDate = aiIso;
      }
      if (!isoDate) {
        skipped.push({ path: f.relativePath, reason: 'NO_DATE' });
        continue;
      }
      enriched.push({ ...f, isoDate });
    }

    if (!enriched.length) {
      throw i18nError('job.error.noDatesFound');
    }

    // Sortieren chronologisch
    enriched.sort((a, b) => a.isoDate.localeCompare(b.isoDate));

    // Buch sicherstellen
    let effBookId = bookId;
    if (mode === 'new-book') {
      updateJob(jobId, { progress: 28, statusText: 'job.folder-import.creatingBook' });
      const created = await contentStore.createBook({ name: bookName, owner_email: userEmail }, { session: { user: { email: userEmail } } });
      effBookId = created.id;
      log.info(`Buch erstellt: «${bookName}» id=${effBookId}`);
    }
    if (!effBookId) throw i18nError('job.error.bookMissing');
    setContext({ book: effBookId });

    // Kapitel-Cache: pro Jahr ein Chapter
    const chapterByYear = new Map();
    if (mode === 'merge') {
      const existing = await contentStore.listChapters(effBookId, { session: { user: { email: userEmail } } });
      for (const ch of existing) {
        const y = parseInt(ch.name, 10);
        if (Number.isFinite(y) && /^\d{4}$/.test(String(ch.name).trim())) {
          chapterByYear.set(y, ch.id);
        }
      }
    }

    // Pages anlegen
    const total = enriched.length;
    let current = 0;
    const dateSeen = new Map(); // iso -> count (fuer Duplikat-Suffix)
    const warnings = [];
    let pagesCreated = 0;

    for (const f of enriched) {
      current += 1;
      const progress = 30 + Math.round(65 * (current / total));
      updateJob(jobId, {
        progress,
        statusText: 'job.folder-import.parsing',
        statusParams: { file: f.relativePath, current, total },
      });

      // Chapter pro Jahr
      let chapterId = chapterByYear.get(f.year);
      if (!chapterId) {
        const ch = await contentStore.createChapter(
          { book_id: effBookId, name: String(f.year) },
          { session: { user: { email: userEmail } } },
        );
        chapterId = ch.id;
        chapterByYear.set(f.year, chapterId);
        log.info(`Chapter angelegt: ${f.year} (id=${chapterId})`);
      }

      // Parse
      let buf;
      try {
        buf = await f.zipEntry.async('nodebuffer');
      } catch (e) {
        skipped.push({ path: f.relativePath, reason: 'ZIP_READ_FAILED' });
        continue;
      }
      if (buf.length > MAX_FILE_BYTES) {
        skipped.push({ path: f.relativePath, reason: 'FILE_TOO_LARGE' });
        continue;
      }
      let parsed;
      try {
        parsed = await parseImportFile(f.file, buf);
      } catch (e) {
        log.warn(`Parse fail ${f.relativePath}: ${e.message}`);
        skipped.push({ path: f.relativePath, reason: 'PARSE_FAILED' });
        continue;
      }
      if (!parsed) {
        skipped.push({ path: f.relativePath, reason: 'UNSUPPORTED_EXT' });
        continue;
      }
      if (parsed.warnings?.length) {
        warnings.push({ path: f.relativePath, items: parsed.warnings });
      }

      // Name: ISO-Date, bei Duplikat Suffix
      const count = dateSeen.get(f.isoDate) || 0;
      dateSeen.set(f.isoDate, count + 1);
      const pageName = count === 0 ? f.isoDate : `${f.isoDate} (${count + 1})`;

      try {
        await contentStore.createPage(
          {
            book_id: effBookId,
            chapter_id: chapterId,
            name: pageName,
            html: parsed.html,
          },
          { session: { user: { email: userEmail } } },
        );
        pagesCreated += 1;
      } catch (e) {
        log.warn(`createPage fail ${f.relativePath}: ${e.message}`);
        skipped.push({ path: f.relativePath, reason: 'CREATE_FAILED' });
      }
    }

    log.info(`folder-import done: ${pagesCreated} pages, ${chapterByYear.size} chapters, ${skipped.length} skipped`);

    completeJob(jobId, {
      bookId: effBookId,
      pagesCreated,
      chaptersCreated: chapterByYear.size,
      skipped,
      warnings,
    });
  } catch (e) {
    if (e?.name !== 'AbortError') log.error(`folder-import job ${jobId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  } finally {
    importBuffers.delete(jobId);
  }
}

const rawZipBody = express.raw({
  type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'],
  limit: MAX_ZIP_BYTES + 1,
});

router.post('/folder-import', rawZipBody, async (req, res) => {
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHENTICATED' });

  const mode = (req.query?.mode === 'merge') ? 'merge' : 'new-book';
  const bookName = String(req.query?.book_name || '').trim();
  const bookId = mode === 'merge' ? toIntId(req.query?.book_id) : null;

  if (mode === 'new-book' && !bookName) {
    return res.status(400).json({ error_code: 'BOOK_NAME_REQUIRED' });
  }
  if (mode === 'merge' && !bookId) {
    return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  }

  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error_code: 'EMPTY_BODY' });
  }
  if (req.body.length > MAX_ZIP_BYTES) {
    return res.status(413).json({ error_code: 'ZIP_TOO_LARGE' });
  }

  if (mode === 'merge') {
    setContext({ book: bookId });
    try { requireBookAccess(req, bookId, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const dedupKey = mode === 'merge' ? `merge:${bookId}` : `new:${bookName}`;
  const existing = findActiveJobId('folder-import', dedupKey, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob(
    'folder-import',
    bookId || 0,
    userEmail,
    'job.label.folderImport',
    { name: bookName || `Book #${bookId}` },
    dedupKey,
  );
  importBuffers.set(jobId, { buffer: req.body, mode, bookName, bookId });
  _scheduleBufferCleanup(jobId);

  enqueueJob(jobId, () => runFolderImportJob(jobId, { userEmail, mode, bookName, bookId }));
  res.status(202).json({ jobId });
});

module.exports = { folderImportRouter: router, runFolderImportJob, importBuffers };
