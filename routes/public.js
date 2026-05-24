'use strict';
// Public-Landing + Register.
//
// Routen (alle vor dem Auth-Guard in server.js gemountet):
//   GET  /              — eingeloggt → next(), unauth → landing.html
//   GET  /landing       — immer landing.html
//   GET  /register      — Formular (kein Session-Zwang)
//   POST /register      — Anfrage anlegen + Admin-Mail (Rate-Limit + optional Captcha)
//
// Anti-User-Enumeration: POST /register liefert IMMER 202 mit derselben
// Erfolgsmeldung, egal ob Email schon existiert, bereits pending ist oder
// neu angelegt wurde. Doppel-Anfragen werden via Partial-UNIQUE-Index
// vom DB-Layer abgefangen — Caller schluckt die SQLITE_CONSTRAINT-Exception.

const path = require('path');
const fs = require('fs');
const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const appUsers = require('../db/app-users');
const regRequests = require('../db/registration-requests');
const mailer = require('../lib/mailer');
const rateLimit = require('../lib/register-ratelimit');
const { tServer } = require('../lib/i18n-server');

const router = express.Router();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const _templateCache = new Map();
function _loadTemplate(name) {
  if (process.env.NODE_ENV !== 'production' || !_templateCache.has(name)) {
    _templateCache.set(name, fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'));
  }
  return _templateCache.get(name);
}

// Mini-Template-Substitution: {{key}} → vars[key]. Werte werden HTML-escaped,
// ausser sie enden auf "Json" (dann roher JSON-Stream fuer Inline-Skript).
const _escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function _render(name, vars) {
  const tpl = _loadTemplate(name);
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const raw = vars[key];
    if (raw === undefined || raw === null) return '';
    if (key.endsWith('Json')) return String(raw); // bereits JSON.stringify
    return _escHtml(raw);
  });
}

function _bodyLang(req) {
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  return accept.startsWith('en') ? 'en' : 'de';
}

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
}

function _renderLanding(req, res) {
  const lang = _bodyLang(req);
  const t = (key) => tServer(key, lang);
  const appName = appSettings.get('app.name') || 'Schreibwerkstatt';
  res.set('Cache-Control', 'no-store');
  res.type('html').send(_render('landing.html', {
    lang,
    title:         appName,
    appName,
    subtitle:      t('landing.subtitle'),
    loginLabel:    t('landing.loginLabel'),
    registerLabel: t('landing.registerLabel'),
    footer:        t('landing.footer'),
    githubUrl:     'https://github.com/bedeberger/schreibwerkstatt',
    githubLabel:   t('landing.githubLabel'),
    featuresTitle: t('landing.featuresTitle'),
    feat1Title:    t('landing.feat1Title'), feat1Desc: t('landing.feat1Desc'),
    feat2Title:    t('landing.feat2Title'), feat2Desc: t('landing.feat2Desc'),
    feat3Title:    t('landing.feat3Title'), feat3Desc: t('landing.feat3Desc'),
    feat4Title:    t('landing.feat4Title'), feat4Desc: t('landing.feat4Desc'),
    feat5Title:    t('landing.feat5Title'), feat5Desc: t('landing.feat5Desc'),
    feat6Title:    t('landing.feat6Title'), feat6Desc: t('landing.feat6Desc'),
  }));
}

function _renderRegister(req, res) {
  const lang = _bodyLang(req);
  const t = (key) => tServer(key, lang);
  const captchaSiteKey = appSettings.get('auth.captcha.site_key') || '';
  res.set('Cache-Control', 'no-store');
  const config = {
    captchaSiteKey,
    i18n: {
      success:   t('register.success'),
      rateLimit: t('register.rateLimit'),
      invalid:   t('register.invalid'),
      error:     t('register.error'),
    },
  };
  res.type('html').send(_render('register.html', {
    lang,
    title:          t('register.title'),
    subtitle:       t('register.subtitle'),
    emailLabel:     t('register.emailLabel'),
    nameLabel:      t('register.nameLabel'),
    messageLabel:   t('register.messageLabel'),
    submitLabel:    t('register.submitLabel'),
    backToLanding:  t('register.backToLanding'),
    footerHint:     t('register.footer'),
    captchaSiteKey,
    configJson:     JSON.stringify(config).replace(/</g, '\\u003c'),
  }));
}

