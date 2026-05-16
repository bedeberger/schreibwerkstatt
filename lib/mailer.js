'use strict';
// Phase 4c2 (BookStack-Exit, docs/bookstack-exit.md): SMTP-Mailer-Service.
//
// Singleton-Transporter aus aktuellen `smtp.*`-app_settings. Hört auf
// `app-settings:changed`-Event und reinitialisiert bei smtp-Änderung. Modes:
//   - 'disabled'             — no-op + warn (Caller bekommt {sent:false,reason})
//   - 'gmail-oauth'          — nodemailer-OAuth2 mit refresh_token
//   - 'gmail-app-password'   — service:gmail + App-Passwort
//   - 'generic'              — host/port/secure/user/password
//
// Rate-Limit: in-Memory-Counter pro Minute (Default 30/min). Bei Überlauf
// wird die Mail mit 1s-Backoff retried (in-Memory, kein persistenter Queue).

const logger = require('../logger');
const appSettings = require('./app-settings');
const { renderTemplate } = require('./mailer-templates');

let _transporter = null;
let _transporterMode = null;
let _sentInWindow = [];
let _testTransportFactory = null; // nur in Tests gesetzt

function _now() { return Date.now(); }

function _underRateLimit() {
  const limit = Number(appSettings.get('smtp.rate_limit_per_minute')) || 30;
  const cutoff = _now() - 60_000;
  _sentInWindow = _sentInWindow.filter(t => t > cutoff);
  return _sentInWindow.length < limit;
}

function _recordSend() {
  _sentInWindow.push(_now());
}

function _readConfig() {
  return {
    mode:                appSettings.get('smtp.mode') || 'disabled',
    fromEmail:           appSettings.get('smtp.from_email') || '',
    fromName:            appSettings.get('smtp.from_name') || '',
    replyTo:             appSettings.get('smtp.reply_to') || '',
    gmailClientId:       appSettings.get('smtp.gmail.client_id') || '',
    gmailClientSecret:   appSettings.get('smtp.gmail.client_secret') || '',
    gmailRefreshToken:   appSettings.get('smtp.gmail.refresh_token') || '',
    gmailUser:           appSettings.get('smtp.gmail.user') || '',
    gmailAppPassword:    appSettings.get('smtp.gmail.app_password') || '',
    genericHost:         appSettings.get('smtp.host') || '',
    genericPort:         Number(appSettings.get('smtp.port')) || 587,
    genericSecure:       !!appSettings.get('smtp.secure'),
    genericUser:         appSettings.get('smtp.user') || '',
    genericPassword:     appSettings.get('smtp.password') || '',
  };
}

function _checkMissingFields(cfg) {
  const missing = [];
  if (cfg.mode === 'disabled') return missing;
  if (!cfg.fromEmail) missing.push('smtp.from_email');
  if (cfg.mode === 'gmail-oauth') {
    if (!cfg.gmailClientId) missing.push('smtp.gmail.client_id');
    if (!cfg.gmailClientSecret) missing.push('smtp.gmail.client_secret');
    if (!cfg.gmailRefreshToken) missing.push('smtp.gmail.refresh_token');
    if (!cfg.gmailUser) missing.push('smtp.gmail.user');
  } else if (cfg.mode === 'gmail-app-password') {
    if (!cfg.gmailUser) missing.push('smtp.gmail.user');
    if (!cfg.gmailAppPassword) missing.push('smtp.gmail.app_password');
  } else if (cfg.mode === 'generic') {
    if (!cfg.genericHost) missing.push('smtp.host');
    if (!cfg.genericUser) missing.push('smtp.user');
    if (!cfg.genericPassword) missing.push('smtp.password');
  }
  return missing;
}

function getStatus() {
  const cfg = _readConfig();
  const missing = _checkMissingFields(cfg);
  return {
    mode: cfg.mode,
    fromEmail: cfg.fromEmail,
    ready: cfg.mode !== 'disabled' && missing.length === 0,
    missing,
  };
}

function _buildTransporter() {
  // Test-Override: jsonTransport-Stream fuer Integration-Tests.
  if (_testTransportFactory) return _testTransportFactory();

  const cfg = _readConfig();
  if (cfg.mode === 'disabled') return null;
  const missing = _checkMissingFields(cfg);
  if (missing.length > 0) {
    logger.warn(`mailer: incomplete config, missing=${missing.join(',')}`);
    return null;
  }
  const nodemailer = require('nodemailer');
  if (cfg.mode === 'gmail-oauth') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: cfg.gmailUser,
        clientId: cfg.gmailClientId,
        clientSecret: cfg.gmailClientSecret,
        refreshToken: cfg.gmailRefreshToken,
      },
    });
  }
  if (cfg.mode === 'gmail-app-password') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.gmailUser, pass: cfg.gmailAppPassword },
    });
  }
  if (cfg.mode === 'generic') {
    return nodemailer.createTransport({
      host: cfg.genericHost,
      port: cfg.genericPort,
      secure: cfg.genericSecure,
      auth: { user: cfg.genericUser, pass: cfg.genericPassword },
    });
  }
  return null;
}

function getTransporter() {
  const cfg = _readConfig();
  if (_transporter && _transporterMode === cfg.mode) return _transporter;
  _transporter = _buildTransporter();
  _transporterMode = cfg.mode;
  return _transporter;
}

// Settings-Hot-Reload: bei smtp.*-Änderung wird der Singleton verworfen.
appSettings.on('changed', ({ key }) => {
  if (key && key.startsWith('smtp.')) {
    _transporter = null;
    _transporterMode = null;
  }
});

async function send({ to, template, ctx = {}, locale = 'de' }) {
  if (!to) return { sent: false, reason: 'no-recipient' };
  if (!template) return { sent: false, reason: 'no-template' };

  const status = getStatus();
  if (!status.ready) {
    if (status.mode === 'disabled') {
      logger.warn(`mailer: disabled — skip template=${template} to=${to}`);
      return { sent: false, reason: 'disabled' };
    }
    logger.warn(`mailer: incomplete config — skip template=${template} to=${to}`);
    return { sent: false, reason: 'incomplete-config', missing: status.missing };
  }

  if (!_underRateLimit()) {
    await new Promise(r => setTimeout(r, 1000));
    if (!_underRateLimit()) {
      return { sent: false, reason: 'rate-limit' };
    }
  }

  const transporter = getTransporter();
  if (!transporter) return { sent: false, reason: 'no-transporter' };

  const cfg = _readConfig();
  const rendered = renderTemplate(template, { ...ctx, appName: 'Schreibwerkstatt' }, locale);
  const fromLine = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;

  const t0 = _now();
  try {
    const info = await transporter.sendMail({
      from: fromLine,
      to,
      replyTo: cfg.replyTo || undefined,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    _recordSend();
    logger.info(`mailer: sent template=${template} to=${to} latencyMs=${_now() - t0} mode=${cfg.mode}`);
    return { sent: true, latencyMs: _now() - t0, info };
  } catch (e) {
    logger.error(`mailer: send failed template=${template} to=${to} err=${e.message}`);
    return { sent: false, reason: 'send-error', error: e.message };
  }
}

// Test-Hook (nur fuer Unit-/Integration-Tests). Setzt eine Factory, die einen
// alternativen Transporter (z.B. nodemailer.createTransport({ jsonTransport: true }))
// liefert. Aufruf vor send() reicht; Cache wird invalidiert.
function _setTestTransportFactory(factory) {
  _testTransportFactory = factory;
  _transporter = null;
  _transporterMode = null;
}

module.exports = { send, getStatus, getTransporter, _setTestTransportFactory };
