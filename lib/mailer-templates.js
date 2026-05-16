'use strict';
// Phase 4c2 (BookStack-Exit, docs/bookstack-exit.md): Mail-Templates.
// Pro Template: { subjectKey, render(ctx, locale) → { subject, html, text } }.
// HTML-Body escapest User-Input ueber _escHtml (Server-Mini-Helper, keine
// public/js/utils.js-Dep — Server-Pfad bleibt minimal).
//
// Locale-Auflösung passiert im Caller (lib/mailer.js): app_users.language
// → 'de' Fallback. i18n-Strings live als JSON-Lookup-Map hier, weil Templates
// nicht zur Laufzeit aus public/js/i18n/*.json gerendert werden (das ist
// Frontend-Welt).

const _esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const TEXT = {
  de: {
    'mail.subject.invite':                   'Einladung zu {appName}',
    'mail.subject.test':                     'Testmail von {appName}',
    'mail.body.invite.intro':                '{inviterName} hat dich zu {appName} eingeladen.',
    'mail.body.invite.cta':                  'Über folgenden Link kannst du dich anmelden:',
    'mail.body.invite.expires':              'Der Einladungslink ist gültig bis {expiresAt}.',
    'mail.body.invite.footer':               'Falls du diese Mail nicht erwartet hast, kannst du sie ignorieren.',
    'mail.body.test.intro':                  'Diese Mail bestätigt, dass {appName} Mails versenden kann.',
    'mail.body.test.config':                 'Konfiguration: {mode} über {fromEmail}.',
  },
  en: {
    'mail.subject.invite':                   'Invitation to {appName}',
    'mail.subject.test':                     'Test email from {appName}',
    'mail.body.invite.intro':                '{inviterName} has invited you to {appName}.',
    'mail.body.invite.cta':                  'Use the following link to sign in:',
    'mail.body.invite.expires':              'The invitation link is valid until {expiresAt}.',
    'mail.body.invite.footer':               'If you did not expect this email you can simply ignore it.',
    'mail.body.test.intro':                  'This message confirms that {appName} can send mail.',
    'mail.body.test.config':                 'Configuration: {mode} via {fromEmail}.',
  },
};

function _t(locale, key, params) {
  const dict = TEXT[locale] || TEXT.de;
  let str = dict[key] || TEXT.de[key] || key;
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => params[k] != null ? String(params[k]) : `{${k}}`);
}

const TEMPLATES = {
  invite: {
    subjectKey: 'mail.subject.invite',
    render(ctx, locale = 'de') {
      const params = {
        appName: ctx.appName || 'Schreibwerkstatt',
        inviterName: ctx.inviterName || ctx.invitedBy || 'Ein Admin',
        inviteUrl: ctx.inviteUrl || '',
        expiresAt: ctx.expiresAt || '',
        role: ctx.role || 'user',
      };
      const subject = _t(locale, 'mail.subject.invite', params);
      const intro    = _t(locale, 'mail.body.invite.intro', params);
      const cta      = _t(locale, 'mail.body.invite.cta', params);
      const expires  = _t(locale, 'mail.body.invite.expires', params);
      const footer   = _t(locale, 'mail.body.invite.footer', params);
      const url = _esc(params.inviteUrl);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p>${_esc(cta)}</p>
<p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>
<p style="color:#666;font-size:0.9em">${_esc(expires)}</p>
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n${cta}\n${params.inviteUrl}\n\n${expires}\n\n${footer}`;
      return { subject, html, text };
    },
  },

  test: {
    subjectKey: 'mail.subject.test',
    render(ctx, locale = 'de') {
      const params = {
        appName: ctx.appName || 'Schreibwerkstatt',
        mode: ctx.mode || 'unknown',
        fromEmail: ctx.fromEmail || '',
      };
      const subject = _t(locale, 'mail.subject.test', params);
      const intro = _t(locale, 'mail.body.test.intro', params);
      const config = _t(locale, 'mail.body.test.config', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="color:#666;font-size:0.9em">${_esc(config)}</p>
</body></html>`;
      const text = `${intro}\n\n${config}`;
      return { subject, html, text };
    },
  },
};

function renderTemplate(name, ctx, locale = 'de') {
  const tpl = TEMPLATES[name];
  if (!tpl) throw new Error(`unknown template: ${name}`);
  return tpl.render(ctx || {}, locale);
}

function listTemplates() {
  return Object.keys(TEMPLATES);
}

module.exports = { renderTemplate, listTemplates, TEMPLATES, _esc };
