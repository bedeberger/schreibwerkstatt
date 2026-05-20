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

const STRINGS = {
  de: {
    landingTitle:   '',
    landingSubtitle:'Schreiben, Lektorat und Buchanalyse mit KI — in einer Umgebung.',
    loginLabel:     'Anmelden',
    registerLabel:  'Zugang anfordern',
    landingFooter:  'Selbst gehostet vom Betreiber. Fragen zum Datenschutz bitte direkt an den Betreiber.',

    featuresTitle:  'Kernfunktionen',
    feat1Title:     'Schreiben',
    feat1Desc:      'Ablenkungsfreier Fokus-Editor mit Kapitelstruktur, Auto-Save, Versionshistorie und Suche.',
    feat2Title:     'KI-Lektorat',
    feat2Desc:      'Findet Stilbrüche, Wiederholungen, schwache Verben, Passivketten und Tempuswechsel — Seite für Seite.',
    feat3Title:     'Buchanalyse',
    feat3Desc:      'Extrahiert Figuren, Schauplätze, Szenen, Zeitstrahl und Kontinuitätsprobleme aus dem ganzen Manuskript.',
    feat4Title:     'Sparrings-Chat',
    feat4Desc:      'Seiten-Chat für gezielte Textstellen und agentischer Buch-Chat mit Zugriff auf Figuren, Orte, Szenen.',
    feat5Title:     'Bewertung',
    feat5Desc:      'Buch- und Kapitel-Review aus Lektor-Perspektive mit Stärken, Schwächen und konkreten Verbesserungen.',
    feat6Title:     'Export',
    feat6Desc:      'Druckfertiges PDF/A, EPUB, Markdown und Trainingsdaten für eigene Finetunes.',

    registerTitle:    'Zugang anfordern',
    registerSub:      'Wir antworten per Mail an die angegebene Adresse, sobald deine Anfrage geprüft wurde.',
    emailLabel:       'E-Mail',
    nameLabel:        'Name (optional)',
    messageLabel:     'Nachricht (optional, max. 500 Zeichen)',
    submitLabel:      'Anfrage senden',
    backToLanding:    'Zurück',
    registerFooter:   'Mit dem Absenden stimmst du der Speicherung deiner Anfrage zu (Löschung nach 30 Tagen, falls nicht freigeschaltet).',
    success:          'Anfrage eingegangen — du erhältst eine Mail, sobald sie geprüft wurde.',
    rateLimit:        'Zu viele Anfragen. Bitte später erneut versuchen.',
    invalid:          'Bitte gültige E-Mail-Adresse angeben.',
    error:            'Anfrage konnte nicht gesendet werden. Bitte später erneut versuchen.',
  },
  en: {
    landingTitle:   '',
    landingSubtitle:'Writing, editing and book analysis with AI — in one workspace.',
    loginLabel:     'Sign in',
    registerLabel:  'Request access',
    landingFooter:  'Self-hosted by the operator. For privacy questions please contact the operator directly.',

    featuresTitle:  'Core features',
    feat1Title:     'Writing',
    feat1Desc:      'Distraction-free focus editor with chapter structure, auto-save, revision history and search.',
    feat2Title:     'AI editing',
    feat2Desc:      'Catches style breaks, repetitions, weak verbs, passive chains and tense shifts — page by page.',
    feat3Title:     'Book analysis',
    feat3Desc:      'Extracts characters, locations, scenes, timeline and continuity issues across the whole manuscript.',
    feat4Title:     'Sparring chat',
    feat4Desc:      'Page chat for specific passages and an agentic book chat with access to characters, places and scenes.',
    feat5Title:     'Reviews',
    feat5Desc:      'Book and chapter reviews from an editor’s angle, with strengths, weaknesses and concrete fixes.',
    feat6Title:     'Export',
    feat6Desc:      'Print-ready PDF/A, EPUB, Markdown and training data for your own finetunes.',

    registerTitle:    'Request access',
    registerSub:      'We will reply by email to the address you provide once your request has been reviewed.',
    emailLabel:       'Email',
    nameLabel:        'Name (optional)',
    messageLabel:     'Message (optional, max 500 chars)',
    submitLabel:      'Send request',
    backToLanding:    'Back',
    registerFooter:   'By submitting you agree to your request being stored (deleted after 30 days unless approved).',
    success:          'Request received — you will get an email once it has been reviewed.',
    rateLimit:        'Too many requests. Please try again later.',
    invalid:          'Please provide a valid email address.',
    error:            'Could not send request. Please try again later.',
  },
};

function _strings(lang) {
  return STRINGS[lang] || STRINGS.de;
}

function _renderLanding(req, res) {
  const lang = _bodyLang(req);
  const s = _strings(lang);
  const appName = appSettings.get('app.name') || 'Schreibwerkstatt';
  res.set('Cache-Control', 'no-store');
  res.type('html').send(_render('landing.html', {
    lang,
    title:         appName,
    appName,
    subtitle:      s.landingSubtitle,
    loginLabel:    s.loginLabel,
    registerLabel: s.registerLabel,
    footer:        s.landingFooter,
    featuresTitle: s.featuresTitle,
    feat1Title:    s.feat1Title, feat1Desc: s.feat1Desc,
    feat2Title:    s.feat2Title, feat2Desc: s.feat2Desc,
    feat3Title:    s.feat3Title, feat3Desc: s.feat3Desc,
    feat4Title:    s.feat4Title, feat4Desc: s.feat4Desc,
    feat5Title:    s.feat5Title, feat5Desc: s.feat5Desc,
    feat6Title:    s.feat6Title, feat6Desc: s.feat6Desc,
  }));
}

function _renderRegister(req, res) {
  const lang = _bodyLang(req);
  const s = _strings(lang);
  const captchaSiteKey = appSettings.get('auth.captcha.site_key') || '';
  res.set('Cache-Control', 'no-store');
  const config = {
    captchaSiteKey,
    i18n: {
      success:   s.success,
      rateLimit: s.rateLimit,
      invalid:   s.invalid,
      error:     s.error,
    },
  };
  res.type('html').send(_render('register.html', {
    lang,
    title:          s.registerTitle,
    subtitle:       s.registerSub,
    emailLabel:     s.emailLabel,
    nameLabel:      s.nameLabel,
    messageLabel:   s.messageLabel,
    submitLabel:    s.submitLabel,
    backToLanding:  s.backToLanding,
    footerHint:     s.registerFooter,
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
