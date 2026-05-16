'use strict';
// Gmail-only SMTP-Mailer (App-Passwort via nodemailer service:'gmail').
// Aktiv sobald smtp.gmail.user + smtp.gmail.app_password gesetzt sind.
// Host/Port/TLS sind durch service:'gmail' implizit (smtp.gmail.com:465 TLS).
// Settings:
//   smtp.gmail.user            — Gmail-Adresse (Pflicht, dient als from_email)
//   smtp.gmail.app_password    — 16-stelliges App-Passwort (Pflicht, encrypted)
//   smtp.from_name             — optionaler Anzeigename (Default 'Schreibwerkstatt')
//   smtp.reply_to              — optionaler Reply-To-Header
//   smtp.rate_limit_per_minute — In-Memory-Zähler, Default 30/min, 1s Backoff
//
// Hot-Reload: bei smtp.*-Änderung wird der Singleton-Transporter verworfen.

const logger = require('../logger');
const appSettings = require('./app-settings');
const { renderTemplate } = require('./mailer-templates');

let _transporter = null;
let _transporterKey = null;
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
  const user = appSettings.get('smtp.gmail.user') || '';
  const pass = appSettings.get('smtp.gmail.app_password') || '';
  return {
    user,
    pass,
    fromEmail: user,
    fromName:  appSettings.get('smtp.from_name') || 'Schreibwerkstatt',
    replyTo:   appSettings.get('smtp.reply_to')  || '',
  };
}

function _checkMissingFields(cfg) {
  const missing = [];
  if (!cfg.user) missing.push('smtp.gmail.user');
  if (!cfg.pass) missing.push('smtp.gmail.app_password');
  return missing;
}

function getStatus() {
  const cfg = _readConfig();
  const missing = _checkMissingFields(cfg);
  return {
    mode: missing.length === 0 ? 'gmail' : 'disabled',
    fromEmail: cfg.fromEmail,
    ready: missing.length === 0,
    missing,
  };
}

function _buildTransporter() {
  if (_testTransportFactory) return _testTransportFactory();

  const cfg = _readConfig();
  const missing = _checkMissingFields(cfg);
  if (missing.length > 0) {
    logger.warn(`mailer: incomplete config, missing=${missing.join(',')}`);
    return null;
  }
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

function getTransporter() {
  const cfg = _readConfig();
  const key = `${cfg.user}|${cfg.pass ? '1' : '0'}`;
  if (_transporter && _transporterKey === key) return _transporter;
  _transporter = _buildTransporter();
  _transporterKey = key;
  return _transporter;
}

appSettings.on('changed', ({ key }) => {
  if (key && key.startsWith('smtp.')) {
    _transporter = null;
    _transporterKey = null;
  }
});

async function send({ to, template, ctx = {}, locale = 'de' }) {
  if (!to) return { sent: false, reason: 'no-recipient' };
  if (!template) return { sent: false, reason: 'no-template' };

  const status = getStatus();
  if (!status.ready) {
    logger.warn(`mailer: not ready — skip template=${template} to=${to} missing=${status.missing.join(',')}`);
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
    logger.info(`mailer: sent template=${template} to=${to} latencyMs=${_now() - t0}`);
    return { sent: true, latencyMs: _now() - t0, info };
  } catch (e) {
    logger.error(`mailer: send failed template=${template} to=${to} err=${e.message}`);
    return { sent: false, reason: 'send-error', error: e.message };
  }
}

// Test-Hook (Unit-/Integration-Tests). Setzt Factory für alternativen
// Transporter (z.B. nodemailer.createTransport({ jsonTransport: true })).
function _setTestTransportFactory(factory) {
  _testTransportFactory = factory;
  _transporter = null;
  _transporterKey = null;
}

module.exports = { send, getStatus, getTransporter, _setTestTransportFactory };
