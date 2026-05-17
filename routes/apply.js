'use strict';
// Phase 4b (BookStack-Exit, docs/bookstack-exit.md): Apply-only-Routen fuer
// `lektor`-Rolle. Differenziert zwischen "freiem Save" (PUT /content/pages/:id,
// minRole editor) und Apply einer persistierten Suggestion (lektor+).
//
// Beide Routen laden die Suggestion serverseitig aus DB, machen den
// String-Ersatz im aktuellen Page-Body, schreiben via content-store. Kein
// Pfad, mit dem Lektor beliebigen HTML einschleusen koennte.
//
// Page-Lock-Pflicht: Apply-Holder ist entweder Lock-Holder (typischer Fall:
// Lektor hat vorher /pages/:id/lock geholt) oder freie Seite (kein Lock).
// Fremder Lock → 423, sonst transient acquire/extend → release nach Apply
// nicht noetig (Lektor schliesst Card explizit).

const express = require('express');
const contentStore = require('../lib/content-store');
const bookAccess = require('../db/book-access');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const { db } = require('../db/connection');
const { setContext } = require('../lib/log-context');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '256kb' });

function _userEmail(req) { return req.session?.user?.email || null; }

function _pageBookId(pageId) {
  const r = db.prepare('SELECT book_id FROM pages WHERE page_id = ?').get(parseInt(pageId, 10));
  return r?.book_id || null;
}

function _enforcePageRole(req, pageId, minRole) {
  const bookId = _pageBookId(pageId);
  if (!bookId) {
    const err = new Error('PAGE_NOT_FOUND');
    err.status = 404; err.code = 'PAGE_NOT_FOUND';
    throw err;
  }
  setContext({ book: bookId });
  return { bookId, role: requireBookAccess(req, bookId, minRole) };
}

function _checkLock(pageId, email) {
  const blocking = bookAccess.getBlockingLockFor(pageId, email);
  if (blocking) {
    const err = new Error('PAGE_LOCKED');
    err.status = 423; err.code = 'PAGE_LOCKED';
    err.lock = blocking;
    throw err;
  }
}

// Substring-Replace im HTML-Body. Eindeutigkeit erforderlich: wenn `original`
// keinmal oder mehrfach vorkommt, wird abgebrochen. Sonst koennten Lektor-Apply
// versehentlich gleiche Phrasen an anderer Stelle ueberschreiben.
function _safeReplace(body, original, replacement) {
  if (typeof body !== 'string') return null;
  if (!original || typeof original !== 'string') return null;
  const first = body.indexOf(original);
  if (first < 0) return { ok: false, reason: 'ORIGINAL_NOT_FOUND' };
  const second = body.indexOf(original, first + original.length);
  if (second >= 0) return { ok: false, reason: 'ORIGINAL_NOT_UNIQUE' };
  return { ok: true, body: body.slice(0, first) + (replacement ?? '') + body.slice(first + original.length) };
}

