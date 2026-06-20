'use strict';
// Figuren-Werkstatt: Brainstorm + Consistency-Check als Job-Queue-Operationen.
// Beide Jobs operieren auf einer draft_figures-Zeile (Mindmap als JSON).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  tps,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
  _modelName,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { db } = require('../../db/connection');
const { getDraftFigure, insertWerkstattRun } = require('../../db/draft-figures');
const { getUser } = require('../../db/app-users');
const { resolveI18n, resolveI18nTree } = require('../../lib/i18n-server');

const figurWerkstattRouter = express.Router();

// ── Mindmap-Pfad-Hilfe ──────────────────────────────────────────────────────
// Findet einen Knoten anhand seiner ID im jsMind-Baum (data.children-Tree)
// und liefert den Pfad als "Wurzel > … > Knoten"-String.
function _findKnotenPfad(node, targetId, trail = []) {
  return _findKnoten(node, targetId, trail)?.pfad ?? null;
}

// Wie _findKnotenPfad, liefert zusätzlich den Knoten selbst (für Children-Listing).
function _findKnoten(node, targetId, trail = []) {
  if (!node) return null;
  const here = [...trail, node.topic || ''];
  if (node.id === targetId) return { pfad: here.join(' > '), node };
  for (const child of node.children || []) {
    const found = _findKnoten(child, targetId, here);
    if (found) return found;
  }
  return null;
}

// ── Buch-Kontext-Loader ─────────────────────────────────────────────────────
// Liefert Figuren (Name+Typ+Beschreibung) und Orte (Name+Typ) eines Buchs;
// per-User-skopiert. Genutzt für Brainstorm (Abgrenzungs-Kontext, damit KI
// keine Doppelung produziert) und Consistency-Check (Stimmigkeit gegen
// Buchwelt). excludeFigureId: optional, blendet die Werkstatt-Quellfigur aus,
// damit sie nicht gegen sich selbst geprüft wird.
function _loadBookFiguren(bookId, userEmail, excludeFigureId = null) {
  if (excludeFigureId) {
    return db.prepare(`
      SELECT name, typ, beschreibung
        FROM figures
       WHERE book_id = ? AND user_email = ? AND id != ?
       ORDER BY sort_order, name
       LIMIT 50
    `).all(parseInt(bookId), userEmail, parseInt(excludeFigureId));
  }
  return db.prepare(`
    SELECT name, typ, beschreibung
      FROM figures
     WHERE book_id = ? AND user_email = ?
     ORDER BY sort_order, name
     LIMIT 50
  `).all(parseInt(bookId), userEmail);
}

function _loadBookOrte(bookId, userEmail) {
  return db.prepare(`
    SELECT name, typ, beschreibung
      FROM locations
     WHERE book_id = ? AND user_email = ?
     ORDER BY sort_order, name
     LIMIT 50
  `).all(parseInt(bookId), userEmail);
}

// Buch-weites Beziehungsgeflecht (from/to via INTEGER-FK auf figures.id → Namen).
// Gibt Konflikt-Erkennung ("Doppelung von Rolle/Funktion") + Brainstorm-
// Abgrenzung Substanz, die name/typ/beschreibung alleine nicht liefern.
function _loadBookBeziehungen(bookId, userEmail) {
  return db.prepare(`
    SELECT ff.name AS fromName, tf.name AS toName, r.typ, r.beschreibung
      FROM figure_relations r
      JOIN figures ff ON ff.id = r.from_fig_id
      JOIN figures tf ON tf.id = r.to_fig_id
     WHERE r.book_id = ? AND r.user_email IS ?
     ORDER BY ff.name, tf.name
     LIMIT 60
  `).all(parseInt(bookId), userEmail);
}

// „Geschriebene Realität" der Quell-Figur: Szenen (via scene_figures-Bridge) +
// Ereignisse (figure_events.figure_id direkt). Nur für Consistency: Abgleich
// des Mindmap-Plans gegen das, was im Buch bereits über die Figur steht.
// Leer, wenn der Draft keine source_figure_id hat (reiner Neu-Entwurf).
function _loadFigurAuftritte(figureId, bookId, userEmail) {
  if (!figureId) return { szenen: [], ereignisse: [] };
  const szenen = db.prepare(`
    SELECT fs.titel, fs.wertung, fs.kommentar
      FROM figure_scenes fs
      JOIN scene_figures sf ON sf.scene_id = fs.id
     WHERE sf.figure_id = ? AND fs.book_id = ? AND fs.user_email IS ?
     ORDER BY fs.sort_order
     LIMIT 40
  `).all(parseInt(figureId), parseInt(bookId), userEmail);
  const ereignisse = db.prepare(`
    SELECT datum_label, ereignis, bedeutung
      FROM figure_events
     WHERE figure_id = ?
     ORDER BY sort_order, datum
     LIMIT 40
  `).all(parseInt(figureId));
  return { szenen, ereignisse };
}

