'use strict';
// Plot-Werkstatt (Beat-Board): Brainstorm + Consistency als Job-Queue-Operationen.
// Beide Jobs operieren auf dem Board (plot_acts + plot_beats). Rein planend /
// überwachend — es wird NIE Text ins Manuskript geschrieben.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts, getFiguren,
  loadOrderedBookContents,
  tps, createJob, enqueueJob, findActiveJobId, jsonBody, _modelName,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const { db } = require('../../db/connection');
const plotDb = require('../../db/plot');

const plotRouter = express.Router();

const SEVERITY = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// ── Kontext-Loader ────────────────────────────────────────────────────────────

// Figuren-Ensemble (Name + Typ) als Grundierung für beide Jobs.
function _figurenContext(bookId, userEmail) {
  return getFiguren(bookId, userEmail).map(f => ({ name: f.name, typ: f.typ || null }));
}

// Kapitelnamen in echter Buchorganizer-Reihenfolge (über die Content-Store-
// Facade — kein Direkt-SQL auf chapters). Best-effort: bei Fehler leeres Array.
async function _kapitelContext(bookId) {
  try {
    const { chaptersFlat } = await loadOrderedBookContents(bookId, null);
    return (chaptersFlat || []).map(c => c.name);
  } catch {
    return [];
  }
}

// „Buchrealität" für den Consistency-Check: extrahierte Szenen mit Kapitel +
// beteiligten Figuren. figure_scenes/scene_figures sind keine pages/chapters/
// books → Direkt-SQL erlaubt; chapter_name via JOIN (Anzeige-Wert zur Lesezeit).
function _szenenContext(bookId, userEmail) {
  const scenes = db.prepare(`
    SELECT fs.id, fs.titel, c.chapter_name AS kapitel
      FROM figure_scenes fs
      LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
     WHERE fs.book_id = ? AND fs.user_email = ?
     ORDER BY fs.sort_order, fs.id
     LIMIT 150
  `).all(parseInt(bookId), userEmail);
  if (!scenes.length) return [];
  const figRows = db.prepare(`
    SELECT sf.scene_id, f.name
      FROM scene_figures sf
      JOIN figure_scenes fs ON fs.id = sf.scene_id
      JOIN figures f ON f.id = sf.figure_id
     WHERE fs.book_id = ? AND fs.user_email = ?
  `).all(parseInt(bookId), userEmail);
  const byScene = {};
  for (const r of figRows) (byScene[r.scene_id] = byScene[r.scene_id] || []).push(r.name);
  return scenes.map(s => ({ titel: s.titel, kapitel: s.kapitel, figuren: byScene[s.id] || [] }));
}

// ── Brainstorm-Job ────────────────────────────────────────────────────────────

async function runPlotBrainstormJob(jobId, bookId, actId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildPlotSystemPrompt, buildPlotBrainstormPrompt, SCHEMA_PLOT_BRAINSTORM } = await getPrompts();

  try {
    const acts = plotDb.listActs(bookId, userEmail);
    const act = acts.find(a => a.id === actId);
    if (!act) throw i18nError('job.error.plot.actMissing');
    const beats = plotDb.listBeats(bookId, userEmail);

    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    const figuren = _figurenContext(bookId, userEmail);
    const kapitel = await _kapitelContext(bookId);

    logger.info(`Plot-Brainstorm Start: book=${bookId} akt="${act.name}" beats=${beats.length} figuren=${figuren.length}`);
    updateJob(jobId, { statusText: 'job.plot.brainstorm.aiReply', progress: 10 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildPlotBrainstormPrompt(act.name, acts, beats, BUCH_KONTEXT, figuren, kapitel),
      buildPlotSystemPrompt(),
      10, 95, 1500, 0.3, 1500, undefined, SCHEMA_PLOT_BRAINSTORM,
    );

    if (!Array.isArray(result?.vorschlaege)) throw i18nError('job.error.plot.vorschlaegeMissing');
    const vorschlaege = result.vorschlaege
      .filter(v => v && typeof v.label === 'string' && v.label.trim())
      .map(v => ({
        label: v.label.trim(),
        begruendung: typeof v.begruendung === 'string' ? v.begruendung.trim() : '',
      }));

    completeJob(jobId, { vorschlaege, actId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${vorschlaege.length} Vorschläge für "${act.name}"`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Plot-Brainstorm-Fehler book=${bookId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Consistency-Job ───────────────────────────────────────────────────────────

async function runPlotConsistencyJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildPlotSystemPrompt, buildPlotConsistencyPrompt, SCHEMA_PLOT_CONSISTENCY } = await getPrompts();

  try {
    const acts = plotDb.listActs(bookId, userEmail);
    const beats = plotDb.listBeats(bookId, userEmail);
    if (!beats.length) throw i18nError('job.error.plot.boardEmpty');

    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    const figuren = _figurenContext(bookId, userEmail);
    const kapitel = await _kapitelContext(bookId);
    const szenen = _szenenContext(bookId, userEmail);

    logger.info(`Plot-Consistency Start: book=${bookId} beats=${beats.length} szenen=${szenen.length} kapitel=${kapitel.length}`);
    updateJob(jobId, { statusText: 'job.plot.consistency.aiReply', progress: 10 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildPlotConsistencyPrompt(acts, beats, kapitel, szenen, figuren, BUCH_KONTEXT),
      buildPlotSystemPrompt(),
      10, 95, 2500, 0.3, 3000, undefined, SCHEMA_PLOT_CONSISTENCY,
    );

    if (!Array.isArray(result?.konflikte)) throw i18nError('job.error.plot.konflikteMissing');
    if (typeof result.fazit !== 'string') throw i18nError('job.error.plot.fazitMissing');

    const konflikte = result.konflikte
      .filter(k => k && typeof k.problem === 'string')
      .map(k => ({
        beat: typeof k.beat === 'string' ? k.beat.trim() : '—',
        schwere: SEVERITY.includes(k.schwere) ? k.schwere : 'mittel',
        problem: k.problem.trim(),
        vorschlag: typeof k.vorschlag === 'string' ? k.vorschlag.trim() : '',
      }));
    const fazit = result.fazit.trim();

    completeJob(jobId, { konflikte, fazit, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${konflikte.length} Konflikte`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Plot-Consistency-Fehler book=${bookId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

plotRouter.post('/plot-brainstorm', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  const actId = toIntId(req.body?.act_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!actId)  return res.status(400).json({ error_code: 'ACT_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHORIZED' });

  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const act = plotDb.getAct(actId);
  if (!act || act.book_id !== bookId || act.user_email !== userEmail) {
    return res.status(404).json({ error_code: 'ACT_NOT_FOUND' });
  }

  const entityKey = `${bookId}|brainstorm|${actId}`;
  const existing = findActiveJobId('plot-brainstorm', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const jobId = createJob('plot-brainstorm', bookId, userEmail, 'job.label.plotBrainstorm', { akt: act.name }, entityKey);
  enqueueJob(jobId, () => runPlotBrainstormJob(jobId, bookId, actId, userEmail));
  res.json({ jobId });
});

plotRouter.post('/plot-consistency', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHORIZED' });

  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const existing = findActiveJobId('plot-consistency', bookId, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const jobId = createJob('plot-consistency', bookId, userEmail, 'job.label.plotConsistency', {}, bookId);
  enqueueJob(jobId, () => runPlotConsistencyJob(jobId, bookId, userEmail));
  res.json({ jobId });
});

module.exports = { plotRouter, runPlotBrainstormJob, runPlotConsistencyJob };
