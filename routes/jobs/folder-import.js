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
const { detectDate, detectDateInText, firstLineFromHtml, extractTitle, scoreSample } = require('../../lib/import-parsers/date-detect');
const { parseImportFile, extOf, SUPPORTED_EXTS } = require('../../lib/import-parsers/dispatch');
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
      if (!SUPPORTED_EXTS.has(ext)) {
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

    // Pro Datei: Datum aus Filename → erste Zeile (nach Parse) → AI-Map.
    // Parse passiert HIER (nicht spaeter), damit Fallback-Quelle "erste
    // Dokumentzeile" verfuegbar ist. HTML + Warnings werden mit-gespeichert,
    // damit createPage spaeter nicht erneut parst.
    updateJob(jobId, { progress: 25, statusText: 'job.folder-import.parsing', statusParams: { file: '', current: 0, total: files.length } });
    const enriched = [];
    const warningsCollected = [];
    let parseCount = 0;
    for (const f of files) {
      parseCount += 1;
      const month = _monthFromRaw(f.monthRaw);
      const ctx = { year: f.year, month };
      let isoDate = null;
      let dateSource = null;

      const ruleResult = detectDate(f.file, ctx);
      if (ruleResult) { isoDate = ruleResult.iso; dateSource = 'filename'; }

      // Datei jetzt parsen — entweder fuer Date-Fallback oder fuer
      // spaeteren Page-Insert.
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

      // Fallback: erste Text-Zeile pruefen
      if (!isoDate) {
        const firstLine = firstLineFromHtml(parsed.html);
        const textResult = detectDateInText(firstLine, ctx);
        if (textResult) { isoDate = textResult.iso; dateSource = 'first-line'; }
      }

      // Fallback: AI-Map
      if (!isoDate && aiDateMap) {
        const aiIso = aiDateMap.get(f.fullPath);
        if (aiIso) { isoDate = aiIso; dateSource = 'ai'; }
      }

      // Fallback: ZIP-Entry-Modified-Date (mtime). Nur akzeptieren wenn:
      //   - Date-Objekt valide UND Jahr >= 1990 (JSZip-Default 1980-01-01 fuer
      //     unset mtimes wuerde sonst alles auf 1980 setzen)
      //   - Jahr matched Pfad-Jahr — sonst ist die mtime ein Artefakt
      //     (Archive-Repack, alle Files auf Archive-Datum gesetzt o.ae.)
      // Pfad-Monat hat Vorrang vor mtime-Monat (User-Organisations-Intent
      // schlaegt Filesystem-Metadaten); nur der Tag wird aus mtime gezogen.
      if (!isoDate && f.zipEntry?.date instanceof Date && !isNaN(f.zipEntry.date)) {
        const mt = f.zipEntry.date;
        const mtYear = mt.getUTCFullYear();
        if (mtYear >= 1990 && mtYear === f.year) {
          const mtMonth = mt.getUTCMonth() + 1;
          const mtDay = mt.getUTCDate();
          const useMonth = Number.isFinite(month) ? month : mtMonth;
          isoDate = `${f.year}-${String(useMonth).padStart(2, '0')}-${String(mtDay).padStart(2, '0')}`;
          dateSource = 'mtime';
        }
      }

      // Letzter Fallback: nur Jahr+Monat aus Pfad ableitbar → synthetisches
      // Datum YYYY-MM-15 (Mitte des Monats fuer Sortierung). Page-Name behaelt
      // den Filename, damit der User sieht, dass kein echtes Datum vorlag.
      if (!isoDate && Number.isFinite(month)) {
        isoDate = `${f.year}-${String(month).padStart(2, '0')}-15`;
        dateSource = 'month-only';
      }

      // Allerletzter Fallback: nur Jahr ableitbar → synthetisches Mid-Year-
      // Datum YYYY-06-15 (sortierbar, Page-Name nutzt YYYY + Thema, damit
      // User sieht dass kein echter Tag vorlag).
      if (!isoDate && Number.isFinite(f.year)) {
        isoDate = `${f.year}-06-15`;
        dateSource = 'year-only';
      }

      if (!isoDate) {
        skipped.push({ path: f.relativePath, reason: 'NO_DATE' });
        continue;
      }

      if (parsed.warnings?.length) {
        warningsCollected.push({ path: f.relativePath, items: parsed.warnings });
      }
      enriched.push({ ...f, isoDate, dateSource, html: parsed.html, month });
    }

    if (!enriched.length) {
      throw i18nError('job.error.noDatesFound');
    }

    log.info(`date-detect breakdown: filename=${enriched.filter(e => e.dateSource === 'filename').length}, first-line=${enriched.filter(e => e.dateSource === 'first-line').length}, ai=${enriched.filter(e => e.dateSource === 'ai').length}, mtime=${enriched.filter(e => e.dateSource === 'mtime').length}, month-only=${enriched.filter(e => e.dateSource === 'month-only').length}, year-only=${enriched.filter(e => e.dateSource === 'year-only').length}`);

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

    // Pages anlegen (HTML stammt aus Enrichment-Pass)
    const total = enriched.length;
    let current = 0;
    const dateSeen = new Map(); // iso -> count (fuer Duplikat-Suffix)
    let pagesCreated = 0;

    for (const f of enriched) {
      current += 1;
      const progress = 30 + Math.round(65 * (current / total));
      updateJob(jobId, {
        progress,
        statusText: 'job.folder-import.creating',
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

      // Page-Name: ISO-Date bei echtem Datum, sonst "YYYY-MM <Thema>" fuer
      // month-only-Eintraege. Thema wird via extractTitle aus Heading/
      // Filename/erster Zeile geholt (siehe lib/import-parsers/date-detect).
      let pageName;
      if (f.dateSource === 'month-only') {
        const ym = f.isoDate.slice(0, 7);
        const thema = extractTitle(f.html, f.file);
        pageName = thema ? `${ym} ${thema}` : ym;
      } else if (f.dateSource === 'year-only') {
        const thema = extractTitle(f.html, f.file);
        pageName = thema ? `${f.year} ${thema}` : String(f.year);
      } else {
        pageName = f.isoDate;
      }
      // Duplikat-Suffix auf pageName (nicht mehr auf isoDate, damit
      // month-only-Eintraege mit unterschiedlichen Filenames eigenstaendig sind)
      const seenCount = dateSeen.get(pageName) || 0;
      dateSeen.set(pageName, seenCount + 1);
      if (seenCount > 0) pageName = `${pageName} (${seenCount + 1})`;

      try {
        await contentStore.createPage(
          {
            book_id: effBookId,
            chapter_id: chapterId,
            name: pageName,
            html: f.html,
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
      warnings: warningsCollected,
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