// ── Brainstorm-Job ──────────────────────────────────────────────────────────

async function runBrainstormJob(jobId, draftId, knotenId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildBrainstormPrompt, SCHEMA_BRAINSTORM } = await getPrompts();

  try {
    const draft = getDraftFigure(draftId);
    if (!draft) throw i18nError('job.error.werkstatt.draftMissing');
    if (draft.user_email !== userEmail) throw i18nError('job.error.forbidden');

    const locale = getUser(userEmail)?.language || 'de';
    const found = _findKnoten(draft.mindmap?.data, knotenId);
    if (!found) throw i18nError('job.error.werkstatt.knotenMissing');
    const { pfad: rawPfad, node: zielKnoten } = found;
    const knotenPfad = resolveI18n(rawPfad, locale);
    const existingChildren = (zielKnoten.children || [])
      .map(c => resolveI18n((c.topic || '').trim(), locale))
      .filter(Boolean);
    const mindmapResolved = resolveI18nTree(draft.mindmap, locale);

    const { SYSTEM_FIGUREN_BLOCKS: SYSTEM_FIGUREN, BUCH_KONTEXT } = await getBookPrompts(draft.book_id, userEmail);
    // Quell-Figur aus dem Abgrenzungs-Kontext entfernen, sonst lehnt KI eigene
    // Eigenschaften als „Doppelung mit Buchfigur" ab. source_figure_id robust
    // (User darf den Werkstatt-Namen ändern); Name-Match als zweiter Filter
    // für Drafts ohne Import-Referenz.
    const draftNameNorm = (draft.name || '').trim().toLowerCase();
    const figuren = _loadBookFiguren(draft.book_id, userEmail, draft.source_figure_id)
      .filter(f => (f.name || '').trim().toLowerCase() !== draftNameNorm);
    const orte = _loadBookOrte(draft.book_id, userEmail);
    const beziehungen = _loadBookBeziehungen(draft.book_id, userEmail);

    logger.info(`Brainstorm Start: draft=${draftId} knoten="${knotenPfad}" figuren=${figuren.length} orte=${orte.length} beziehungen=${beziehungen.length} kinder=${existingChildren.length}`);
    updateJob(jobId, { statusText: 'job.werkstatt.brainstorm.aiReply', progress: 10 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildBrainstormPrompt(draft.name, draft.archetype, knotenPfad, mindmapResolved, BUCH_KONTEXT, figuren, orte, existingChildren, beziehungen),
      SYSTEM_FIGUREN,
      10, 95, 1500, 0.3, 1500, undefined, SCHEMA_BRAINSTORM,
    );

    if (!Array.isArray(result?.vorschlaege)) throw i18nError('job.error.werkstatt.vorschlaegeMissing');
    const vorschlaege = result.vorschlaege
      .filter(v => v && typeof v.label === 'string' && v.label.trim())
      .map(v => ({
        label: v.label.trim(),
        begruendung: typeof v.begruendung === 'string' ? v.begruendung.trim() : '',
      }));

    // Run-Historisierung: Frontend listet alle Läufe pro Draft (klappbare
    // Sektion); Re-Open lädt result_json, applyBrainstormVorschlag arbeitet
    // weiter — Apply prüft client-seitig, ob knoten_id noch existiert.
    const runId = insertWerkstattRun({
      draftId, bookId: draft.book_id, userEmail,
      kind: 'brainstorm', knotenId, knotenPfad,
      result: { vorschlaege }, model: _modelName(),
    });
    completeJob(jobId, { vorschlaege, knotenId, knotenPfad, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${vorschlaege.length} Vorschläge für "${knotenPfad}"`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Brainstorm-Fehler draft=${draftId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Consistency-Job ─────────────────────────────────────────────────────────

async function runConsistencyJob(jobId, draftId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildConsistencyPrompt, SCHEMA_CONSISTENCY } = await getPrompts();

  try {
    const draft = getDraftFigure(draftId);
    if (!draft) throw i18nError('job.error.werkstatt.draftMissing');
    if (draft.user_email !== userEmail) throw i18nError('job.error.forbidden');

    const locale = getUser(userEmail)?.language || 'de';
    const mindmapResolved = resolveI18nTree(draft.mindmap, locale);

    const { SYSTEM_FIGUREN_BLOCKS: SYSTEM_FIGUREN, BUCH_KONTEXT } = await getBookPrompts(draft.book_id, userEmail);
    // Quell-Figur ausschliessen wie bei Brainstorm — Consistency würde sonst
    // jede Übernahme aus den Importdaten als „Konflikt mit gleichnamiger
    // Buchfigur" markieren.
    const draftNameNorm = (draft.name || '').trim().toLowerCase();
    const figuren = _loadBookFiguren(draft.book_id, userEmail, draft.source_figure_id)
      .filter(f => (f.name || '').trim().toLowerCase() !== draftNameNorm);
    const orte    = _loadBookOrte(draft.book_id, userEmail);
    const beziehungen = _loadBookBeziehungen(draft.book_id, userEmail);
    // Abgleich gegen die geschriebene Realität der Quell-Figur (nur wenn importiert).
    const eigeneAuftritte = _loadFigurAuftritte(draft.source_figure_id, draft.book_id, userEmail);

    logger.info(`Consistency Start: draft=${draftId} figuren=${figuren.length} orte=${orte.length} beziehungen=${beziehungen.length} szenen=${eigeneAuftritte.szenen.length} ereignisse=${eigeneAuftritte.ereignisse.length}`);
    updateJob(jobId, { statusText: 'job.werkstatt.consistency.aiReply', progress: 10 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildConsistencyPrompt(draft.name, draft.archetype, mindmapResolved, BUCH_KONTEXT, figuren, orte, beziehungen, eigeneAuftritte),
      SYSTEM_FIGUREN,
      10, 95, 2500, 0.3, 3000, undefined, SCHEMA_CONSISTENCY,
    );

    if (!Array.isArray(result?.konflikte)) throw i18nError('job.error.werkstatt.konflikteMissing');
    if (typeof result.fazit !== 'string') throw i18nError('job.error.werkstatt.fazitMissing');

    const konflikte = result.konflikte
      .filter(k => k && typeof k.feld === 'string' && typeof k.problem === 'string')
      .map(k => ({
        feld: k.feld.trim(),
        schwere: ['kritisch','stark','mittel','schwach','niedrig'].includes(k.schwere) ? k.schwere : 'mittel',
        problem: k.problem.trim(),
        vorschlag: typeof k.vorschlag === 'string' ? k.vorschlag.trim() : '',
      }));

    const fazit = result.fazit.trim();
    const runId = insertWerkstattRun({
      draftId, bookId: draft.book_id, userEmail,
      kind: 'consistency',
      result: { konflikte, fazit },
      model: _modelName(),
    });
    completeJob(jobId, { konflikte, fazit, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${konflikte.length} Konflikte`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Consistency-Fehler draft=${draftId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

figurWerkstattRouter.post('/werkstatt-brainstorm', jsonBody, (req, res) => {
  const draftId = toIntId(req.body?.draftId);
  const knotenId = req.body?.knotenId;
  if (!draftId) return res.status(400).json({ error_code: 'DRAFT_ID_REQUIRED' });
  if (!knotenId || typeof knotenId !== 'string') return res.status(400).json({ error_code: 'KNOTEN_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHORIZED' });

  const draft = getDraftFigure(draftId);
  if (!draft) return res.status(404).json({ error_code: 'DRAFT_NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  if (draft.book_id) {
    setContext({ book: draft.book_id });
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, draft.book_id, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const entityKey = `${draftId}|${knotenId}`;
  const existing = findActiveJobId('werkstatt-brainstorm', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const label = 'job.label.werkstattBrainstormFigur';
  const labelParams = { figur: draft.name };
  const jobId = createJob('werkstatt-brainstorm', draft.book_id, userEmail, label, labelParams, entityKey);
  enqueueJob(jobId, () => runBrainstormJob(jobId, draftId, knotenId, userEmail));
  res.json({ jobId });
});

figurWerkstattRouter.post('/werkstatt-consistency', jsonBody, (req, res) => {
  const draftId = toIntId(req.body?.draftId);
  if (!draftId) return res.status(400).json({ error_code: 'DRAFT_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHORIZED' });

  const draft = getDraftFigure(draftId);
  if (!draft) return res.status(404).json({ error_code: 'DRAFT_NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  if (draft.book_id) {
    setContext({ book: draft.book_id });
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, draft.book_id, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const existing = findActiveJobId('werkstatt-consistency', draftId, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const label = 'job.label.werkstattConsistencyFigur';
  const labelParams = { figur: draft.name };
  const jobId = createJob('werkstatt-consistency', draft.book_id, userEmail, label, labelParams, draftId);
  enqueueJob(jobId, () => runConsistencyJob(jobId, draftId, userEmail));
  res.json({ jobId });
});

module.exports = { figurWerkstattRouter, runBrainstormJob, runConsistencyJob, _findKnotenPfad };