// GET / — unauth → landing, eingeloggt → next() (SPA-Shell wird vom
// nachfolgenden staticServe in server.js geliefert).
router.get('/', (req, res, next) => {
  if (req.session?.user) return next();
  if (process.env.LOCAL_DEV_MODE === 'true') return next();
  return _renderLanding(req, res);
});

router.get('/landing', _renderLanding);
router.get('/register', _renderRegister);

// hCaptcha verifizieren — nur wenn beide Keys gesetzt sind. Sonst Hard
// Rate-Limit reicht als Spam-Schutz.
async function _verifyCaptcha(token, remoteIp) {
  const siteKey = appSettings.get('auth.captcha.site_key');
  const secret  = appSettings.get('auth.captcha.secret_key');
  if (!siteKey || !secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'missing-token' };
  try {
    const params = new URLSearchParams();
    params.set('secret', secret);
    params.set('response', token);
    if (remoteIp) params.set('remoteip', remoteIp);
    const r = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (j.success) return { ok: true };
    return { ok: false, reason: 'verify-failed', codes: j['error-codes'] || [] };
  } catch (e) {
    logger.warn(`captcha verify failed: ${e.message}`);
    return { ok: false, reason: 'verify-error' };
  }
}

const _emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', express.json({ limit: '8kb' }), async (req, res) => {
  const ip = _clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  const limit = rateLimit.check(ip);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfterSec));
    return res.status(429).json({ error_code: 'RATE_LIMITED', retryAfter: limit.retryAfterSec });
  }

  const { email, displayName, message, captchaToken } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!e || !_emailRegex.test(e) || e.length > 320) {
    rateLimit.record(ip); // Fehlversuch zaehlt — sonst freier Spam-Probe
    return res.status(400).json({ error_code: 'EMAIL_INVALID' });
  }

  const captcha = await _verifyCaptcha(captchaToken, ip);
  if (!captcha.ok) {
    rateLimit.record(ip);
    return res.status(400).json({ error_code: 'CAPTCHA_FAILED' });
  }

  const nameTrim = String(displayName || '').trim().slice(0, 120) || null;
  const msgTrim  = String(message || '').trim().slice(0, 500) || null;

  let created = null;
  try {
    created = regRequests.createRequest({ email: e, displayName: nameTrim, message: msgTrim, ip, userAgent });
  } catch (err) {
    // SQLITE_CONSTRAINT (Partial-UNIQUE pending): bestehende pending-Anfrage —
    // antworten als waere alles ok, kein Leak.
    if (!String(err.message || '').includes('UNIQUE')) {
      logger.warn(`registration_requests insert failed: ${err.message}`);
    }
  } finally {
    rateLimit.record(ip);
  }

  if (created) {
    logger.info(`registration-request eingegangen: ${e} (ip=${ip || '-'})`);
    // Admin-Mail (best effort): an alle active admin-User. Mailer skipt
    // selbst, wenn Gmail-Credentials fehlen.
    try {
      const admins = appUsers.listUsers().filter(u => u.global_role === 'admin' && u.status === 'active');
      const adminUrl = (appSettings.get('app.public_url') || '').replace(/\/$/, '') + '/#admin-users';
      for (const a of admins) {
        mailer.send({
          to: a.email,
          template: 'registration-request-admin',
          locale: a.language || 'de',
          ctx: {
            email: e,
            displayName: nameTrim || '',
            ip: ip || '',
            createdAt: created.created_at,
            adminUrl,
            message: msgTrim || '',
          },
        }).catch(err => logger.warn(`admin-notify failed: ${err.message}`));
      }
    } catch (err) {
      logger.warn(`admin-notify lookup failed: ${err.message}`);
    }
  }

  return res.status(202).json({ ok: true });
});

module.exports = router;
