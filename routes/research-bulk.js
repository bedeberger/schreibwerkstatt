'use strict';
// POST /research/bulk — Mehrfachauswahl im Recherche-Board: eine Aktion auf
// viele Fundstuecke in EINER Transaktion (Status setzen, Tag ergaenzen,
// archivieren/zurueckholen, mit einer Stelle oder Entitaet verknuepfen, loeschen).
//
// Body: { book_id, ids: [..], action, status?, tag?, target_kind?, target_id? }
//
// Die Ids werden auf das Buch eingeschraenkt (fremde und unbekannte fallen still
// weg; `count` sagt, wie viele wirklich betroffen waren) — die ACL haengt allein
// am Buch, wie bei den Einzel-Routen (routes/research-acl.js). Jede Aktion nutzt
// den Schreibweg der Einzel-Route (setItemsStatus, addItemLink, Suchindex), damit
// „viele auf einmal" nicht anders schreibt als „eins".

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const { NOW_ISO_SQL } = require('../db/now');
const searchIndex = require('../lib/search');
const { RESEARCH_STATUS_SET, normalizeTags } = require('../lib/research-validate');
const { LINK_TARGETS, setItemsStatus, addItemLink } = require('../db/research-items');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const BULK_MAX = 500;
const ACTIONS = new Set(['status', 'add_tag', 'archive', 'unarchive', 'link', 'delete']);

function _bookItemIds(bookId, rawIds) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(toIntId).filter(Boolean))].slice(0, BULK_MAX);
  if (!ids.length) return [];
  return db.prepare(
    `SELECT id FROM research_items WHERE book_id = ? AND id IN (${ids.map(() => '?').join(',')})`
  ).all(bookId, ...ids).map(r => r.id);
}

router.post('/bulk', jsonBody, (req, res) => {
  const b = req.body || {};
  const bookId = toIntId(b.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  setContext({ book: bookId });

  const action = String(b.action || '');
  if (!ACTIONS.has(action)) return res.status(400).json({ error_code: 'INVALID_ACTION' });
  if (action === 'status' && !RESEARCH_STATUS_SET.has(b.status)) return res.status(400).json({ error_code: 'INVALID_STATUS' });
  const tag = action === 'add_tag' ? normalizeTags([b.tag])[0] : null;
  if (action === 'add_tag' && !tag) return res.status(400).json({ error_code: 'INVALID_TAG' });
  if (action === 'link' && (!LINK_TARGETS[b.target_kind] || !toIntId(b.target_id))) {
    return res.status(400).json({ error_code: 'INVALID_TARGET' });
  }

  const ids = _bookItemIds(bookId, b.ids);
  if (!ids.length) return res.json({ ok: true, count: 0 });
  const ph = ids.map(() => '?').join(',');

  let linkError = null;
  const run = db.transaction(() => {
    if (action === 'status') {
      setItemsStatus(ids, b.status, sessionEmail(req));
    } else if (action === 'add_tag') {
      const ins = db.prepare('INSERT OR IGNORE INTO research_item_tags (item_id, tag) VALUES (?, ?)');
      for (const id of ids) ins.run(id, tag);
    } else if (action === 'archive' || action === 'unarchive') {
      db.prepare(`UPDATE research_items SET archived = ?, updated_at = ${NOW_ISO_SQL} WHERE id IN (${ph})`)
        .run(action === 'archive' ? 1 : 0, ...ids);
    } else if (action === 'link') {
      for (const id of ids) {
        linkError = addItemLink(id, bookId, b.target_kind, b.target_id);
        // Das Ziel ist fuer alle dasselbe — scheitert es einmal (fremdes Buch),
        // scheitert es fuer alle: ganze Transaktion zurueck.
        if (linkError) throw new Error(linkError);
      }
    } else if (action === 'delete') {
      db.prepare(`DELETE FROM research_items WHERE id IN (${ph})`).run(...ids);
    }
  });
  try {
    run();
  } catch (e) {
    if (!linkError) throw e;
    return res.status(400).json({ error_code: linkError });
  }

  // Suchindex ausserhalb der Transaktion (wie die Einzel-Routen nach dem Schreiben).
  for (const id of ids) {
    try {
      if (action === 'delete') searchIndex.remove('research', id);
      else if (action === 'add_tag') searchIndex.upsertResearch(id);
    } catch (e) { logger.warn(`[research] Suchindex nach Bulk ${action} id=${id}: ${e.message}`); }
  }
  logger.info(`[research] bulk ${action} count=${ids.length}`);
  res.json({ ok: true, count: ids.length });
});

module.exports = { researchBulkRouter: router };
