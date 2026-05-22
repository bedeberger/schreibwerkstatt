'use strict';
// LanguageTool-Proxy (self-hosted).
// Frontend ruft POST /languagetool/check; Server holt URL aus app_settings,
// forwarded an `${url}/v2/check`. Credentials/URL verlassen den Server nicht.
//
// Disabled / no-URL -> 404 { error: 'languagetool_disabled' } (Frontend
// behandelt als "Feature aus", kein Retry).
//
// LT-Server-Timeout: 10s. Bei Cap überschritten -> 408.
// Upstream-Fehler -> 502 mit upstream-Status. Body-Cap 200 KB (LT-Server-Limit
// ~100KB Free-Server; wir cappen vorsichtig höher).

const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { getBookLocale } = require('../db/schema');

const router = express.Router();
const TEXT_MAX = 200_000;

router.post('/check', express.json({ limit: '256kb' }), async (req, res) => {
  const enabled = appSettings.get('languagetool.enabled') === true;
  const url = String(appSettings.get('languagetool.url') || '').replace(/\/$/, '');
  if (!enabled || !url) {
    return res.status(404).json({ error: 'languagetool_disabled' });
  }

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text) return res.json({ matches: [] });
  if (text.length > TEXT_MAX) {
    return res.status(413).json({ error: 'text_too_large', max: TEXT_MAX });
  }

  const bookId = toIntId(body.bookId);
  if (bookId) setContext({ book: bookId });
  const userEmail = req.session?.user?.email || null;

  // Sprache: Client darf overriden (LT-konformer Tag); sonst aus Buch-Locale,
  // sonst 'auto'.
  let language = typeof body.language === 'string' && body.language.trim()
    ? body.language.trim()
    : null;
  if (!language && bookId) {
    try { language = getBookLocale(bookId, userEmail); } catch { /* noop */ }
  }
  if (!language) language = 'auto';

  const picky = appSettings.get('languagetool.picky') === true;

  const params = new URLSearchParams();
  params.set('text', text);
  params.set('language', language);
  if (picky) params.set('level', 'picky');

  const log = logger.child({ job: 'lt', user: userEmail || '-', book: bookId || '-' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const t0 = Date.now();
  try {
    const upstream = await fetch(`${url}/v2/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString(),
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      log.warn(`upstream ${upstream.status} latency=${Date.now() - t0}ms`);
      return res.status(502).json({ error: 'languagetool_upstream', upstream_status: upstream.status });
    }
    const json = await upstream.json();
    // Pass-through: matches + language. Software-Block weglassen (Versions-Noise).
    res.json({
      matches: Array.isArray(json?.matches) ? json.matches : [],
      language: json?.language || null,
    });
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    log.warn(`fetch ${isAbort ? 'TIMEOUT' : err.message} latency=${Date.now() - t0}ms`);
    return res.status(isAbort ? 408 : 502).json({ error: isAbort ? 'languagetool_timeout' : 'languagetool_fetch_failed' });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
