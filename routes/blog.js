'use strict';
// REST-Endpoints fuer die Blog-Verbindung eines Buchs.
// /blog/:book_id/status   GET     — public connection meta (kein Passwort)
// /blog/:book_id/connect  POST    — credentials speichern + Test-Call
// /blog/:book_id/test     POST    — Connection testen ohne speichern
// /blog/:book_id          DELETE  — Verbindung loeschen (CASCADE killt Links)
//
// Pflicht: Buchtyp == 'blog' (gated via book_settings.buchtyp), aclParamGuard('editor').
// Logging-Context book-Slot via router.param + bookParamHandler.

const express = require('express');
const { aclParamGuard } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { getBookSettings } = require('../db/schema');
const blogs = require('../db/blogs');
const { createWpClient, validateBaseUrl } = require('../lib/wp-client');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

function _requireBlogType(req, res) {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  if (!settings || settings.buchtyp !== 'blog') {
    res.status(400).json({ error_code: 'BLOG_REQUIRES_BLOG_TYPE' });
    return false;
  }
  return true;
}

router.get('/:book_id/status', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  const isBlogType = settings && settings.buchtyp === 'blog';
  const conn = blogs.getConnectionPublic(bookId);
  res.json({
    isBlogType: !!isBlogType,
    connected: !!conn,
    connection: conn,
  });
});

router.post('/:book_id/test', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const { baseUrl, username, password } = req.body || {};
  let url;
  try { url = validateBaseUrl(baseUrl); }
  catch (e) {
    return res.status(400).json({ error_code: e.code || 'BLOG_INVALID_URL' });
  }
  if (!username || !password) {
    return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  }
  try {
    const wp = createWpClient({ baseUrl: url, username, password });
    const me = await wp.me();
    const canEdit = !!(me && me.capabilities && me.capabilities.edit_posts);
    if (!canEdit) {
      return res.status(403).json({ error_code: 'BLOG_INSUFFICIENT_CAPABILITY' });
    }
    return res.json({ ok: true, userId: me.id, name: me.name || me.slug || username });
  } catch (e) {
    const code = e.code || 'BLOG_TEST_FAILED';
    logger.warn(`Blog-Test fehlgeschlagen: ${code}`);
    return res.status(code === 'BLOG_AUTH_FAILED' ? 401 : 502).json({ error_code: code });
  }
});

router.post('/:book_id/connect', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const bookId = req.bookId;
  const { baseUrl, username, password, defaultStatus = 'draft' } = req.body || {};
  let url;
  try { url = validateBaseUrl(baseUrl); }
  catch (e) {
    return res.status(400).json({ error_code: e.code || 'BLOG_INVALID_URL' });
  }
  if (!username) {
    return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  }
  if (!['draft', 'publish', 'private'].includes(defaultStatus)) {
    return res.status(400).json({ error_code: 'BLOG_INVALID_STATUS' });
  }
  // Reuse stored password wenn Client `__keep__` schickt und Connection existiert.
  // Schutz: PW darf nie an Client zurueck und der bestehende verschlüsselte
  // Wert wird ueber db/blogs.js entschluesselt.
  let effectivePw = password;
  if ((!password || password === '__keep__')) {
    const existing = blogs.getConnection(bookId);
    if (existing) effectivePw = existing.password;
  }
  if (!effectivePw) return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  try {
    const wp = createWpClient({ baseUrl: url, username, password: effectivePw });
    const me = await wp.me();
    const canEdit = !!(me && me.capabilities && me.capabilities.edit_posts);
    if (!canEdit) {
      return res.status(403).json({ error_code: 'BLOG_INSUFFICIENT_CAPABILITY' });
    }
  } catch (e) {
    const code = e.code || 'BLOG_TEST_FAILED';
    return res.status(code === 'BLOG_AUTH_FAILED' ? 401 : 502).json({ error_code: code });
  }
  const conn = blogs.upsertConnection({
    bookId, baseUrl: url, username, password: effectivePw, defaultStatus,
  });
  return res.json({ ok: true, connection: conn });
});

router.delete('/:book_id', aclParamGuard('editor'), (req, res) => {
  const ok = blogs.deleteConnection(req.bookId);
  res.json({ ok });
});

module.exports = router;
