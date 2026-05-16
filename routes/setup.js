'use strict';
// Phase 4c1 (BookStack-Exit, docs/bookstack-exit.md): First-Run-Setup-Wizard.
// Admin-only Routen. Schreibt direkt in app_settings (kein Bulk-Commit am
// Ende — jeder Schritt ist atomar). /setup bleibt auch nach setup_completed
// erreichbar (Settings erneut durchgehen).

const express = require('express');
const path = require('path');
const appSettings = require('../lib/app-settings');
const { requireAdmin } = require('../lib/admin-mw');
const logger = require('../logger');

const router = express.Router();

// HTML-Page selbst ist eine geschuetzte Asset-Auslieferung. Der zentrale
// Auth-Guard in server.js leitet Unauth → /login um; eingeloggte Nicht-Admins
// stoppt der requireAdmin-Guard ab dem ersten /setup/state-Call.
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});

// Ab hier strikt admin-only (Session + global_role='admin').
router.use(requireAdmin);

// Welche Schritte sind ausgefuellt? Liefert sowohl Roh-Werte (nicht-encrypted)
// als auch Boolean-Flags pro Schritt. ADMIN_EMAIL aus ENV als read-only Hint.
router.get('/state', (req, res) => {
  const setupCompleted = appSettings.get('app.setup_completed') === true;
  const publicUrl = appSettings.get('app.public_url') || '';
  const allowedEmails = appSettings.get('auth.allowed_emails') || '';
  const provider = appSettings.get('ai.provider') || 'claude';
  const backend = appSettings.get('app.backend') || 'localdb';
  const ollamaHost = appSettings.get('ai.ollama.host') || '';
  const llamaHost = appSettings.get('ai.llama.host') || '';
  const claudeModel = appSettings.get('ai.claude.model') || '';
  const bookstackUrl = appSettings.get('app.bookstack.base_url') || '';
  const smtpMode = appSettings.get('smtp.mode') || 'disabled';

  // Has-Flags via has() — Defaults zaehlen nicht als "ausgefuellt".
  const hasClaudeKey = appSettings.has('ai.claude.api_key');
  const hasGoogleId = appSettings.has('auth.google.client_id');
  const hasGoogleSecret = appSettings.has('auth.google.client_secret');
  const hasBsTokenId = appSettings.has('app.bookstack.token_id');
  const hasBsTokenSecret = appSettings.has('app.bookstack.token_secret');

  res.json({
    setup_completed: setupCompleted,
    admin_email: process.env.ADMIN_EMAIL || null,
    steps: {
      publicUrl: !!publicUrl,
      oauth: hasGoogleId && hasGoogleSecret,
      emails: !!allowedEmails,
      ai: provider === 'claude' ? hasClaudeKey
        : provider === 'ollama' ? !!ollamaHost
        : provider === 'llama'  ? !!llamaHost
        : false,
      backend: backend === 'localdb' ? true
        : backend === 'bookstack' ? (!!bookstackUrl && hasBsTokenId && hasBsTokenSecret)
        : false,
      smtp: smtpMode !== undefined,
    },
    values: {
      publicUrl,
      allowedEmails,
      provider,
      claudeModel,
      ollamaHost,
      ollamaModel: appSettings.get('ai.ollama.model') || '',
      llamaHost,
      llamaModel: appSettings.get('ai.llama.model') || '',
      backend,
      bookstackUrl,
      smtpMode,
      smtpFromEmail: appSettings.get('smtp.from_email') || '',
      smtpFromName: appSettings.get('smtp.from_name') || '',
      smtpGmailUser: appSettings.get('smtp.gmail.user') || '',
      smtpHost: appSettings.get('smtp.host') || '',
      smtpPort: appSettings.get('smtp.port') || 587,
      smtpSecure: appSettings.get('smtp.secure') === true,
      smtpUser: appSettings.get('smtp.user') || '',
    },
    masked: {
      googleClientId: hasGoogleId,
      googleClientSecret: hasGoogleSecret,
      claudeApiKey: hasClaudeKey,
      bookstackTokenId: hasBsTokenId,
      bookstackTokenSecret: hasBsTokenSecret,
      gmailClientId: appSettings.has('smtp.gmail.client_id'),
      gmailClientSecret: appSettings.has('smtp.gmail.client_secret'),
      gmailRefreshToken: appSettings.has('smtp.gmail.refresh_token'),
      gmailAppPassword: appSettings.has('smtp.gmail.app_password'),
      smtpPassword: appSettings.has('smtp.password'),
    },
  });
});

