'use strict';
// CRUD für draft_figures (Figuren-Werkstatt). Owner-Check pro Operation.
// Default-Mindmap-Knoten als i18n-Marker persistiert; Frontend löst via t() auf,
// damit die Locale-Wahl des späteren Betrachters gilt (CLAUDE.md-Pattern).

const express = require('express');
const {
  listDraftFigures, getDraftFigure, createDraftFigure, updateDraftFigure, deleteDraftFigure,
} = require('../db/schema');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '1mb' });

const MAX_NAME_LEN = 200;
const MAX_NOTES_LEN = 8000;
const MAX_MINDMAP_BYTES = 256 * 1024;

function userEmailOrNull(req) {
  return req.session?.user?.email || null;
}

function defaultMindmap(name) {
  return {
    meta: { name: 'figur-werkstatt', version: '1' },
    format: 'node_tree',
    data: {
      id: 'root',
      topic: name,
      children: [
        { id: 'steckbrief', topic: '__i18n:werkstatt.tree.steckbrief__', expanded: true, children: [
          { id: 'aussehen',        topic: '__i18n:werkstatt.tree.aussehen__' },
          { id: 'persoenlichkeit', topic: '__i18n:werkstatt.tree.persoenlichkeit__' },
          { id: 'hintergrund',     topic: '__i18n:werkstatt.tree.hintergrund__' },
          { id: 'beziehungen',     topic: '__i18n:werkstatt.tree.beziehungen__' },
          { id: 'konflikt',        topic: '__i18n:werkstatt.tree.konflikt__' },
          { id: 'bogen',           topic: '__i18n:werkstatt.tree.bogen__' },
        ]},
        { id: 'stimme', topic: '__i18n:werkstatt.tree.stimme__', expanded: true, children: [
          { id: 'sprechweise', topic: '__i18n:werkstatt.tree.sprechweise__' },
          { id: 'phrasen',     topic: '__i18n:werkstatt.tree.phrasen__' },
          { id: 'verben',      topic: '__i18n:werkstatt.tree.verben__' },
        ]},
        { id: 'subtext', topic: '__i18n:werkstatt.tree.subtext__', expanded: true, children: [
          { id: 'want',  topic: '__i18n:werkstatt.tree.want__' },
          { id: 'need',  topic: '__i18n:werkstatt.tree.need__' },
          { id: 'wound', topic: '__i18n:werkstatt.tree.wound__' },
          { id: 'lie',   topic: '__i18n:werkstatt.tree.lie__' },
        ]},
        { id: 'custom', topic: '__i18n:werkstatt.tree.custom__', children: [] },
      ],
    },
  };
}

function _validateMindmap(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.data || typeof obj.data !== 'object') return false;
  if (typeof obj.data.id !== 'string' || typeof obj.data.topic !== 'string') return false;
  const json = JSON.stringify(obj);
  if (json.length > MAX_MINDMAP_BYTES) return false;
  return true;
}

// Liste aller Werkstatt-Figuren eines Buchs (per User).
router.get('/:book_id', (req, res) => {
  const userEmail = userEmailOrNull(req);
  const bookId = toIntId(req.params.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  res.json(listDraftFigures(bookId, userEmail));
});

// Einzelne Werkstatt-Figur per id.
router.get('/by-id/:id', (req, res) => {
  const userEmail = userEmailOrNull(req);
  const id = toIntId(req.params.id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const draft = getDraftFigure(id);
  if (!draft) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  res.json(draft);
});

// Neue Werkstatt-Figur. Body: { name, archetype?, notes?, mindmap? }.
// Ohne mindmap → Default-Tree (Steckbrief + Stimme + Subtext + Eigene Aspekte).
router.post('/:book_id', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  const bookId = toIntId(req.params.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });

  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });

  const archetype = req.body?.archetype ? String(req.body.archetype).trim().slice(0, 50) : null;
  const notes = req.body?.notes ? String(req.body.notes).slice(0, MAX_NOTES_LEN) : null;
  const mindmap = req.body?.mindmap || defaultMindmap(name);
  if (!_validateMindmap(mindmap)) return res.status(400).json({ error_code: 'MINDMAP_INVALID' });

  const created = createDraftFigure(bookId, userEmail, { name, archetype, mindmap, notes });
  logger.info(`[werkstatt] create id=${created.id} book=${bookId} name="${name}"`);
  res.json(created);
});

// Update. Body: { name?, archetype?, mindmap?, notes? }.
router.put('/:id', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  const id = toIntId(req.params.id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const draft = getDraftFigure(id);
  if (!draft) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

  const name = req.body?.name != null
    ? String(req.body.name).trim()
    : draft.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });

  const archetype = req.body?.archetype != null
    ? (req.body.archetype ? String(req.body.archetype).trim().slice(0, 50) : null)
    : draft.archetype;
  const notes = req.body?.notes != null
    ? (req.body.notes ? String(req.body.notes).slice(0, MAX_NOTES_LEN) : null)
    : draft.notes;
  const mindmap = req.body?.mindmap != null ? req.body.mindmap : draft.mindmap;
  if (!_validateMindmap(mindmap)) return res.status(400).json({ error_code: 'MINDMAP_INVALID' });

  const updated = updateDraftFigure(id, { name, archetype, mindmap, notes });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const userEmail = userEmailOrNull(req);
  const id = toIntId(req.params.id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const draft = getDraftFigure(id);
  if (!draft) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  deleteDraftFigure(id);
  logger.info(`[werkstatt] delete id=${id}`);
  res.json({ ok: true });
});

module.exports = { router, defaultMindmap };
