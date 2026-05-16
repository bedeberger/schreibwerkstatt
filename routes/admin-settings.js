'use strict';
// Phase 4c (BookStack-Exit, docs/bookstack-exit.md): Admin-Routen fuer
// app_settings. Hinter requireAdmin (lib/admin-mw.js).
//
// Endpoints:
//   GET   /admin/settings           — Liste aller Keys (encrypted maskiert)
//   GET   /admin/settings/:key      — Einzelwert (encrypted maskiert)
//   PUT   /admin/settings/:key      — Update (Sentinel "__unchanged__" fuer
//                                    encrypted ohne Re-Eingabe)
//   DELETE /admin/settings/:key     — Reset auf Default
//   POST  /admin/settings/test-provider — 1-Token-Probecall (Latenz + ok)
//   POST  /admin/settings/test-oauth    — Discovery-Doc-Fetch (Format-Check)
//
// Sicherheit: encrypted-Werte verlassen den Server nur als "__masked__" mit
// letzten 4 Zeichen als Hint. Wer den Klartext braucht (Backup, Debug):
// Direkter DB-Zugriff vom Server.

const express = require('express');
const appSettings = require('../lib/app-settings');
const { requireAdmin } = require('../lib/admin-mw');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  const items = appSettings.listForAdmin();
  res.json({ settings: items });
});

router.get('/:key', (req, res) => {
  const items = appSettings.listForAdmin();
  const item = items.find(s => s.key === req.params.key);
  if (!item) return res.status(404).json({ error_code: 'KEY_NOT_FOUND' });
  res.json({ setting: item });
});

router.put('/:key', express.json(), (req, res) => {
  const { key } = req.params;
  const body = req.body || {};
  if (!('value' in body)) return res.status(400).json({ error_code: 'VALUE_REQUIRED' });
  const updatedBy = req.session.user.email;
  try {
    const stored = appSettings.set(key, body.value, { updatedBy });
    logger.info(`app-settings: ${key} updated`, { user: updatedBy });
    res.json({ ok: true, key, value: appSettings.isEncryptedKey(key) ? '__masked__' : stored });
  } catch (e) {
    logger.error(`app-settings put ${key}: ${e.message}`, { user: updatedBy });
    res.status(500).json({ error_code: 'PUT_FAILED', detail: e.message });
  }
});

router.delete('/:key', (req, res) => {
  const { key } = req.params;
  appSettings.remove(key, { updatedBy: req.session.user.email });
  res.json({ ok: true, key, value: appSettings.get(key) });
});

// POST /admin/settings/test-provider — 1-Token-Probecall.
// Liest aktuellen Provider + Credentials aus app_settings, ruft einen
// minimalen Completion-Call ab. Liefert latency_ms + ok-Flag.
router.post('/test-provider', express.json(), async (req, res) => {
  const provider = appSettings.get('ai.provider');
  const t0 = Date.now();
  try {
    if (provider === 'claude') {
      const key = appSettings.get('ai.claude.api_key');
      if (!key) return res.json({ ok: false, error: 'NO_API_KEY' });
      const model = appSettings.get('ai.claude.model');
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const ok = resp.ok;
      return res.json({ ok, status: resp.status, provider, model, latency_ms: Date.now() - t0 });
    }
    if (provider === 'ollama') {
      const host = appSettings.get('ai.ollama.host');
      const r = await fetch(`${host}/api/tags`).catch(() => null);
      return res.json({ ok: !!r?.ok, status: r?.status || 0, provider, latency_ms: Date.now() - t0 });
    }
    if (provider === 'llama') {
      const host = appSettings.get('ai.llama.host');
      const r = await fetch(`${host}/health`).catch(() => null);
      return res.json({ ok: !!r?.ok, status: r?.status || 0, provider, latency_ms: Date.now() - t0 });
    }
    return res.json({ ok: false, error: 'UNKNOWN_PROVIDER', provider });
  } catch (e) {
    return res.json({ ok: false, error: e.message, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/test-oauth — Discovery-Doc-Fetch (kein voller
// OAuth-Roundtrip; nur Format-Check, dass Client-ID + Discovery-URL klappen).
router.post('/test-oauth', async (req, res) => {
  const clientId = appSettings.get('auth.google.client_id');
  if (!clientId) return res.json({ ok: false, error: 'NO_CLIENT_ID' });
  const t0 = Date.now();
  try {
    const r = await fetch('https://accounts.google.com/.well-known/openid-configuration');
    if (!r.ok) return res.json({ ok: false, status: r.status, latency_ms: Date.now() - t0 });
    const j = await r.json();
    return res.json({ ok: !!j.authorization_endpoint, latency_ms: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: e.message, latency_ms: Date.now() - t0 });
  }
});

// Phase 4c2: SMTP-Test-Endpoints.
//
// GET /admin/settings/smtp/test-config — Mailer-Status (mode, fromEmail,
// ready-Flag, fehlende Pflichtfelder). Kein Klartext-Secret.
router.get('/smtp/test-config', (req, res) => {
  const mailer = require('../lib/mailer');
  res.json({ status: mailer.getStatus() });
});

// POST /admin/settings/smtp/test-send { to? } — sendet ein 'test'-Template
// an `to` (Default: smtp.from_email). Liefert { ok, latencyMs, error? }.
router.post('/smtp/test-send', express.json(), async (req, res) => {
  const mailer = require('../lib/mailer');
  const fromEmail = appSettings.get('smtp.from_email');
  const to = (req.body?.to || fromEmail || '').trim();
  if (!to) return res.json({ ok: false, error: 'NO_RECIPIENT' });
  const status = mailer.getStatus();
  if (!status.ready) {
    return res.json({ ok: false, error: status.mode === 'disabled' ? 'DISABLED' : 'INCOMPLETE_CONFIG', missing: status.missing });
  }
  const r = await mailer.send({
    to,
    template: 'test',
    ctx: { mode: status.mode, fromEmail },
    locale: 'de',
  });
  if (r.sent) {
    logger.info(`smtp/test-send: ok to=${to} latency=${r.latencyMs}ms`, { user: req.session.user.email });
    return res.json({ ok: true, latency_ms: r.latencyMs });
  }
  return res.json({ ok: false, error: r.reason, missing: r.missing, detail: r.error });
});

module.exports = router;
