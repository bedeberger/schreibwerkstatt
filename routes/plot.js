'use strict';
// Plot-Werkstatt (Beat-Board): CRUD für Akte (Spalten) + Beats (Karten) +
// Drag-&-Drop-Reordering. Pro Buch + User skopiert; ACL-Guard via
// requireBookAccess('editor') — planendes Welt-/Plot-Werkzeug, kein Lesezugang.
//
// KI-Assistenz (Brainstorm + Consistency) läuft separat über die Job-Queue
// (routes/jobs/plot.js), nicht hier.

const express = require('express');
const { db } = require('../db/schema');
const plotDb = require('../db/plot');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const STATUSES = ['geplant', 'entwurf', 'im_buch', 'verworfen'];
const MAX_TITEL = 200;
const MAX_BESCHREIBUNG = 4000;
const MAX_ACT_NAME = 120;

function userEmailOrNull(req) {
  return req.session?.user?.email || null;
}

function _guard(req, res, bookId, minRole = 'editor') {
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return true; }
  catch (e) { return !sendACLError(res, e); }
}

// chapter_id muss zum Buch gehören, sonst NULL (kein Fremd-Verweis).
function _validChapterId(bookId, chapterId) {
  if (!chapterId) return null;
  const r = db.prepare('SELECT book_id FROM chapters WHERE chapter_id = ?').get(parseInt(chapterId));
  return (r && r.book_id === bookId) ? parseInt(chapterId) : null;
}

// ── Board laden ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const userEmail = userEmailOrNull(req);
  const bookId = toIntId(req.query.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId)) return;
  res.json({
    acts: plotDb.listActs(bookId, userEmail),
    beats: plotDb.listBeats(bookId, userEmail),
  });
});

// ── Akte ─────────────────────────────────────────────────────────────────────
router.post('/acts', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const name = (req.body?.name || '').toString().trim();
  const farbe = req.body?.farbe ? String(req.body.farbe).slice(0, 32) : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!name)   return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_ACT_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  if (!_guard(req, res, bookId)) return;
  const act = plotDb.createAct(bookId, userEmail, { name, farbe });
  logger.info(`[plot] act create id=${act.id} book=${bookId}`);
  res.json(act);
});

router.patch('/acts/:id', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const act = plotDb.getAct(id);
  if (!act || act.user_email !== userEmail) return res.status(404).json({ error_code: 'ACT_NOT_FOUND' });
  if (!_guard(req, res, act.book_id)) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : act.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_ACT_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  const farbe = typeof req.body?.farbe === 'string' ? req.body.farbe.slice(0, 32)
    : (req.body?.farbe === null ? null : act.farbe);
  res.json(plotDb.updateAct(id, { name, farbe }));
});

router.delete('/acts/:id', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const act = plotDb.getAct(id);
  if (!act || act.user_email !== userEmail) return res.status(404).json({ error_code: 'ACT_NOT_FOUND' });
  if (!_guard(req, res, act.book_id)) return;
  plotDb.deleteAct(id);
  logger.info(`[plot] act delete id=${id} book=${act.book_id}`);
  res.json({ ok: true });
});

router.put('/acts/order', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!order)  return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!_guard(req, res, bookId)) return;
  plotDb.reorderActs(bookId, userEmail, order);
  res.json({ ok: true });
});

// ── Beats ──────────────────────────────────────────────────────────────────
router.post('/beats', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const actId = toIntId(req.body?.act_id);
  const titel = (req.body?.titel || '').toString().trim();
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!actId)  return res.status(400).json({ error_code: 'ACTID_REQ' });
  if (!titel)  return res.status(400).json({ error_code: 'TITEL_REQ' });
  if (titel.length > MAX_TITEL) return res.status(400).json({ error_code: 'TITEL_TOO_LONG' });
  if (!_guard(req, res, bookId)) return;

  const act = plotDb.getAct(actId);
  if (!act || act.book_id !== bookId || act.user_email !== userEmail) {
    return res.status(400).json({ error_code: 'ACT_MISMATCH' });
  }
  const beschreibung = req.body?.beschreibung ? String(req.body.beschreibung).slice(0, MAX_BESCHREIBUNG) : null;
  const status = STATUSES.includes(req.body?.status) ? req.body.status : 'geplant';
  const chapterId = _validChapterId(bookId, toIntId(req.body?.chapter_id));
  const figureIds = plotDb.resolveFigureIds(bookId, userEmail, req.body?.figure_ids);
  const draftFigureIds = plotDb.resolveDraftFigureIds(bookId, userEmail, req.body?.draft_figure_ids);

  const beat = plotDb.createBeat(bookId, actId, userEmail, { titel, beschreibung, status, chapterId, figureIds, draftFigureIds });
  logger.info(`[plot] beat create id=${beat.id} act=${actId} book=${bookId}`);
  res.json(beat);
});

router.patch('/beats/:id', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const beat = plotDb.getBeat(id);
  if (!beat || beat.user_email !== userEmail) return res.status(404).json({ error_code: 'BEAT_NOT_FOUND' });
  if (!_guard(req, res, beat.book_id)) return;

  const fields = {};
  if (typeof req.body?.titel === 'string') {
    const t = req.body.titel.trim();
    if (!t) return res.status(400).json({ error_code: 'TITEL_REQ' });
    if (t.length > MAX_TITEL) return res.status(400).json({ error_code: 'TITEL_TOO_LONG' });
    fields.titel = t;
  }
  if (typeof req.body?.beschreibung === 'string') {
    fields.beschreibung = req.body.beschreibung.slice(0, MAX_BESCHREIBUNG) || null;
  }
  if (typeof req.body?.status !== 'undefined') {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error_code: 'INVALID_STATUS' });
    fields.status = req.body.status;
  }
  if (typeof req.body?.chapter_id !== 'undefined') {
    fields.chapter_id = _validChapterId(beat.book_id, toIntId(req.body.chapter_id));
  }
  // act_id-Move ohne Reorder (z.B. Detail-Edit): act muss zum Buch gehören.
  if (typeof req.body?.act_id !== 'undefined') {
    const act = plotDb.getAct(toIntId(req.body.act_id));
    if (!act || act.book_id !== beat.book_id || act.user_email !== userEmail) {
      return res.status(400).json({ error_code: 'ACT_MISMATCH' });
    }
    fields.act_id = act.id;
  }
  const figureIds = Array.isArray(req.body?.figure_ids)
    ? plotDb.resolveFigureIds(beat.book_id, userEmail, req.body.figure_ids)
    : undefined;
  const draftFigureIds = Array.isArray(req.body?.draft_figure_ids)
    ? plotDb.resolveDraftFigureIds(beat.book_id, userEmail, req.body.draft_figure_ids)
    : undefined;

  if (!Object.keys(fields).length && typeof figureIds === 'undefined' && typeof draftFigureIds === 'undefined') {
    return res.status(400).json({ error_code: 'NO_FIELDS' });
  }
  res.json(plotDb.updateBeat(id, fields, figureIds, draftFigureIds));
});

router.delete('/beats/:id', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const beat = plotDb.getBeat(id);
  if (!beat || beat.user_email !== userEmail) return res.status(404).json({ error_code: 'BEAT_NOT_FOUND' });
  if (!_guard(req, res, beat.book_id)) return;
  plotDb.deleteBeat(id);
  logger.info(`[plot] beat delete id=${id} book=${beat.book_id}`);
  res.json({ ok: true });
});

router.put('/beats/order', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!order)  return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!_guard(req, res, bookId)) return;
  plotDb.reorderBeats(bookId, userEmail, order);
  res.json({ ok: true });
});

module.exports = router;
