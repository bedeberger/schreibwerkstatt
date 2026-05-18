// Facade: verteilt Schema-/Migrations-Setup und die verbliebenen DB-Helfer
// auf dedizierte Module, exportiert alles gebündelt. Ladereihenfolge matters:
// migrations muss vor allen Modulen laufen, die Prepared Statements auf
// migrierten Spalten anlegen.
const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

const figures = require('./figures');
const pages = require('./pages');
const pdfExport = require('./pdf-export');
const fonts = require('./fonts');
const books = require('./books');
const tokenUsage = require('./token-usage');
const draftFigures = require('./draft-figures');

// ── Job-Laufzeiten ────────────────────────────────────────────────────────────
const _stmtInsJobRun = db.prepare(
  `INSERT INTO job_runs (job_id, type, book_id, user_email, label, provider, model, status, queued_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ${NOW_ISO_SQL})`
);
const _stmtStartJobRun = db.prepare(
  `UPDATE job_runs SET status = 'running', started_at = ${NOW_ISO_SQL} WHERE job_id = ?`
);
const _stmtEndJobRun = db.prepare(
  `UPDATE job_runs SET status = ?, ended_at = ${NOW_ISO_SQL}, tokens_in = ?, tokens_out = ?, cache_read_in = ?, cache_creation_in = ?, tokens_per_sec = ?, error = ?, error_params = ? WHERE job_id = ?`
);

function insertJobRun(job) {
  // bookId normalisieren: System-Jobs (Backfill, Synonym ohne Buch, …) übergeben
  // 0 als „kein Buchkontext". Mig 83 hat die books-Sentinel-Zeile (book_id=0)
  // entfernt → FK `job_runs.book_id REFERENCES books(book_id)` würde brechen.
  // Nicht-positive / nicht-numerische Werte daher als NULL persistieren.
  const bookNum = Number(job.bookId);
  const bookId = Number.isInteger(bookNum) && bookNum > 0 ? bookNum : null;
  _stmtInsJobRun.run(
    job.id, job.type, bookId, job.userEmail || null, job.label || null,
    job.provider || null, job.model || null,
  );
}
function startJobRun(jobId) {
  _stmtStartJobRun.run(jobId);
}
function endJobRun(jobId, status, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, tokensPerSec, error, errorParams = null) {
  const paramsJson = errorParams ? JSON.stringify(errorParams) : null;
  _stmtEndJobRun.run(
    status,
    tokensIn || 0, tokensOut || 0,
    cacheReadIn || 0, cacheCreationIn || 0,
    tokensPerSec ?? null, error || null, paramsJson, jobId,
  );
}

/** Setzt alle hängenden job_runs (status 'running' oder 'queued') auf 'error'.
 *  Gibt die Anzahl bereinigter Einträge zurück. */
function cleanupStuckJobRuns() {
  const result = db.prepare(
    `UPDATE job_runs SET status = 'error', ended_at = ${NOW_ISO_SQL}, error = 'Job-Prozess gestorben (Server-Neustart oder Absturz)'
     WHERE status IN ('running', 'queued')`
  ).run();
  return result.changes;
}

// KI liefert in Listenfeldern (figuren/kapitel/seiten) gelegentlich Objekte
// statt blanker Strings — z.B. `{name: 'Renate', id: 'fig-3'}` oder
// `{name: 'Olten', haeufigkeit: 2}`. Vor dem Persistieren auf String reduzieren,
// damit Renderer nicht "[object Object]" ausgeben.
function _toRefString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const s = v.name || v.titel || v.label || v.fig_id || v.loc_id || v.id;
    return s ? String(s).trim() || null : null;
  }
  return null;
}

