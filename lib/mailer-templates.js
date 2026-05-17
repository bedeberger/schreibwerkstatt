'use strict';
// Mail-Templates.
// Pro Template: { subjectKey, render(ctx, locale) → { subject, html, text } }.
// HTML-Body escapest User-Input ueber _escHtml (Server-Mini-Helper, keine
// public/js/utils.js-Dep — Server-Pfad bleibt minimal).
//
// Locale-Auflösung passiert im Caller (lib/mailer.js): app_users.language
// → 'de' Fallback. Mail-eigene Strings (mail.subject.*, mail.body.*) leben als
// JSON-Lookup-Map hier; Job-Error-Keys (z.B. job.error.phase1Incomplete) werden
// via lib/i18n-server.js aus public/js/i18n/*.json gerendert, damit Admin-Mails
// den vollständigen Fehler inkl. Platzhalter sehen.

const { tServerParams } = require('./i18n-server');

const _esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// errorMsg ist ein i18n-Key (z.B. 'job.error.phase1Incomplete') aus failJob.
// Hier zur Mail-Locale aufloesen + {count}/{details}-Platzhalter ersetzen,
// damit der Admin nicht nur den Key sieht.
function _renderErrorMsg(msg, params, locale) {
  if (!msg || typeof msg !== 'string') return '—';
  if (!msg.includes('.') && !params) return msg;
  return tServerParams(msg, params, locale);
}

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
    // Registrierungs-Workflow.
    'mail.subject.registrationRequestAdmin': 'Neue Zugangs-Anfrage: {email}',
    'mail.subject.registrationApproved':     'Dein Zugang zu {appName} wurde freigeschaltet',
    'mail.subject.registrationDenied':       'Deine Zugangs-Anfrage zu {appName}',
    'mail.body.regReqAdmin.intro':           'Eine neue Zugangs-Anfrage liegt vor:',
    'mail.body.regReqAdmin.email':           'E-Mail: {email}',
    'mail.body.regReqAdmin.name':            'Name: {displayName}',
    'mail.body.regReqAdmin.message':         'Nachricht:',
    'mail.body.regReqAdmin.meta':            'IP: {ip} · Zeit: {createdAt}',
    'mail.body.regReqAdmin.cta':             'Verwalten in der Admin-Konsole:',
    'mail.body.regApproved.intro':           'Dein Zugang zu {appName} wurde freigeschaltet.',
    'mail.body.regApproved.cta':             'Bitte melde dich über folgenden Link an:',
    'mail.body.regApproved.expires':         'Der Einladungslink ist bis {expiresAt} gültig.',
    'mail.body.regDenied.intro':             'Deine Zugangs-Anfrage zu {appName} wurde leider abgelehnt.',
    'mail.body.regDenied.reason':            'Begründung: {reason}',
    'mail.body.regDenied.footer':            'Bei Rückfragen wende dich an den Administrator.',
    // Buch-Share-Benachrichtigung.
    'mail.subject.bookShared':               '{appName}: Du wurdest zu „{bookName}" hinzugefügt',
    'mail.body.bookShared.intro':            '{inviterName} hat dich als {roleLabel} zu „{bookName}" hinzugefügt.',
    'mail.body.bookShared.cta':              'Buch in {appName} öffnen:',
    'mail.body.bookShared.noUrl':            'Melde dich in {appName} an, um das Buch zu öffnen.',
    'mail.body.bookShared.footer':           'Falls du diese Mail nicht erwartet hast, kannst du sie ignorieren.',
    'mail.body.bookShared.role.viewer':      'Leser',
    'mail.body.bookShared.role.lektor':      'Lektor',
    'mail.body.bookShared.role.editor':      'Editor',
    // Job-Fail-Admin.
    'mail.subject.jobFailedAdmin':           '{appName}: Job-Fehler — {jobType}',
    'mail.body.jobFailedAdmin.intro':        'Ein Hintergrund-Job ist fehlgeschlagen.',
    'mail.body.jobFailedAdmin.fields':       'Job-Typ: {jobType}',
    'mail.body.jobFailedAdmin.user':         'User: {userEmail}',
    'mail.body.jobFailedAdmin.book':         'Buch: {bookName} (#{bookId})',
    'mail.body.jobFailedAdmin.error':        'Fehler: {errorMsg}',
    'mail.body.jobFailedAdmin.model':        'Modell: {provider}/{model}',
    'mail.body.jobFailedAdmin.tokens':       'Tokens: {tokensIn}↑ / {tokensOut}↓',
    'mail.body.jobFailedAdmin.duration':     'Dauer: {duration}',
    'mail.body.jobFailedAdmin.jobId':        'Job-ID: {jobId}',
    // Token-Cap-Admin.
    'mail.subject.tokenCapHitAdmin':         '{appName}: Token-Cap erreicht — {jobType}',
    'mail.body.tokenCapHitAdmin.intro':      'Ein Job wurde wegen Erreichen des Token-Caps abgebrochen.',
    'mail.body.tokenCapHitAdmin.hint':       'Erhöhe `MODEL_TOKEN` oder zerlege das Buch in kleinere Kapitel.',
    // Budget-Overrun.
    'mail.subject.budgetOverrunUser':        '{appName}: Monatsbudget erreicht',
    'mail.subject.budgetOverrunAdmin':       '{appName}: Budget-Overrun — {userEmail}',
    'mail.body.budgetOverrun.intro':         'Das Monatsbudget für {userEmail} wurde im Zeitraum {period} überschritten.',
    'mail.body.budgetOverrun.usage':         'Verbrauch: {usd} USD von {budget} USD',
    'mail.body.budgetOverrun.modeSoft':      'Modus: Soft — KI-Calls laufen weiter, dies ist nur eine Warnung.',
    'mail.body.budgetOverrun.modeHard':      'Modus: Hard — neue KI-Calls werden bis zum Monatswechsel blockiert.',
    'mail.body.budgetOverrun.userIntro':     'Dein Monatsbudget bei {appName} wurde überschritten.',
    'mail.body.budgetOverrun.footer':        'Diese Mail wird einmal pro Monat verschickt.',
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
    'mail.subject.registrationRequestAdmin': 'New access request: {email}',
    'mail.subject.registrationApproved':     'Your access to {appName} has been approved',
    'mail.subject.registrationDenied':       'Your access request for {appName}',
    'mail.body.regReqAdmin.intro':           'A new access request has arrived:',
    'mail.body.regReqAdmin.email':           'Email: {email}',
    'mail.body.regReqAdmin.name':            'Name: {displayName}',
    'mail.body.regReqAdmin.message':         'Message:',
    'mail.body.regReqAdmin.meta':            'IP: {ip} · Time: {createdAt}',
    'mail.body.regReqAdmin.cta':             'Manage in the admin console:',
    'mail.body.regApproved.intro':           'Your access to {appName} has been approved.',
    'mail.body.regApproved.cta':             'Please sign in via the following link:',
    'mail.body.regApproved.expires':         'The invitation link is valid until {expiresAt}.',
    'mail.body.regDenied.intro':             'Your access request for {appName} has been declined.',
    'mail.body.regDenied.reason':            'Reason: {reason}',
    'mail.body.regDenied.footer':            'Please reach out to the administrator with any questions.',
    'mail.subject.bookShared':               '{appName}: you were added to "{bookName}"',
    'mail.body.bookShared.intro':            '{inviterName} added you as {roleLabel} to "{bookName}".',
    'mail.body.bookShared.cta':              'Open the book in {appName}:',
    'mail.body.bookShared.noUrl':            'Sign in to {appName} to open the book.',
    'mail.body.bookShared.footer':           'If you did not expect this email you can simply ignore it.',
    'mail.body.bookShared.role.viewer':      'Reader',
    'mail.body.bookShared.role.lektor':      'Proof-reader',
    'mail.body.bookShared.role.editor':      'Editor',
    'mail.subject.jobFailedAdmin':           '{appName}: job failed — {jobType}',
    'mail.body.jobFailedAdmin.intro':        'A background job has failed.',
    'mail.body.jobFailedAdmin.fields':       'Job type: {jobType}',
    'mail.body.jobFailedAdmin.user':         'User: {userEmail}',
    'mail.body.jobFailedAdmin.book':         'Book: {bookName} (#{bookId})',
    'mail.body.jobFailedAdmin.error':        'Error: {errorMsg}',
    'mail.body.jobFailedAdmin.model':        'Model: {provider}/{model}',
    'mail.body.jobFailedAdmin.tokens':       'Tokens: {tokensIn}↑ / {tokensOut}↓',
    'mail.body.jobFailedAdmin.duration':     'Duration: {duration}',
    'mail.body.jobFailedAdmin.jobId':        'Job ID: {jobId}',
    'mail.subject.tokenCapHitAdmin':         '{appName}: token cap hit — {jobType}',
    'mail.body.tokenCapHitAdmin.intro':      'A job was aborted because the output-token cap was reached.',
    'mail.body.tokenCapHitAdmin.hint':       'Increase `MODEL_TOKEN` or split the book into smaller chapters.',
    'mail.subject.budgetOverrunUser':        '{appName}: monthly budget reached',
    'mail.subject.budgetOverrunAdmin':       '{appName}: budget overrun — {userEmail}',
    'mail.body.budgetOverrun.intro':         'The monthly budget for {userEmail} has been exceeded in period {period}.',
    'mail.body.budgetOverrun.usage':         'Usage: {usd} USD of {budget} USD',
    'mail.body.budgetOverrun.modeSoft':      'Mode: Soft — AI calls keep running, this is just a warning.',
    'mail.body.budgetOverrun.modeHard':      'Mode: Hard — new AI calls are blocked until the month rolls over.',
    'mail.body.budgetOverrun.userIntro':     'Your monthly budget on {appName} has been exceeded.',
    'mail.body.budgetOverrun.footer':        'This notification is sent at most once per month.',
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

  'registration-request-admin': {
    subjectKey: 'mail.subject.registrationRequestAdmin',
    render(ctx, locale = 'de') {
      const params = {
        appName:     ctx.appName || 'Schreibwerkstatt',
        email:       ctx.email || '',
        displayName: ctx.displayName || '—',
        ip:          ctx.ip || '—',
        createdAt:   ctx.createdAt || '',
        adminUrl:    ctx.adminUrl || '',
        message:     ctx.message || '',
      };
      const subject  = _t(locale, 'mail.subject.registrationRequestAdmin', params);
      const intro    = _t(locale, 'mail.body.regReqAdmin.intro', params);
      const emailLn  = _t(locale, 'mail.body.regReqAdmin.email', params);
      const nameLn   = _t(locale, 'mail.body.regReqAdmin.name', params);
      const msgLn    = _t(locale, 'mail.body.regReqAdmin.message', params);
      const meta     = _t(locale, 'mail.body.regReqAdmin.meta', params);
      const cta      = _t(locale, 'mail.body.regReqAdmin.cta', params);
      const adminUrl = _esc(params.adminUrl);
      const msgBlock = params.message
        ? `<p style="margin:8px 0 0">${_esc(msgLn)}</p><blockquote style="margin:4px 0 0;padding:8px 12px;background:#f5f5f5;border-left:3px solid #ccc;white-space:pre-wrap">${_esc(params.message)}</blockquote>`
        : '';
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0">${_esc(emailLn)}<br>${_esc(nameLn)}</p>
${msgBlock}
<p style="color:#666;font-size:0.85em;margin-top:16px">${_esc(meta)}</p>
<p style="margin-top:24px">${_esc(cta)}</p>
<p><a href="${adminUrl}" style="display:inline-block;padding:10px 16px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${adminUrl}</a></p>
</body></html>`;
      const text = `${intro}\n\n${emailLn}\n${nameLn}\n` +
        (params.message ? `\n${msgLn}\n${params.message}\n` : '') +
        `\n${meta}\n\n${cta}\n${params.adminUrl}\n`;
      return { subject, html, text };
    },
  },

  'registration-approved': {
    subjectKey: 'mail.subject.registrationApproved',
    render(ctx, locale = 'de') {
      const params = {
        appName:   ctx.appName || 'Schreibwerkstatt',
        inviteUrl: ctx.inviteUrl || '',
        expiresAt: ctx.expiresAt || '',
      };
      const subject = _t(locale, 'mail.subject.registrationApproved', params);
      const intro   = _t(locale, 'mail.body.regApproved.intro', params);
      const cta     = _t(locale, 'mail.body.regApproved.cta', params);
      const expires = _t(locale, 'mail.body.regApproved.expires', params);
      const url = _esc(params.inviteUrl);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p>${_esc(cta)}</p>
<p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>
<p style="color:#666;font-size:0.9em">${_esc(expires)}</p>
</body></html>`;
      const text = `${intro}\n\n${cta}\n${params.inviteUrl}\n\n${expires}\n`;
      return { subject, html, text };
    },
  },

  'registration-denied': {
    subjectKey: 'mail.subject.registrationDenied',
    render(ctx, locale = 'de') {
      const params = {
        appName: ctx.appName || 'Schreibwerkstatt',
        reason:  ctx.reason || '',
      };
      const subject = _t(locale, 'mail.subject.registrationDenied', params);
      const intro   = _t(locale, 'mail.body.regDenied.intro', params);
      const reason  = params.reason ? _t(locale, 'mail.body.regDenied.reason', params) : '';
      const footer  = _t(locale, 'mail.body.regDenied.footer', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
${reason ? `<p style="color:#666">${_esc(reason)}</p>` : ''}
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n` + (reason ? `\n${reason}\n` : '') + `\n${footer}\n`;
      return { subject, html, text };
    },
  },

  'book-shared': {
    subjectKey: 'mail.subject.bookShared',
    render(ctx, locale = 'de') {
      const params = {
        appName:     ctx.appName || 'Schreibwerkstatt',
        inviterName: ctx.inviterName || ctx.invitedBy || '',
        bookName:    ctx.bookName || '',
        role:        ctx.role || 'viewer',
        bookUrl:     ctx.bookUrl || '',
      };
      params.roleLabel = _t(locale, `mail.body.bookShared.role.${params.role}`, params);
      const subject = _t(locale, 'mail.subject.bookShared', params);
      const intro   = _t(locale, 'mail.body.bookShared.intro', params);
      const cta     = _t(locale, 'mail.body.bookShared.cta', params);
      const noUrl   = _t(locale, 'mail.body.bookShared.noUrl', params);
      const footer  = _t(locale, 'mail.body.bookShared.footer', params);
      const url = _esc(params.bookUrl);
      const linkBlock = params.bookUrl
        ? `<p>${_esc(cta)}</p><p><a href="${url}" style="display:inline-block;padding:10px 20px;background:#0070d0;color:#fff;border-radius:4px;text-decoration:none">${url}</a></p>`
        : `<p>${_esc(noUrl)}</p>`;
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
${linkBlock}
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n` +
        (params.bookUrl ? `${cta}\n${params.bookUrl}\n` : `${noUrl}\n`) +
        `\n${footer}\n`;
      return { subject, html, text };
    },
  },

  'job-failed-admin': {
    subjectKey: 'mail.subject.jobFailedAdmin',
    render(ctx, locale = 'de') {
      const params = {
        appName:    ctx.appName    || 'Schreibwerkstatt',
        jobType:    ctx.jobType    || '—',
        jobId:      ctx.jobId      || '—',
        userEmail:  ctx.userEmail  || '—',
        bookId:     ctx.bookId     || '—',
        bookName:   ctx.bookName   || '—',
        errorMsg:   _renderErrorMsg(ctx.errorMsg, ctx.errorParams, locale),
        provider:   ctx.provider   || '—',
        model:      ctx.model      || '—',
        tokensIn:   ctx.tokensIn   || 0,
        tokensOut:  ctx.tokensOut  || 0,
        duration:   ctx.duration   || '—',
      };
      const subject  = _t(locale, 'mail.subject.jobFailedAdmin', params);
      const intro    = _t(locale, 'mail.body.jobFailedAdmin.intro', params);
      const fields   = _t(locale, 'mail.body.jobFailedAdmin.fields', params);
      const userLn   = _t(locale, 'mail.body.jobFailedAdmin.user', params);
      const bookLn   = _t(locale, 'mail.body.jobFailedAdmin.book', params);
      const errorLn  = _t(locale, 'mail.body.jobFailedAdmin.error', params);
      const modelLn  = _t(locale, 'mail.body.jobFailedAdmin.model', params);
      const tokensLn = _t(locale, 'mail.body.jobFailedAdmin.tokens', params);
      const durLn    = _t(locale, 'mail.body.jobFailedAdmin.duration', params);
      const jobIdLn  = _t(locale, 'mail.body.jobFailedAdmin.jobId', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0;font-family:ui-monospace,monospace;font-size:0.9em">
${_esc(fields)}<br>${_esc(userLn)}<br>${_esc(bookLn)}<br>${_esc(modelLn)}<br>${_esc(tokensLn)}<br>${_esc(durLn)}<br>${_esc(jobIdLn)}
</p>
<p style="margin-top:16px;color:#a00"><strong>${_esc(errorLn)}</strong></p>
</body></html>`;
      const text = `${intro}\n\n${fields}\n${userLn}\n${bookLn}\n${modelLn}\n${tokensLn}\n${durLn}\n${jobIdLn}\n\n${errorLn}\n`;
      return { subject, html, text };
    },
  },

  'token-cap-hit-admin': {
    subjectKey: 'mail.subject.tokenCapHitAdmin',
    render(ctx, locale = 'de') {
      const params = {
        appName:    ctx.appName    || 'Schreibwerkstatt',
        jobType:    ctx.jobType    || '—',
        jobId:      ctx.jobId      || '—',
        userEmail:  ctx.userEmail  || '—',
        bookId:     ctx.bookId     || '—',
        bookName:   ctx.bookName   || '—',
        provider:   ctx.provider   || '—',
        model:      ctx.model      || '—',
        maxTokens:  ctx.maxTokens  || '—',
      };
      const subject = _t(locale, 'mail.subject.tokenCapHitAdmin', params);
      const intro   = _t(locale, 'mail.body.tokenCapHitAdmin.intro', params);
      const userLn  = _t(locale, 'mail.body.jobFailedAdmin.user', params);
      const bookLn  = _t(locale, 'mail.body.jobFailedAdmin.book', params);
      const modelLn = _t(locale, 'mail.body.jobFailedAdmin.model', params);
      const jobIdLn = _t(locale, 'mail.body.jobFailedAdmin.jobId', params);
      const hint    = _t(locale, 'mail.body.tokenCapHitAdmin.hint', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0;font-family:ui-monospace,monospace;font-size:0.9em">
${_esc(userLn)}<br>${_esc(bookLn)}<br>${_esc(modelLn)}<br>MODEL_TOKEN: ${_esc(params.maxTokens)}<br>${_esc(jobIdLn)}
</p>
<p style="margin-top:16px;color:#666;font-size:0.9em">${_esc(hint)}</p>
</body></html>`;
      const text = `${intro}\n\n${userLn}\n${bookLn}\n${modelLn}\nMODEL_TOKEN: ${params.maxTokens}\n${jobIdLn}\n\n${hint}\n`;
      return { subject, html, text };
    },
  },

  'budget-overrun-user': {
    subjectKey: 'mail.subject.budgetOverrunUser',
    render(ctx, locale = 'de') {
      const params = {
        appName:   ctx.appName   || 'Schreibwerkstatt',
        userEmail: ctx.userEmail || '',
        period:    ctx.period    || '',
        usd:       ctx.usd       || '0',
        budget:    ctx.budget    || '0',
        mode:      ctx.mode      || 'soft',
      };
      const subject  = _t(locale, 'mail.subject.budgetOverrunUser', params);
      const intro    = _t(locale, 'mail.body.budgetOverrun.userIntro', params);
      const usage    = _t(locale, 'mail.body.budgetOverrun.usage', params);
      const modeLine = _t(locale, params.mode === 'hard' ? 'mail.body.budgetOverrun.modeHard' : 'mail.body.budgetOverrun.modeSoft', params);
      const footer   = _t(locale, 'mail.body.budgetOverrun.footer', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0">${_esc(usage)}</p>
<p style="margin-top:12px;color:#666">${_esc(modeLine)}</p>
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n${usage}\n${modeLine}\n\n${footer}\n`;
      return { subject, html, text };
    },
  },

  'budget-overrun-admin': {
    subjectKey: 'mail.subject.budgetOverrunAdmin',
    render(ctx, locale = 'de') {
      const params = {
        appName:   ctx.appName   || 'Schreibwerkstatt',
        userEmail: ctx.userEmail || '',
        period:    ctx.period    || '',
        usd:       ctx.usd       || '0',
        budget:    ctx.budget    || '0',
        mode:      ctx.mode      || 'soft',
      };
      const subject  = _t(locale, 'mail.subject.budgetOverrunAdmin', params);
      const intro    = _t(locale, 'mail.body.budgetOverrun.intro', params);
      const usage    = _t(locale, 'mail.body.budgetOverrun.usage', params);
      const modeLine = _t(locale, params.mode === 'hard' ? 'mail.body.budgetOverrun.modeHard' : 'mail.body.budgetOverrun.modeSoft', params);
      const footer   = _t(locale, 'mail.body.budgetOverrun.footer', params);
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
<p>${_esc(intro)}</p>
<p style="margin:0">${_esc(usage)}</p>
<p style="margin-top:12px;color:#666">${_esc(modeLine)}</p>
<hr style="border:0;border-top:1px solid #eee;margin:24px 0">
<p style="color:#999;font-size:0.85em">${_esc(footer)}</p>
</body></html>`;
      const text = `${intro}\n\n${usage}\n${modeLine}\n\n${footer}\n`;
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