// POST /apply/pages/:page_id/lektorat-finding { check_id, error_index }
// Lektor wendet eine Korrektur aus page_checks an. Updated applied_errors_json
// nach erfolgreichem Save.
router.post('/pages/:page_id/lektorat-finding', jsonBody, async (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  const checkId = parseInt(req.body?.check_id, 10);
  const errIdx = parseInt(req.body?.error_index, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (!Number.isInteger(checkId) || checkId <= 0) return res.status(400).json({ error_code: 'INVALID_CHECK_ID' });
  if (!Number.isInteger(errIdx) || errIdx < 0) return res.status(400).json({ error_code: 'INVALID_ERROR_INDEX' });
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  let bookId;
  try { ({ bookId } = _enforcePageRole(req, pageId, 'lektor')); }
  catch (e) {
    if (sendACLError(res, e)) return;
    return res.status(e.status || 500).json({ error_code: e.code || 'ERROR' });
  }

  try { _checkLock(pageId, email); }
  catch (e) {
    if (e.code === 'PAGE_LOCKED') return res.status(423).json({
      error_code: 'PAGE_LOCKED', locked_by_email: e.lock.locked_by_email, expires_at: e.lock.expires_at,
    });
    throw e;
  }

  const row = db.prepare(`
    SELECT id, errors_json, applied_errors_json
      FROM page_checks WHERE id = ? AND page_id = ?
  `).get(checkId, pageId);
  if (!row) return res.status(404).json({ error_code: 'FINDING_NOT_FOUND' });
  let errors;
  try { errors = JSON.parse(row.errors_json || '[]'); }
  catch { return res.status(500).json({ error_code: 'FINDINGS_CORRUPT' }); }
  const finding = errors[errIdx];
  if (!finding) return res.status(404).json({ error_code: 'ERROR_INDEX_OUT_OF_RANGE' });
  const original = finding.original ?? finding.fehler ?? null;
  const replacement = finding.vorschlag ?? finding.korrektur ?? null;
  if (!original || replacement == null) return res.status(400).json({ error_code: 'FINDING_HAS_NO_REPLACEMENT' });

  try {
    const page = await contentStore.loadPage(pageId, req);
    const out = _safeReplace(page?.body_html || page?.html || '', original, replacement);
    if (!out || !out.ok) return res.status(409).json({ error_code: out?.reason || 'APPLY_FAILED' });
    const saved = await contentStore.savePage(pageId, { html: out.body, source: 'lektorat-apply' }, req);

    // applied_errors_json fortschreiben (mit De-Dup auf `original`).
    let applied = [];
    try { applied = row.applied_errors_json ? JSON.parse(row.applied_errors_json) : []; } catch { applied = []; }
    if (!applied.some(a => a.original === original)) {
      applied.push({ original, vorschlag: replacement, applied_at: new Date().toISOString(), by: email });
    }
    db.prepare('UPDATE page_checks SET applied_errors_json = ? WHERE id = ?')
      .run(JSON.stringify(applied), checkId);

    logger.info(`Lektorat-Finding angewendet: page=${pageId} check=${checkId}#${errIdx} by ${email}`);
    res.json({ ok: true, page: { updated_at: saved.updated_at } });
  } catch (e) {
    if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
    logger.error(`apply-lektorat-finding fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'APPLY_FAILED', detail: e.message });
  }
});

// POST /apply/pages/:page_id/chat-vorschlag { message_id, vorschlag_index }
// Wendet einen Chat-Vorschlag aus chat_messages.vorschlaege auf die Seite an.
// Markiert vorschlaege[idx].applied = true nach erfolgreichem Save.
router.post('/pages/:page_id/chat-vorschlag', jsonBody, async (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  const msgId = parseInt(req.body?.message_id, 10);
  const vIdx = parseInt(req.body?.vorschlag_index, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (!Number.isInteger(msgId) || msgId <= 0) return res.status(400).json({ error_code: 'INVALID_MESSAGE_ID' });
  if (!Number.isInteger(vIdx) || vIdx < 0) return res.status(400).json({ error_code: 'INVALID_VORSCHLAG_INDEX' });
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  try { _enforcePageRole(req, pageId, 'lektor'); }
  catch (e) {
    if (sendACLError(res, e)) return;
    return res.status(e.status || 500).json({ error_code: e.code || 'ERROR' });
  }
  try { _checkLock(pageId, email); }
  catch (e) {
    if (e.code === 'PAGE_LOCKED') return res.status(423).json({
      error_code: 'PAGE_LOCKED', locked_by_email: e.lock.locked_by_email, expires_at: e.lock.expires_at,
    });
    throw e;
  }

  const row = db.prepare(`
    SELECT cm.id, cm.vorschlaege, cs.page_id, cs.user_email
      FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.session_id
     WHERE cm.id = ?
  `).get(msgId);
  if (!row) return res.status(404).json({ error_code: 'MESSAGE_NOT_FOUND' });
  if (row.page_id !== pageId) return res.status(400).json({ error_code: 'PAGE_MISMATCH' });
  let vorschlaege;
  try { vorschlaege = row.vorschlaege ? JSON.parse(row.vorschlaege) : []; }
  catch { return res.status(500).json({ error_code: 'VORSCHLAEGE_CORRUPT' }); }
  const v = vorschlaege[vIdx];
  if (!v) return res.status(404).json({ error_code: 'VORSCHLAG_INDEX_OUT_OF_RANGE' });
  const original = v.original ?? null;
  const replacement = v.vorschlag ?? v.korrektur ?? null;
  if (!original || replacement == null) return res.status(400).json({ error_code: 'VORSCHLAG_HAS_NO_REPLACEMENT' });

  try {
    const page = await contentStore.loadPage(pageId, req);
    const out = _safeReplace(page?.body_html || page?.html || '', original, replacement);
    if (!out || !out.ok) return res.status(409).json({ error_code: out?.reason || 'APPLY_FAILED' });
    const saved = await contentStore.savePage(pageId, { html: out.body, source: 'chat-apply' }, req);

    vorschlaege[vIdx].applied = true;
    vorschlaege[vIdx].applied_at = new Date().toISOString();
    db.prepare('UPDATE chat_messages SET vorschlaege = ? WHERE id = ?')
      .run(JSON.stringify(vorschlaege), msgId);

    logger.info(`Chat-Vorschlag angewendet: page=${pageId} msg=${msgId}#${vIdx} by ${email}`);
    res.json({ ok: true, page: { updated_at: saved.updated_at } });
  } catch (e) {
    if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
    logger.error(`apply-chat-vorschlag fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'APPLY_FAILED', detail: e.message });
  }
});

module.exports = router;