// ── Konsolidierter Zeitstrahl ─────────────────────────────────────────────────
// Ersetzt den gesamten Bestand für book/user.
// ereignisse: Array aus KI-Antwort [{datum, ereignis, typ, bedeutung, kapitel[], seiten[], figuren[]}]
// chNameToId: optionaler Map Kapitelname → chapter_id für stabile ID-Referenzen.
// pageNameToIdByChapter: optionaler Map chapter_id → (page_name → page_id) für
// kapitel-scoped Auflösung der seiten-Einträge. Fehlt er, bleiben page_ids leer.
function saveZeitstrahlEvents(bookId, userEmail, ereignisse, chNameToId = {}, pageNameToIdByChapter = null) {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM zeitstrahl_events WHERE book_id = ? AND user_email = ?').run(bookId, userEmail || '');
    const ins = db.prepare(`INSERT INTO zeitstrahl_events
      (book_id, user_email, datum, ereignis, typ, bedeutung, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insZec = db.prepare('INSERT INTO zeitstrahl_event_chapters (event_id, chapter_id, sort_order) VALUES (?, ?, ?)');
    const insZep = db.prepare('INSERT INTO zeitstrahl_event_pages    (event_id, page_id, sort_order)    VALUES (?, ?, ?)');
    const insZef = db.prepare('INSERT INTO zeitstrahl_event_figures  (event_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)');
    // figures-Lookup TEXT-fig_id → INTEGER figures.id (FK-Target seit Mig 73).
    const figRows = db.prepare(
      'SELECT id, fig_id, name, kurzname FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, userEmail || null);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const figNameToRowId = {};
    for (const r of figRows) {
      for (const n of [r.name, r.kurzname]) {
        if (n) figNameToRowId[n.toLowerCase()] = r.id;
      }
    }
    for (let i = 0; i < ereignisse.length; i++) {
      const ev = ereignisse[i];
      const { lastInsertRowid: eventId } = ins.run(
        bookId, userEmail || '',
        ev.datum || '', ev.ereignis || '', ev.typ || 'persoenlich', ev.bedeutung || null,
        i, now
      );

      const rawKapitel = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
      const kapitelArr = rawKapitel.map(_toRefString).filter(Boolean);
      const chapIds = kapitelArr.map(n => chNameToId?.[n] ?? null).filter(id => id != null);
      const seenChap = new Set();
      let j = 0;
      for (const cid of chapIds) {
        if (seenChap.has(cid)) continue;
        seenChap.add(cid);
        insZec.run(eventId, cid, j++);
      }

      const rawSeiten = Array.isArray(ev.seiten) ? ev.seiten : [];
      const seitenArr = rawSeiten.map(_toRefString).filter(Boolean);
      // Seiten auflösen: erst kapitel-scoped, dann Unambiguous-Match.
      // Halluzinations-Check: seite === kapitel → skip.
      const seenPage = new Set();
      j = 0;
      if (pageNameToIdByChapter) {
        for (const seite of seitenArr) {
          if (!seite || kapitelArr.includes(seite) || seite === 'Sonstige Seiten') continue;
          let pid = null;
          for (const chId of chapIds) {
            pid = pageNameToIdByChapter[chId]?.[seite] ?? null;
            if (pid) break;
          }
          if (pid == null) {
            const cand = [];
            for (const m of Object.values(pageNameToIdByChapter)) {
              if (m[seite]) cand.push(m[seite]);
            }
            if (cand.length === 1) pid = cand[0];
          }
          if (pid != null && !seenPage.has(pid)) {
            seenPage.add(pid);
            insZep.run(eventId, pid, j++);
          }
        }
      }

      // figuren: [{id, name, typ}] oder ["Name"]. id (TEXT-fig_id) per Lookup auf
      // INTEGER figures.id auflösen; Strings via Name-Lookup; figur_name als
      // Snapshot wenn kein figures-Match.
      const rawFiguren = Array.isArray(ev.figuren) ? ev.figuren : [];
      const seenFig = new Set();
      j = 0;
      for (const f of rawFiguren) {
        if (f == null) continue;
        let name = null, rowId = null;
        if (typeof f === 'string') {
          name = f.trim() || null;
          if (name) rowId = figNameToRowId[name.toLowerCase()] ?? null;
        } else if (typeof f === 'object') {
          name = (f.name || f.kurzname || '').trim() || null;
          if (f.id) rowId = figIdToRowId[String(f.id)] ?? null;
          if (rowId == null && name) rowId = figNameToRowId[name.toLowerCase()] ?? null;
        }
        if (!name && rowId == null) continue;
        const key = (rowId ?? '') + '|' + (name || '').toLowerCase();
        if (seenFig.has(key)) continue;
        seenFig.add(key);
        insZef.run(eventId, rowId, name, j++);
      }
    }
  })();
}

// ── Orte ──────────────────────────────────────────────────────────────────────
// UPSERT by loc_id statt Delete+Re-Insert, damit bestehende scene_locations-Einträge
// (ON DELETE CASCADE) erhalten bleiben.
// chNameToId: optionaler Map Kapitelname → chapter_id. Wird er nicht übergeben,
// wird er aus der chapters-Tabelle aufgebaut (für UI-Endpunkt ohne Job-Kontext).
// pageNameToIdByChapter: optional. Fehlt er, wird er aus der pages-Tabelle
// aufgebaut — kapitel-scoped gegen Namenskollisionen zwischen Kapiteln.
function saveOrteToDb(bookId, orte, userEmail, chNameToId = null, pageNameToIdByChapter = null) {
  if (chNameToId == null) {
    const rows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
    chNameToId = Object.fromEntries(rows.map(r => [r.chapter_name, r.chapter_id]));
  }
  if (pageNameToIdByChapter == null) {
    const rows = db.prepare('SELECT page_id, page_name, chapter_id FROM pages WHERE book_id = ?').all(bookId);
    pageNameToIdByChapter = {};
    for (const r of rows) {
      const k = r.chapter_id ?? 0;
      (pageNameToIdByChapter[k] ??= {})[r.page_name] = r.page_id;
    }
  }
  // Löst erste_erwaehnung einer Location auf eine konkrete page_id auf.
  // Scope: Kapitel aus location_chapters (o.kapitel). Fallback: Unambiguous-Match.
  const resolveErstePageIdForOrt = (ersteErwaehnung, kapitel) => {
    if (!ersteErwaehnung) return null;
    for (const k of (kapitel || [])) {
      const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
      const chapId = chName ? chNameToId?.[chName] : null;
      if (chapId != null) {
        const pid = pageNameToIdByChapter[chapId]?.[ersteErwaehnung];
        if (pid) return pid;
      }
    }
    const cand = [];
    for (const m of Object.values(pageNameToIdByChapter)) {
      if (m[ersteErwaehnung]) cand.push(m[ersteErwaehnung]);
    }
    return cand.length === 1 ? cand[0] : null;
  };
  const now = new Date().toISOString();
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];

  db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, loc_id FROM locations WHERE book_id = ? AND ${emailCond}`
    ).all(bookId, ...emailVal);
    const existingMap = Object.fromEntries(existing.map(r => [r.loc_id, r.id]));

    const newLocIds = new Set(orte.map(o => o.id));

    // Entfernte Orte löschen (CASCADE entfernt location_figures, location_chapters, scene_locations)
    for (const { id, loc_id } of existing) {
      if (!newLocIds.has(loc_id)) {
        db.prepare('DELETE FROM locations WHERE id = ?').run(id);
      }
    }

    const upd = db.prepare(`
      UPDATE locations SET name=?, typ=?, beschreibung=?, erste_erwaehnung=?, erste_erwaehnung_page_id=?, stimmung=?,
        sort_order=?, updated_at=?
      WHERE id=?`);
    const ins = db.prepare(`
      INSERT INTO locations (book_id, loc_id, name, typ, beschreibung, erste_erwaehnung, erste_erwaehnung_page_id, stimmung,
        sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const delLf = db.prepare('DELETE FROM location_figures WHERE location_id = ?');
    const delLc = db.prepare('DELETE FROM location_chapters WHERE location_id = ?');
    // location_figures.figure_id ist INTEGER (figures.id) seit Mig 73 — Lookup TEXT → INT.
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, userEmail || null);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const insLf = db.prepare('INSERT OR IGNORE INTO location_figures (location_id, figure_id) VALUES (?, ?)');
    const insLc = db.prepare('INSERT INTO location_chapters (location_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)');

    for (let i = 0; i < orte.length; i++) {
      const o = orte[i];
      const erstPageId = resolveErstePageIdForOrt(o.erste_erwaehnung, o.kapitel);
      let locDbId = existingMap[o.id];
      if (locDbId !== undefined) {
        // integer id (und scene_locations) bleibt erhalten
        upd.run(o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, erstPageId, o.stimmung || null,
          i, now, locDbId);
        delLf.run(locDbId);
        delLc.run(locDbId);
      } else {
        const { lastInsertRowid } = ins.run(
          bookId, o.id, o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, erstPageId, o.stimmung || null,
          i, userEmail || null, now
        );
        locDbId = lastInsertRowid;
      }
      for (const fid of (o.figuren || [])) {
        const ref = _toRefString(fid);
        const rowId = ref ? figIdToRowId[ref] : null;
        if (rowId != null) insLf.run(locDbId, rowId);
      }
      for (const k of (o.kapitel || [])) {
        const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
        if (!chName) continue;
        const chapId = chNameToId?.[chName] ?? null;
        const haeufigkeit = (k && typeof k === 'object' && k.haeufigkeit) || 1;
        if (chapId != null) insLc.run(locDbId, chapId, haeufigkeit);
      }
    }
  })();
}

// Backfill für location_chapters: ergänzt fehlende Kapitel-Zuordnungen aus
// scene_locations → figure_scenes.chapter_id. Nutzt INSERT OR IGNORE — bestehende
// Einträge (Primary-Key location_id+chapter_id) bleiben unverändert (haeufigkeit
// wird nicht überschrieben). Deckt Fall ab: AI liefert für Ort kein kapitel-Array,
// aber Ort hängt an Szene mit aufgelöstem chapter_id.
function backfillLocationChaptersFromScenes(bookId, userEmail) {
  const emailCond = userEmail ? 'fs.user_email = ?' : 'fs.user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];
  db.prepare(`
    INSERT OR IGNORE INTO location_chapters (location_id, chapter_id, haeufigkeit)
    SELECT sl.location_id, fs.chapter_id, COUNT(*)
    FROM scene_locations sl
    JOIN figure_scenes fs ON fs.id = sl.scene_id
    WHERE fs.book_id = ? AND ${emailCond} AND fs.chapter_id IS NOT NULL
    GROUP BY sl.location_id, fs.chapter_id
  `).run(bookId, ...emailVal);
}

// ── Job-Checkpoints ───────────────────────────────────────────────────────────
// Speichert Zwischenergebnisse für Multi-Pass-Jobs, damit diese nach einem
// Server-Neustart fortgesetzt werden können statt von vorne zu beginnen.
// user_email wird als '' (Leerstring) gespeichert wenn null, damit der
// UNIQUE-Constraint über (job_type, book_id, user_email) korrekt greift.

const _saveCheckpoint = db.prepare(`
  INSERT INTO job_checkpoints (job_type, book_id, user_email, data, updated_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(job_type, book_id, user_email) DO UPDATE SET
    data = excluded.data, updated_at = excluded.updated_at
`);
const _loadCheckpoint = db.prepare(
  'SELECT data FROM job_checkpoints WHERE job_type = ? AND book_id = ? AND user_email = ?'
);
const _deleteCheckpoint = db.prepare(
  'DELETE FROM job_checkpoints WHERE job_type = ? AND book_id = ? AND user_email = ?'
);

function saveCheckpoint(jobType, bookId, userEmail, data) {
  _saveCheckpoint.run(jobType, parseInt(bookId), userEmail || '', JSON.stringify(data));
}
function loadCheckpoint(jobType, bookId, userEmail) {
  const row = _loadCheckpoint.get(jobType, parseInt(bookId), userEmail || '');
  return row ? JSON.parse(row.data) : null;
}
function deleteCheckpoint(jobType, bookId, userEmail) {
  _deleteCheckpoint.run(jobType, parseInt(bookId), userEmail || '');
}

// ── Delta-Cache: Phase-1-Extraktion pro Kapitel + Buch-Level ──────────────────
// pages_sig: sortierter String aus "page_id:updated_at"-Paaren aller Seiten.
// Ändert sich irgendeine Seite, ändert sich die Signatur → Cache-Miss → Neu-Extraktion.
//
// chapter_extract_cache: pro Kapitel (FK auf chapters.chapter_id, Mig 75).
//   PK (book_id, user_email, chapter_id, phase). phase ∈
//     '' (full chunk), 'figuren'/'orte' (Lokal split-Pässe),
//     'sub<N>'(:figuren|:orte)? (sub-chunk wenn Kapitel zu lang).
// book_extract_cache: Buch-Level-Single-Pass (Mig 75, kein FK-Target — book_id extern).
//
// chapterKey-Format (Legacy-API): <chapter_id>(__sub<N>)?(:phase)? oder '__singlepass__'.

function _parseChapterKey(key) {
  if (key === '__singlepass__') return { book: true };
  const m = String(key).match(/^(\d+)(__sub\d+)?(?::(.+))?$/);
  if (!m) return null;
  const chapterId = parseInt(m[1]);
  const sub = m[2] ? m[2].slice(2) : '';
  const phaseSuffix = m[3] || '';
  const phase = sub ? (phaseSuffix ? `${sub}:${phaseSuffix}` : sub) : phaseSuffix;
  return { chapterId, phase };
}

// provider in PK. Caller MUSS den resolvten Provider durchreichen,
// sonst landet Claude-Output unter '' (Backfill-Default) und Ollama-User
// kriegt es ausgeliefert.
const _loadChapterCache = db.prepare(
  `SELECT extract_json FROM chapter_extract_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND phase = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_extract_cache
   (book_id, user_email, chapter_id, phase, provider, pages_sig, extract_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _loadBookCache = db.prepare(
  `SELECT extract_json FROM book_extract_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND pages_sig = ?`
);
const _saveBookCache = db.prepare(
  `INSERT OR REPLACE INTO book_extract_cache
   (book_id, user_email, provider, pages_sig, extract_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

function loadChapterExtractCache(bookId, userEmail, chapterKey, pagesSig, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed) return null;
  const row = parsed.book
    ? _loadBookCache.get(parseInt(bookId), userEmail || '', provider || '', pagesSig)
    : _loadChapterCache.get(parseInt(bookId), userEmail || '', parsed.chapterId, parsed.phase, provider || '', pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.extract_json); } catch { return null; }
}

function saveChapterExtractCache(bookId, userEmail, chapterKey, pagesSig, extract, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed) return;
  const json = JSON.stringify(extract);
  const now = new Date().toISOString();
  if (parsed.book) {
    _saveBookCache.run(parseInt(bookId), userEmail || '', provider || '', pagesSig, json, now);
  } else {
    _saveChapterCache.run(parseInt(bookId), userEmail || '', parsed.chapterId, parsed.phase, provider || '', pagesSig, json, now);
  }
}

const _deleteChapterCache = db.prepare(
  `DELETE FROM chapter_extract_cache WHERE book_id = ? AND user_email = ?`
);
const _deleteBookCache = db.prepare(
  `DELETE FROM book_extract_cache WHERE book_id = ? AND user_email = ?`
);

function deleteChapterExtractCache(bookId, userEmail) {
  const c = _deleteChapterCache.run(parseInt(bookId), userEmail || '').changes;
  const b = _deleteBookCache.run(parseInt(bookId), userEmail || '').changes;
  return c + b;
}

// ── Delta-Cache: Buch-Review (Kapitelanalyse + Single-Pass-Review) ────────────
// Spart bei grossen Büchern den Kapitelanalyse-Call, wenn pages_sig identisch
// (page_id:updated_at + Prompt-Vars). chapterKey-Format identisch zum Extract-
// Cache: '<chapter_id>(__sub<N>)?' oder '__singlepass__'.
const _loadChapterReviewCache = db.prepare(
  `SELECT review_json FROM chapter_review_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND phase = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterReviewCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_review_cache
   (book_id, user_email, chapter_id, phase, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _loadBookReviewCache = db.prepare(
  `SELECT review_json FROM book_review_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND pages_sig = ?`
);
const _saveBookReviewCache = db.prepare(
  `INSERT OR REPLACE INTO book_review_cache
   (book_id, user_email, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

function loadChapterReviewCache(bookId, userEmail, chapterKey, pagesSig, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed || parsed.book) return null;
  const row = _loadChapterReviewCache.get(
    parseInt(bookId), userEmail || '', parsed.chapterId, parsed.phase, provider || '', pagesSig
  );
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveChapterReviewCache(bookId, userEmail, chapterKey, pagesSig, review, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed || parsed.book) return;
  _saveChapterReviewCache.run(
    parseInt(bookId), userEmail || '', parsed.chapterId, parsed.phase, provider || '',
    pagesSig, JSON.stringify(review), new Date().toISOString(),
  );
}

function loadBookReviewCache(bookId, userEmail, pagesSig, provider = '') {
  const row = _loadBookReviewCache.get(parseInt(bookId), userEmail || '', provider || '', pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveBookReviewCache(bookId, userEmail, pagesSig, review, provider = '') {
  _saveBookReviewCache.run(
    parseInt(bookId), userEmail || '', provider || '', pagesSig,
    JSON.stringify(review), new Date().toISOString(),
  );
}

const _deleteChapterReviewCache = db.prepare(
  `DELETE FROM chapter_review_cache WHERE book_id = ? AND user_email = ?`
);
const _deleteBookReviewCache = db.prepare(
  `DELETE FROM book_review_cache WHERE book_id = ? AND user_email = ?`
);

function deleteReviewCache(bookId, userEmail) {
  const c = _deleteChapterReviewCache.run(parseInt(bookId), userEmail || '').changes;
  const b = _deleteBookReviewCache.run(parseInt(bookId), userEmail || '').changes;
  return c + b;
}

// ── Delta-Cache: Kapitel-Makro-Review (kapitel.js) ────────────────────────────
// Single-Row pro Kapitel (Endergebnis). Sub-Chunk-Caches der Multi-Pass-Variante
// werden bewusst NICHT gecached (sehr seltener Fall, eigene Tabelle wäre Overhead).
const _loadChapterMacroReviewCache = db.prepare(
  `SELECT review_json FROM chapter_macro_review_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterMacroReviewCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_macro_review_cache
   (book_id, user_email, chapter_id, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const _deleteChapterMacroReviewCache = db.prepare(
  `DELETE FROM chapter_macro_review_cache WHERE book_id = ? AND user_email = ?`
);

function loadChapterMacroReviewCache(bookId, userEmail, chapterId, pagesSig, provider = '') {
  const row = _loadChapterMacroReviewCache.get(
    parseInt(bookId), userEmail || '', parseInt(chapterId), provider || '', pagesSig
  );
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveChapterMacroReviewCache(bookId, userEmail, chapterId, pagesSig, review, provider = '') {
  _saveChapterMacroReviewCache.run(
    parseInt(bookId), userEmail || '', parseInt(chapterId), provider || '',
    pagesSig, JSON.stringify(review), new Date().toISOString(),
  );
}

function deleteChapterMacroReviewCache(bookId, userEmail) {
  return _deleteChapterMacroReviewCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Delta-Cache: Synonym-Suche (synonyme.js) ──────────────────────────────────
// Key-Hash deckt wort + satz + buchtyp + locale + cacheVersion ab. Pro User.
const _loadSynonymCache = db.prepare(
  `SELECT result_json FROM synonym_cache WHERE user_email = ? AND provider = ? AND key_hash = ?`
);
const _saveSynonymCache = db.prepare(
  `INSERT OR REPLACE INTO synonym_cache (user_email, provider, key_hash, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?)`
);
const _deleteSynonymCache = db.prepare(`DELETE FROM synonym_cache WHERE user_email = ?`);

function loadSynonymCache(userEmail, keyHash, provider = '') {
  const row = _loadSynonymCache.get(userEmail || '', provider || '', keyHash);
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveSynonymCache(userEmail, keyHash, result, provider = '') {
  _saveSynonymCache.run(userEmail || '', provider || '', keyHash, JSON.stringify(result), new Date().toISOString());
}

function deleteSynonymCache(userEmail) {
  return _deleteSynonymCache.run(userEmail || '').changes;
}

// ── Delta-Cache: Seiten-Lektorat (lektorat.js Single + Batch) ─────────────────
// Single-Row pro Seite. ctx_sig deckt updated_at, Kapitelkontext (figuren/orte/
// beziehungen), narrative, Stopwords/Regeln und cacheVersion ab.
const _loadLektoratCache = db.prepare(
  `SELECT result_json FROM lektorat_cache
   WHERE book_id = ? AND user_email = ? AND page_id = ? AND provider = ? AND ctx_sig = ?`
);
const _saveLektoratCache = db.prepare(
  `INSERT OR REPLACE INTO lektorat_cache
   (book_id, user_email, page_id, provider, ctx_sig, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const _deleteLektoratCache = db.prepare(
  `DELETE FROM lektorat_cache WHERE book_id = ? AND user_email = ?`
);

function loadLektoratCache(bookId, userEmail, pageId, ctxSig, provider = '') {
  const row = _loadLektoratCache.get(
    parseInt(bookId), userEmail || '', parseInt(pageId), provider || '', ctxSig
  );
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveLektoratCache(bookId, userEmail, pageId, ctxSig, result, provider = '') {
  _saveLektoratCache.run(
    parseInt(bookId), userEmail || '', parseInt(pageId), provider || '',
    ctxSig, JSON.stringify(result), new Date().toISOString(),
  );
}

function deleteLektoratCache(bookId, userEmail) {
  return _deleteLektoratCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Delta-Cache: Finetune-AI-Augmentation ─────────────────────────────────────
// Cache-Key: (book_id, user_email, scope, scope_key, version).
// scope: 'reverse-prompts' | 'fact-qa' | 'reasoning-backfill'
// scope_key: stabile Entität (z.B. 'page:42', 'figure:alice', 'corr:hash')
// sig: Inhalts-Signatur (z.B. content-Hash + Modellname). Bei sig-Mismatch wird
// der Eintrag verworfen — das verhindert Stale-Augmentations bei Textänderung.
const _loadFtAiCache = db.prepare(
  `SELECT result_json, sig FROM finetune_ai_cache
   WHERE book_id = ? AND user_email = ? AND scope = ? AND scope_key = ? AND version = ?`
);
const _saveFtAiCache = db.prepare(
  `INSERT OR REPLACE INTO finetune_ai_cache
   (book_id, user_email, scope, scope_key, sig, version, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _deleteFtAiCache = db.prepare(
  `DELETE FROM finetune_ai_cache WHERE book_id = ? AND user_email = ?`
);

function loadFinetuneAiCache(bookId, userEmail, scope, scopeKey, sig, version) {
  const row = _loadFtAiCache.get(parseInt(bookId), userEmail || '', scope, scopeKey, version);
  if (!row) return null;
  if (row.sig !== sig) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveFinetuneAiCache(bookId, userEmail, scope, scopeKey, sig, version, result) {
  _saveFtAiCache.run(
    parseInt(bookId), userEmail || '', scope, scopeKey, sig, version,
    JSON.stringify(result), new Date().toISOString(),
  );
}

function deleteFinetuneAiCache(bookId, userEmail) {
  return _deleteFtAiCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Buch-Einstellungen (Sprache + Region) ─────────────────────────────────────

const _getBookSettings = db.prepare('SELECT language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat FROM book_settings WHERE book_id = ?');
const _upsertBookSettings = db.prepare(`
  INSERT INTO book_settings (book_id, language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    language=excluded.language, region=excluded.region,
    buchtyp=excluded.buchtyp, buch_kontext=excluded.buch_kontext,
    erzaehlperspektive=excluded.erzaehlperspektive, erzaehlzeit=excluded.erzaehlzeit,
    is_finished=excluded.is_finished,
    allow_lektor_book_chat=excluded.allow_lektor_book_chat,
    updated_at=excluded.updated_at
`);

/** Gibt {language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat} für ein Buch zurück.
 *  Fehlt die book_settings-Zeile, werden – wenn vorhanden – die User-Defaults
 *  (default_language/region/buchtyp) als Fallback verwendet. */
function getBookSettings(bookId, userEmail = null) {
  const row = _getBookSettings.get(parseInt(bookId));
  if (row) return {
    ...row,
    is_finished: row.is_finished ? 1 : 0,
    allow_lektor_book_chat: row.allow_lektor_book_chat ? 1 : 0,
  };
  if (userEmail) {
    const u = require('./app-users').getUser(userEmail);
    if (u && (u.default_language || u.default_buchtyp)) {
      const language = u.default_language || 'de';
      const region   = u.default_region   || (language === 'en' ? 'US' : 'CH');
      return { language, region, buchtyp: u.default_buchtyp || null, buch_kontext: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0 };
    }
  }
  return { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0 };
}

/** Locale-Key für ein Buch: z.B. "de-CH", "en-US". */
function getBookLocale(bookId, userEmail = null) {
  const { language, region } = getBookSettings(bookId, userEmail);
  return `${language}-${region}`;
}

/** Speichert/aktualisiert Sprache, Region, Buchtyp, Buchkontext, Erzählperspektive, Erzählzeit, is_finished, allow_lektor_book_chat. */
function saveBookSettings(bookId, language, region, buchtyp, buchKontext, erzaehlperspektive = null, erzaehlzeit = null, isFinished = 0, allowLektorBookChat = 0) {
  _upsertBookSettings.run(
    parseInt(bookId), language, region,
    buchtyp || null, buchKontext || null,
    erzaehlperspektive || null, erzaehlzeit || null,
    isFinished ? 1 : 0,
    allowLektorBookChat ? 1 : 0,
    new Date().toISOString()
  );
}

// ── Kontinuitätsprüfung ───────────────────────────────────────────────────────
// Eine Zeile pro Issue (continuity_issues) plus Bridge-Tabellen für Figuren-/
// Kapitel-Referenzen. Vorbild: figure_scenes mit scene_figures/scene_locations.

const _insContinuityCheck = db.prepare(
  `INSERT INTO continuity_checks (book_id, user_email, checked_at, summary, model)
   VALUES (?, ?, ?, ?, ?)`
);
const _insContinuityIssue = db.prepare(
  `INSERT INTO continuity_issues
   (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, sort_order, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const _insContinuityIssueFig = db.prepare(
  `INSERT INTO continuity_issue_figures (issue_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)`
);
const _insContinuityIssueCh = db.prepare(
  `INSERT INTO continuity_issue_chapters (issue_id, chapter_id, sort_order) VALUES (?, ?, ?)`
);

/** Speichert einen Kontinuitäts-Check mit allen Issues als eigene Zeilen.
 *  issues: [{schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung,
 *            figuren:[Namen], kapitel:[Namen]}]
 *  figNameToId / chNameToId: Auflösungs-Maps (Name → fig_id / chapter_id).
 *  Gibt { checkId, normalizedIssues } zurück, wobei normalizedIssues die
 *  Frontend-Form mit fig_ids/chapter_ids enthält (kompatibel zur alten Antwort). */
function saveContinuityCheck(bookId, userEmail, summary, model, issues, figNameToId, chNameToId) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const now = new Date().toISOString();
  const normalizedIssues = [];
  let checkId = null;
  // continuity_issue_figures.figure_id ist INTEGER (figures.id) seit Mig 73 —
  // figNameToId liefert TEXT-fig_id, zusaetzlicher Lookup TEXT → INT.
  const figRows = db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);
  const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
  db.transaction(() => {
    const { lastInsertRowid: cid } = _insContinuityCheck.run(
      bookIdInt, email, now, summary || '', model || null,
    );
    checkId = cid;
    const issuesArr = Array.isArray(issues) ? issues : [];
    for (let i = 0; i < issuesArr.length; i++) {
      const it = issuesArr[i] || {};
      const { lastInsertRowid: issueId } = _insContinuityIssue.run(
        cid, bookIdInt, email,
        it.schwere || null, it.typ || null, it.beschreibung || null,
        it.stelle_a || null, it.stelle_b || null, it.empfehlung || null,
        i, now,
      );
      const figNames = Array.isArray(it.figuren) ? it.figuren.map(_toRefString).filter(Boolean) : [];
      const fig_ids = [];
      const seenFig = new Set();
      figNames.forEach((name, j) => {
        const fid = figNameToId?.[name] || null;
        const key = (fid || '') + '|' + name;
        if (seenFig.has(key)) return;
        seenFig.add(key);
        if (fid) fig_ids.push(fid);
        const figureRowId = fid ? (figIdToRowId[fid] ?? null) : null;
        _insContinuityIssueFig.run(issueId, figureRowId, name, j);
      });
      const chNames = Array.isArray(it.kapitel) ? it.kapitel.map(_toRefString).filter(Boolean) : [];
      const chapter_ids = [];
      const seenCh = new Set();
      chNames.forEach((name, j) => {
        const cidCh = chNameToId?.[name] ?? null;
        const key = (cidCh ?? '') + '|' + name;
        if (seenCh.has(key)) return;
        seenCh.add(key);
        if (cidCh != null) chapter_ids.push(cidCh);
        if (cidCh != null) _insContinuityIssueCh.run(issueId, cidCh, j);
      });
      normalizedIssues.push({
        schwere: it.schwere || null, typ: it.typ || null,
        beschreibung: it.beschreibung || null,
        stelle_a: it.stelle_a || null, stelle_b: it.stelle_b || null,
        empfehlung: it.empfehlung || null,
        figuren: figNames, fig_ids,
        kapitel: chNames, chapter_ids,
      });
    }
  })();
  return { checkId, normalizedIssues };
}

/** Lädt den letzten Kontinuitäts-Check eines Buchs in Frontend-Form
 *  ({id, checked_at, issues:[{...}], summary, model}) oder null. */
function getLatestContinuityCheck(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const row = db.prepare(`
    SELECT id, checked_at, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email IS ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(bookIdInt, email);
  if (!row) return null;
  const issueRows = db.prepare(`
    SELECT id, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung
    FROM continuity_issues
    WHERE check_id = ?
    ORDER BY sort_order, id
  `).all(row.id);
  const figRows = db.prepare(`
    SELECT cif.issue_id, f.fig_id, cif.figur_name
    FROM continuity_issue_figures cif
    LEFT JOIN figures f ON f.id = cif.figure_id
    WHERE cif.issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY cif.issue_id, cif.sort_order
  `).all(row.id);
  const chRows = db.prepare(`
    SELECT cic.issue_id, cic.chapter_id, c.chapter_name
    FROM continuity_issue_chapters cic
    LEFT JOIN chapters c ON c.chapter_id = cic.chapter_id
    WHERE cic.issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY cic.issue_id, cic.sort_order
  `).all(row.id);
  const figByIssue = new Map();
  for (const r of figRows) {
    if (!figByIssue.has(r.issue_id)) figByIssue.set(r.issue_id, { figuren: [], fig_ids: [] });
    const bucket = figByIssue.get(r.issue_id);
    if (r.figur_name) bucket.figuren.push(r.figur_name);
    if (r.fig_id) bucket.fig_ids.push(r.fig_id);
  }
  const chByIssue = new Map();
  for (const r of chRows) {
    if (!chByIssue.has(r.issue_id)) chByIssue.set(r.issue_id, { kapitel: [], chapter_ids: [] });
    const bucket = chByIssue.get(r.issue_id);
    if (r.chapter_name) bucket.kapitel.push(r.chapter_name);
    if (r.chapter_id != null) bucket.chapter_ids.push(r.chapter_id);
  }
  const issues = issueRows.map(r => ({
    schwere: r.schwere, typ: r.typ, beschreibung: r.beschreibung,
    stelle_a: r.stelle_a, stelle_b: r.stelle_b, empfehlung: r.empfehlung,
    figuren: figByIssue.get(r.id)?.figuren || [],
    fig_ids: figByIssue.get(r.id)?.fig_ids || [],
    kapitel: chByIssue.get(r.id)?.kapitel || [],
    chapter_ids: chByIssue.get(r.id)?.chapter_ids || [],
  }));
  return { id: row.id, checked_at: row.checked_at, issues, summary: row.summary, model: row.model };
}

// ── Musik (Songs) ────────────────────────────────────────────────────────────
// Parallel zu saveOrteToDb. UPSERT by song_uid; FK-CASCADE räumt
// song_figures / song_chapters / song_scenes bei Song-DELETE.
function saveSongsToDb(bookId, songs, userEmail, chNameToId = null, pageNameToIdByChapter = null) {
  if (chNameToId == null) {
    const rows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
    chNameToId = Object.fromEntries(rows.map(r => [r.chapter_name, r.chapter_id]));
  }
  if (pageNameToIdByChapter == null) {
    const rows = db.prepare('SELECT page_id, page_name, chapter_id FROM pages WHERE book_id = ?').all(bookId);
    pageNameToIdByChapter = {};
    for (const r of rows) {
      const k = r.chapter_id ?? 0;
      (pageNameToIdByChapter[k] ??= {})[r.page_name] = r.page_id;
    }
  }
  const resolveErstePageIdForSong = (ersteErwaehnung, kapitel) => {
    if (!ersteErwaehnung) return null;
    for (const k of (kapitel || [])) {
      const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
      const chapId = chName ? chNameToId?.[chName] : null;
      if (chapId != null) {
        const pid = pageNameToIdByChapter[chapId]?.[ersteErwaehnung];
        if (pid) return pid;
      }
    }
    const cand = [];
    for (const m of Object.values(pageNameToIdByChapter)) {
      if (m[ersteErwaehnung]) cand.push(m[ersteErwaehnung]);
    }
    return cand.length === 1 ? cand[0] : null;
  };
  const now = new Date().toISOString();
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];

  db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, song_uid FROM songs WHERE book_id = ? AND ${emailCond}`
    ).all(bookId, ...emailVal);
    const existingMap = Object.fromEntries(existing.map(r => [r.song_uid, r.id]));

    const newUids = new Set(songs.map(s => s.id));
    for (const { id, song_uid } of existing) {
      if (!newUids.has(song_uid)) {
        db.prepare('DELETE FROM songs WHERE id = ?').run(id);
      }
    }

    const upd = db.prepare(`
      UPDATE songs SET titel=?, interpret=?, genre=?, beschreibung=?, stimmung=?,
        kontext_typ=?, erste_erwaehnung=?, erste_erwaehnung_page_id=?,
        sort_order=?, updated_at=?
      WHERE id=?`);
    const ins = db.prepare(`
      INSERT INTO songs (book_id, song_uid, titel, interpret, genre, beschreibung, stimmung,
        kontext_typ, erste_erwaehnung, erste_erwaehnung_page_id, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const delSf = db.prepare('DELETE FROM song_figures WHERE song_id = ?');
    const delSc = db.prepare('DELETE FROM song_chapters WHERE song_id = ?');
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, userEmail || null);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const insSf = db.prepare('INSERT OR IGNORE INTO song_figures (song_id, figure_id, kontext_typ) VALUES (?, ?, ?)');
    const insSc = db.prepare('INSERT INTO song_chapters (song_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)');

    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      const erstPageId = resolveErstePageIdForSong(s.erste_erwaehnung, s.kapitel);
      let songDbId = existingMap[s.id];
      if (songDbId !== undefined) {
        upd.run(s.titel || s.title || '', s.interpret || null, s.genre || null,
          s.beschreibung || null, s.stimmung || null, s.kontext_typ || null,
          s.erste_erwaehnung || null, erstPageId, i, now, songDbId);
        delSf.run(songDbId);
        delSc.run(songDbId);
      } else {
        const { lastInsertRowid } = ins.run(
          bookId, s.id, s.titel || s.title || '', s.interpret || null, s.genre || null,
          s.beschreibung || null, s.stimmung || null, s.kontext_typ || null,
          s.erste_erwaehnung || null, erstPageId, i, userEmail || null, now
        );
        songDbId = lastInsertRowid;
      }
      for (const f of (s.figuren || [])) {
        // figuren: entweder String (fig_id) oder Objekt { fig_id, kontext_typ }
        const ref = _toRefString(typeof f === 'object' && f ? (f.fig_id ?? f.id) : f);
        const rowId = ref ? figIdToRowId[ref] : null;
        const fKtx = (typeof f === 'object' && f && f.kontext_typ) ? f.kontext_typ : null;
        if (rowId != null) insSf.run(songDbId, rowId, fKtx);
      }
      for (const k of (s.kapitel || [])) {
        const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
        if (!chName) continue;
        const chapId = chNameToId?.[chName] ?? null;
        const haeufigkeit = (k && typeof k === 'object' && k.haeufigkeit) || 1;
        if (chapId != null) insSc.run(songDbId, chapId, haeufigkeit);
      }
    }
  })();
}

// ── Schauplätze eines Kapitels (via location_chapters) ───────────────────────

/** Schauplätze eines Kapitels. Fallback: alle Buchorte, wenn keine Kapitelzuordnung existiert.
 *  Liefert: [{ name, typ, beschreibung, stimmung }] */
function getChapterLocations(bookId, chapterId, userEmail) {
  if (!bookId) return [];
  const em = userEmail || null;
  const cols = 'l.name, l.typ, l.beschreibung, l.stimmung';
  if (chapterId) {
    const rows = db.prepare(`
      SELECT ${cols} FROM locations l
      JOIN location_chapters lc ON lc.location_id = l.id
      WHERE l.book_id = ? AND lc.chapter_id = ? AND l.user_email IS ?
      ORDER BY lc.haeufigkeit DESC, l.sort_order, l.id
    `).all(bookId, chapterId, em);
    if (rows.length > 0) return rows;
  }
  return db.prepare(`
    SELECT ${cols} FROM locations l
    WHERE l.book_id = ? AND l.user_email IS ?
    ORDER BY l.sort_order, l.id
  `).all(bookId, em);
}

module.exports = {
  db,
  // figures
  saveFigurenToDb:          figures.saveFigurenToDb,
  addFigurenBeziehungen:    figures.addFigurenBeziehungen,
  updateFigurenEvents:      figures.updateFigurenEvents,
  updateFigurenSoziogramm:  figures.updateFigurenSoziogramm,
  cleanupDuplicateFiguren:  figures.cleanupDuplicateFiguren,
  getChapterFigures:        figures.getChapterFigures,
  getChapterFigureRelations: figures.getChapterFigureRelations,
  getFigureWithDetails:     figures.getFigureWithDetails,
  // locations
  getChapterLocations,
  // pages
  reconcilePageIds:   pages.reconcilePageIds,
  pruneStaleBookData: pages.pruneStaleBookData,
  // books
  upsertBook:         books.upsertBook,
  upsertBookByName:   books.upsertBookByName,
  getBookName:        books.getBookName,
  pruneStaleByAge:    books.pruneStaleByAge,
  // local
  saveZeitstrahlEvents,
  saveOrteToDb,
  saveSongsToDb,
  backfillLocationChaptersFromScenes,
  saveContinuityCheck,
  getLatestContinuityCheck,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  insertJobRun, startJobRun, endJobRun, cleanupStuckJobRuns,
  getDailyTokenUsage:    tokenUsage.getDailyTokenUsage,
  getDailyTotalsByUser:  tokenUsage.getDailyTotalsByUser,
  getBookSettings, getBookLocale, saveBookSettings,
  loadChapterExtractCache, saveChapterExtractCache, deleteChapterExtractCache,
  loadChapterReviewCache, saveChapterReviewCache,
  loadBookReviewCache, saveBookReviewCache, deleteReviewCache,
  loadChapterMacroReviewCache, saveChapterMacroReviewCache, deleteChapterMacroReviewCache,
  loadSynonymCache, saveSynonymCache, deleteSynonymCache,
  loadLektoratCache, saveLektoratCache, deleteLektoratCache,
  loadFinetuneAiCache, saveFinetuneAiCache, deleteFinetuneAiCache,
  // pdf-export profiles
  listPdfExportProfiles:  pdfExport.listProfiles,
  getPdfExportProfile:    pdfExport.getProfile,
  createPdfExportProfile: pdfExport.createProfile,
  updatePdfExportProfile: pdfExport.updateProfile,
  deletePdfExportProfile: pdfExport.deleteProfile,
  setPdfExportProfileCover:   pdfExport.setCover,
  clearPdfExportProfileCover: pdfExport.clearCover,
  getPdfExportProfileCover:   pdfExport.getCover,
  setPdfExportProfileDefault: pdfExport.setDefault,
  // fonts
  getCachedFont: fonts.getCachedFont,
  cacheFont:     fonts.cacheFont,
  // draft figures (Figuren-Werkstatt)
  listDraftFigures:        draftFigures.listDraftFigures,
  getDraftFigure:          draftFigures.getDraftFigure,
  getDraftFigureBySource:  draftFigures.getDraftFigureBySource,
  createDraftFigure:       draftFigures.createDraftFigure,
  updateDraftFigure:       draftFigures.updateDraftFigure,
  deleteDraftFigure:       draftFigures.deleteDraftFigure,
  insertWerkstattRun:      draftFigures.insertWerkstattRun,
  listWerkstattRuns:       draftFigures.listWerkstattRuns,
  getWerkstattRun:         draftFigures.getWerkstattRun,
  deleteWerkstattRun:      draftFigures.deleteWerkstattRun,
};