// Spezifische Routen zuerst — Express matched in Reihenfolge, sonst frisst
// `/:step` auch `/test/oauth`, `/complete` etc. und liefert 404.
router.post('/test/oauth', _testOauth);
router.post('/test/provider', express.json(), _testProvider);
router.post('/test/backend', _testBackend);
router.post('/test/smtp', express.json(), _testSmtp);
router.post('/complete', _complete);

// POST /setup/:step — speichert die Felder eines Schritts in app_settings.
// Body-Schema je Step. Encrypted-Felder akzeptieren Sentinel "__unchanged__"
// (Re-Save ohne Klartext) — derselbe Mechanismus wie /admin/settings.
router.post('/:step', express.json(), (req, res) => {
  const { step } = req.params;
  const body = req.body || {};
  const updatedBy = req.session.user.email;
  const updates = [];

  function queue(key, value) {
    if (value === undefined) return;
    if (appSettings.isEncryptedKey(key) && value === '') return; // leer = nicht ueberschreiben
    if (appSettings.isEncryptedKey(key) && value === '__unchanged__') return;
    updates.push([key, value]);
  }

  try {
    if (step === 'public-url') {
      const url = typeof body.publicUrl === 'string' ? body.publicUrl.trim().replace(/\/$/, '') : '';
      if (!url) return res.status(400).json({ error_code: 'PUBLIC_URL_REQUIRED' });
      try { new URL(url); }
      catch { return res.status(400).json({ error_code: 'PUBLIC_URL_INVALID' }); }
      queue('app.public_url', url);
    } else if (step === 'oauth') {
      queue('auth.google.client_id', body.clientId);
      queue('auth.google.client_secret', body.clientSecret);
    } else if (step === 'emails') {
      const csv = typeof body.allowedEmails === 'string' ? body.allowedEmails.trim() : '';
      queue('auth.allowed_emails', csv);
    } else if (step === 'ai') {
      const provider = String(body.provider || '').toLowerCase();
      if (!['claude', 'ollama', 'llama'].includes(provider)) {
        return res.status(400).json({ error_code: 'PROVIDER_INVALID' });
      }
      queue('ai.provider', provider);
      if (provider === 'claude') {
        queue('ai.claude.api_key', body.claudeApiKey);
        if (body.claudeModel) queue('ai.claude.model', String(body.claudeModel));
      } else if (provider === 'ollama') {
        if (body.ollamaHost) queue('ai.ollama.host', String(body.ollamaHost));
        if (body.ollamaModel) queue('ai.ollama.model', String(body.ollamaModel));
      } else if (provider === 'llama') {
        if (body.llamaHost) queue('ai.llama.host', String(body.llamaHost));
        if (body.llamaModel) queue('ai.llama.model', String(body.llamaModel));
      }
    } else if (step === 'backend') {
      const backend = String(body.backend || '').toLowerCase();
      if (!['localdb', 'bookstack'].includes(backend)) {
        return res.status(400).json({ error_code: 'BACKEND_INVALID' });
      }
      queue('app.backend', backend);
      if (backend === 'bookstack') {
        if (body.bookstackUrl) queue('app.bookstack.base_url', String(body.bookstackUrl).replace(/\/$/, ''));
        queue('app.bookstack.token_id', body.bookstackTokenId);
        queue('app.bookstack.token_secret', body.bookstackTokenSecret);
      }
    } else if (step === 'smtp') {
      const mode = String(body.mode || 'disabled').toLowerCase();
      if (!['disabled', 'gmail-oauth', 'gmail-app-password', 'generic'].includes(mode)) {
        return res.status(400).json({ error_code: 'SMTP_MODE_INVALID' });
      }
      queue('smtp.mode', mode);
      if (body.fromEmail !== undefined) queue('smtp.from_email', String(body.fromEmail || ''));
      if (body.fromName !== undefined) queue('smtp.from_name', String(body.fromName || ''));
      if (mode === 'gmail-oauth') {
        if (body.gmailUser !== undefined) queue('smtp.gmail.user', String(body.gmailUser || ''));
        queue('smtp.gmail.client_id', body.gmailClientId);
        queue('smtp.gmail.client_secret', body.gmailClientSecret);
        queue('smtp.gmail.refresh_token', body.gmailRefreshToken);
      } else if (mode === 'gmail-app-password') {
        if (body.gmailUser !== undefined) queue('smtp.gmail.user', String(body.gmailUser || ''));
        queue('smtp.gmail.app_password', body.gmailAppPassword);
      } else if (mode === 'generic') {
        if (body.host !== undefined) queue('smtp.host', String(body.host || ''));
        if (body.port !== undefined) queue('smtp.port', parseInt(body.port, 10) || 587);
        if (body.secure !== undefined) queue('smtp.secure', !!body.secure);
        if (body.user !== undefined) queue('smtp.user', String(body.user || ''));
        queue('smtp.password', body.password);
      }
    } else {
      return res.status(404).json({ error_code: 'STEP_UNKNOWN' });
    }

    for (const [key, value] of updates) {
      appSettings.set(key, value, { updatedBy });
    }
    logger.info(`setup: step=${step} keys=${updates.map(u => u[0]).join(',')}`, { user: updatedBy });
    res.json({ ok: true, step, updated: updates.map(([k]) => k) });
  } catch (e) {
    logger.error(`setup ${step}: ${e.message}`, { user: updatedBy });
    res.status(500).json({ error_code: 'STEP_FAILED', detail: e.message });
  }
});

// Test-Probes. Wiederverwendung der admin-settings-Probe-Logik wuerde einen
// HTTP-Roundtrip kosten — Inline-Aufruf gegen aktuellen DB-Stand ist sauberer.
async function _testOauth(req, res) {
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
}

async function _testProvider(req, res) {
  const provider = appSettings.get('ai.provider');
  const t0 = Date.now();
  try {
    if (provider === 'claude') {
      const key = appSettings.get('ai.claude.api_key');
      if (!key) return res.json({ ok: false, error: 'NO_API_KEY' });
      const model = appSettings.get('ai.claude.model');
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      return res.json({ ok: resp.ok, status: resp.status, provider, model, latency_ms: Date.now() - t0 });
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
}

async function _testBackend(req, res) {
  const backend = appSettings.get('app.backend');
  if (backend === 'localdb') return res.json({ ok: true, backend });
  const url = appSettings.get('app.bookstack.base_url');
  const id = appSettings.get('app.bookstack.token_id');
  const secret = appSettings.get('app.bookstack.token_secret');
  if (!url || !id || !secret) return res.json({ ok: false, error: 'INCOMPLETE' });
  const t0 = Date.now();
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/books?count=1`, {
      headers: { Authorization: `Token ${id}:${secret}` },
    });
    return res.json({ ok: r.ok, status: r.status, latency_ms: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: e.message, latency_ms: Date.now() - t0 });
  }
}

async function _testSmtp(req, res) {
  // Mailer-Modul existiert erst mit Phase 4c2 — bis dahin Stub.
  let mailer;
  try { mailer = require('../lib/mailer'); }
  catch { return res.json({ ok: false, error: 'MAILER_NOT_AVAILABLE' }); }
  if (typeof mailer.sendTestMail !== 'function') {
    return res.json({ ok: false, error: 'MAILER_NOT_AVAILABLE' });
  }
  const to = (req.body?.to || appSettings.get('smtp.from_email') || '').trim();
  if (!to) return res.json({ ok: false, error: 'NO_RECIPIENT' });
  const t0 = Date.now();
  try {
    const result = await mailer.sendTestMail({ to });
    return res.json({ ok: !!result?.ok, latency_ms: Date.now() - t0, ...(result || {}) });
  } catch (e) {
    return res.json({ ok: false, error: e.message, latency_ms: Date.now() - t0 });
  }
}

// Wizard abschliessen. Setzt setup_completed + spiegelt ADMIN_EMAIL fuer UI.
function _complete(req, res) {
  const updatedBy = req.session.user.email;
  appSettings.set('app.setup_completed', true, { updatedBy });
  if (process.env.ADMIN_EMAIL) {
    appSettings.set('auth.admin_email', process.env.ADMIN_EMAIL, { updatedBy });
  }
  logger.info('setup completed', { user: updatedBy });
  res.json({ ok: true });
}

module.exports = router;
