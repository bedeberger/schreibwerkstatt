// Phase 4c1 (BookStack-Exit): Setup-Wizard. Standalone, kein Alpine, kein
// Service-Worker-Pfad. Liest /setup/state, schreibt Schritte einzeln.

(() => {
  const STEPS = [
    { id: 'welcome',    key: 'welcome',    label: 'setup.stepper.welcome' },
    { id: 'public-url', key: 'publicUrl',  label: 'setup.stepper.publicUrl' },
    { id: 'oauth',      key: 'oauth',      label: 'setup.stepper.oauth' },
    { id: 'ai',         key: 'ai',         label: 'setup.stepper.ai' },
    { id: 'backend',    key: 'backend',    label: 'setup.stepper.backend' },
    { id: 'smtp',       key: 'smtp',       label: 'setup.stepper.smtp' },
    { id: 'done',       key: 'done',       label: 'setup.stepper.done' },
  ];

  const I18N = {
    de: {
      'setup.title': 'Setup',
      'setup.subtitle': 'Erstkonfiguration der Schreibwerkstatt-Instanz.',
      'setup.welcome.title': 'Willkommen',
      'setup.welcome.adminEmailHint': 'Diese Email ist als Admin in .env konfiguriert:',
      'setup.welcome.googleLogin': 'Sobald OAuth eingerichtet ist, kannst du dich auch per Google mit derselben Adresse anmelden.',
      'setup.step.publicUrl.title': 'Öffentliche URL',
      'setup.step.publicUrl.description': 'Wird für OAuth-Callback, Invite-Mails und Share-Links verwendet. Ohne Slash am Ende.',
      'setup.step.oauth.title': 'Google-OAuth (optional)',
      'setup.step.oauth.description': 'Trage Client-ID und Client-Secret aus der Google-Cloud-Console ein. Redirect-URI bei Google:',
      'setup.step.ai.title': 'KI-Provider',
      'setup.step.ai.description': 'Mindestens ein Provider muss konfiguriert sein, sonst sind KI-Features deaktiviert.',
      'setup.step.backend.title': 'Storage-Backend',
      'setup.step.backend.description': 'Lokal (eingebettete SQLite) oder bestehende BookStack-Instanz.',
      'setup.step.smtp.title': 'SMTP / Mailer (optional)',
      'setup.step.smtp.description': 'Versendet Invites und Approval-Benachrichtigungen. Ohne Mailer fallen Invites auf In-App-Token-Anzeige zurück.',
      'setup.step.done.title': 'Setup abgeschlossen',
      'setup.step.done.description': 'Du kannst jederzeit über die Admin-Konsole zurückkehren oder den Wizard erneut durchgehen.',
      'setup.stepper.welcome': 'Start',
      'setup.stepper.publicUrl': 'URL',
      'setup.stepper.oauth': 'OAuth',
      'setup.stepper.ai': 'KI',
      'setup.stepper.backend': 'Storage',
      'setup.stepper.smtp': 'Mailer',
      'setup.stepper.done': 'Fertig',
      'setup.field.publicUrl': 'Öffentliche URL',
      'setup.field.provider': 'Provider',
      'setup.field.backend': 'Backend',
      'setup.field.smtpMode': 'Mode',
      'setup.field.fromEmail': 'From-Email',
      'setup.field.fromName': 'From-Name',
      'setup.field.smtpSecure': 'TLS (SSL)',
      'setup.field.maskedHint': 'Gespeichert — leer lassen für unverändert.',
      'setup.smtp.mode.disabled': 'Deaktiviert',
      'setup.smtp.mode.gmailOauth': 'Gmail (OAuth2)',
      'setup.smtp.mode.gmailAppPassword': 'Gmail (App-Passwort)',
      'setup.smtp.mode.generic': 'Generic SMTP',
      'setup.smtp.hint.gmailOauth': 'OAuth-Client in der Google-Cloud-Console anlegen (Web application), Scope https://mail.google.com/, Refresh-Token via OAuth-Playground holen.',
      'setup.smtp.hint.gmailAppPassword': '2FA muss aktiv sein. App-Passwort unter myaccount.google.com/apppasswords erzeugen.',
      'setup.button.start': "Los geht's",
      'setup.button.back': 'Zurück',
      'setup.button.save': 'Speichern',
      'setup.button.skip': 'Überspringen',
      'setup.button.test': 'Testen',
      'setup.button.testMail': 'Test-Mail senden',
      'setup.button.finish': 'Zur App',
      'setup.test.ok': 'OK',
      'setup.test.fail': 'Fehler',
      'setup.test.busy': 'Läuft…',
      'setup.error.required': 'Pflichtfeld.',
      'setup.error.invalidUrl': 'Ungültige URL.',
      'setup.error.saveFailed': 'Speichern fehlgeschlagen.',
      'setup.footer.logout': 'Abmelden',
    },
    en: {
      'setup.title': 'Setup',
      'setup.subtitle': 'Initial configuration for this Schreibwerkstatt instance.',
      'setup.welcome.title': 'Welcome',
      'setup.welcome.adminEmailHint': 'This address is configured as admin via .env:',
      'setup.welcome.googleLogin': 'Once OAuth is set up you can also sign in with Google using the same address.',
      'setup.step.publicUrl.title': 'Public URL',
      'setup.step.publicUrl.description': 'Used for OAuth callback, invite mails and share links. No trailing slash.',
      'setup.step.oauth.title': 'Google OAuth (optional)',
      'setup.step.oauth.description': 'Enter client ID and secret from Google Cloud Console. Redirect URI to register at Google:',
      'setup.step.ai.title': 'AI provider',
      'setup.step.ai.description': 'At least one provider must be configured, otherwise AI features stay disabled.',
      'setup.step.backend.title': 'Storage backend',
      'setup.step.backend.description': 'Local (embedded SQLite) or an existing BookStack instance.',
      'setup.step.smtp.title': 'SMTP / Mailer (optional)',
      'setup.step.smtp.description': 'Sends invites and approval notifications. Without a mailer, invite tokens are shown in-app instead.',
      'setup.step.done.title': 'Setup complete',
      'setup.step.done.description': 'You can revisit any step from the admin console at any time.',
      'setup.stepper.welcome': 'Start',
      'setup.stepper.publicUrl': 'URL',
      'setup.stepper.oauth': 'OAuth',
      'setup.stepper.ai': 'AI',
      'setup.stepper.backend': 'Storage',
      'setup.stepper.smtp': 'Mailer',
      'setup.stepper.done': 'Done',
      'setup.field.publicUrl': 'Public URL',
      'setup.field.provider': 'Provider',
      'setup.field.backend': 'Backend',
      'setup.field.smtpMode': 'Mode',
      'setup.field.fromEmail': 'From email',
      'setup.field.fromName': 'From name',
      'setup.field.smtpSecure': 'TLS (SSL)',
      'setup.field.maskedHint': 'Stored — leave empty to keep unchanged.',
      'setup.smtp.mode.disabled': 'Disabled',
      'setup.smtp.mode.gmailOauth': 'Gmail (OAuth2)',
      'setup.smtp.mode.gmailAppPassword': 'Gmail (app password)',
      'setup.smtp.mode.generic': 'Generic SMTP',
      'setup.smtp.hint.gmailOauth': 'Create OAuth client in Google Cloud Console (web application), scope https://mail.google.com/, fetch refresh token via OAuth Playground.',
      'setup.smtp.hint.gmailAppPassword': '2FA must be enabled. Create the app password at myaccount.google.com/apppasswords.',
      'setup.button.start': "Let's go",
      'setup.button.back': 'Back',
      'setup.button.save': 'Save',
      'setup.button.skip': 'Skip',
      'setup.button.test': 'Test',
      'setup.button.testMail': 'Send test mail',
      'setup.button.finish': 'Open the app',
      'setup.test.ok': 'OK',
      'setup.test.fail': 'Failed',
      'setup.test.busy': 'Running…',
      'setup.error.required': 'Required field.',
      'setup.error.invalidUrl': 'Invalid URL.',
      'setup.error.saveFailed': 'Save failed.',
      'setup.footer.logout': 'Sign out',
    },
  };

  const locale = (navigator.language || 'de').toLowerCase().startsWith('en') ? 'en' : 'de';
  const t = (key) => I18N[locale][key] || I18N.de[key] || key;

  let stateData = null;
  let stepIdx = 0;

  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function applyI18n() {
    document.documentElement.lang = locale;
    $$('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      const v = t(k);
      if (v) el.textContent = v;
    });
    document.title = `${t('setup.title')} — Schreibwerkstatt`;
  }

  function renderStepper() {
    const ol = $('#stepper');
    while (ol.firstChild) ol.removeChild(ol.firstChild);
    STEPS.forEach((s, i) => {
      const li = document.createElement('li');
      li.textContent = t(s.label);
      if (i === stepIdx) li.classList.add('is-active');
      else if (isStepDone(s.key)) li.classList.add('is-done');
      li.addEventListener('click', () => showStep(i));
      ol.appendChild(li);
    });
  }

  function isStepDone(key) {
    const steps = stateData?.steps || {};
    if (key === 'welcome') return true;
    if (key === 'done') return !!stateData?.setup_completed;
    return !!steps[key];
  }

  function showStep(i) {
    if (i < 0 || i >= STEPS.length) return;
    stepIdx = i;
    STEPS.forEach((s, j) => {
      const el = document.getElementById(`step-${s.id}`);
      if (el) el.hidden = j !== i;
    });
    renderStepper();
    const active = document.getElementById(`step-${STEPS[i].id}`);
    if (active) {
      const first = active.querySelector('input, select');
      if (first) setTimeout(() => first.focus(), 50);
    }
  }

  function showError(stepId, msg) {
    const el = document.getElementById(`err-${stepId}`);
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-visible', !!msg);
  }

  function setTestResult(kind, payload) {
    const el = document.getElementById(`test-${kind}`);
    if (!el) return;
    el.classList.remove('ok', 'fail', 'busy');
    if (payload?.busy) {
      el.classList.add('busy');
      el.textContent = t('setup.test.busy');
      return;
    }
    if (payload?.ok) {
      el.classList.add('ok');
      el.textContent = `${t('setup.test.ok')}${payload.latency_ms ? ` · ${payload.latency_ms} ms` : ''}`;
    } else {
      el.classList.add('fail');
      el.textContent = `${t('setup.test.fail')}${payload?.error ? ` · ${payload.error}` : payload?.status ? ` · HTTP ${payload.status}` : ''}`;
    }
  }

  async function loadState() {
    const r = await fetch('/setup/state', { credentials: 'same-origin' });
    if (!r.ok) {
      if (r.status === 401) { window.location.href = '/login?returnTo=/setup'; return; }
      throw new Error(`state HTTP ${r.status}`);
    }
    stateData = await r.json();
    populate();
  }

  function populate() {
    const v = stateData.values;
    const m = stateData.masked;
    $('#admin-email').textContent = stateData.admin_email || '—';

    $('#publicUrl').value = v.publicUrl || '';
    $('#oauth-redirect').textContent = (v.publicUrl ? v.publicUrl.replace(/\/$/, '') : '${app.public_url}') + '/auth/callback';
    $('#mask-google-id').hidden = !m.googleClientId;
    $('#mask-google-secret').hidden = !m.googleClientSecret;
    $('#aiProvider').value = v.provider || 'claude';
    $('#claudeModel').value = v.claudeModel || '';
    $('#ollamaHost').value = v.ollamaHost || '';
    $('#ollamaModel').value = v.ollamaModel || '';
    $('#llamaHost').value = v.llamaHost || '';
    $('#llamaModel').value = v.llamaModel || '';
    $('#mask-claude-key').hidden = !m.claudeApiKey;
    refreshProviderVisibility();
    $('#backend').value = v.backend || 'localdb';
    $('#bookstackUrl').value = v.bookstackUrl || '';
    $('#mask-bs-id').hidden = !m.bookstackTokenId;
    $('#mask-bs-secret').hidden = !m.bookstackTokenSecret;
    refreshBackendVisibility();
    $('#smtpMode').value = v.smtpMode || 'disabled';
    $('#smtpFromEmail').value = v.smtpFromEmail || '';
    $('#smtpFromName').value = v.smtpFromName || '';
    $('#smtpGmailUser').value = v.smtpGmailUser || '';
    $('#smtpGmailUser2').value = v.smtpGmailUser || '';
    $('#smtpHost').value = v.smtpHost || '';
    $('#smtpPort').value = v.smtpPort || 587;
    $('#smtpSecure').checked = !!v.smtpSecure;
    $('#smtpUser').value = v.smtpUser || '';
    $('#mask-gmail-id').hidden = !m.gmailClientId;
    $('#mask-gmail-secret').hidden = !m.gmailClientSecret;
    $('#mask-gmail-refresh').hidden = !m.gmailRefreshToken;
    $('#mask-gmail-app-password').hidden = !m.gmailAppPassword;
    $('#mask-smtp-password').hidden = !m.smtpPassword;
    refreshSmtpVisibility();
  }

  function refreshProviderVisibility() {
    const p = $('#aiProvider').value;
    $$('.setup-subgroup[data-provider]').forEach(g => {
      g.hidden = g.dataset.provider !== p;
    });
  }

  function refreshBackendVisibility() {
    const b = $('#backend').value;
    $$('.setup-subgroup[data-backend]').forEach(g => {
      g.hidden = g.dataset.backend !== b;
    });
  }

  function refreshSmtpVisibility() {
    const mode = $('#smtpMode').value;
    $$('.setup-subgroup[data-smtp]').forEach(g => {
      g.hidden = g.dataset.smtp !== mode;
    });
    $$('[data-smtp-shared]').forEach(el => {
      el.hidden = mode === 'disabled';
    });
    const testRow = $('[data-smtp-test]');
    if (testRow) testRow.hidden = mode === 'disabled';
  }

  async function postStep(step, body) {
    const r = await fetch(`/setup/${step}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_code || `HTTP ${r.status}`);
    }
    return r.json();
  }

  async function runTest(kind, body) {
    setTestResult(kind, { busy: true });
    const r = await fetch(`/setup/test/${kind}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    setTestResult(kind, j);
  }

  async function saveStep(step) {
    showError(step, '');
    try {
      if (step === 'public-url') {
        const url = $('#publicUrl').value.trim();
        if (!url) { showError('public-url', t('setup.error.required')); return false; }
        try { new URL(url); } catch { showError('public-url', t('setup.error.invalidUrl')); return false; }
        await postStep('public-url', { publicUrl: url });
      } else if (step === 'oauth') {
        await postStep('oauth', {
          clientId: $('#googleClientId').value,
          clientSecret: $('#googleClientSecret').value,
        });
      } else if (step === 'ai') {
        const provider = $('#aiProvider').value;
        const body = { provider };
        if (provider === 'claude') {
          body.claudeApiKey = $('#claudeApiKey').value;
          body.claudeModel = $('#claudeModel').value;
        } else if (provider === 'ollama') {
          body.ollamaHost = $('#ollamaHost').value;
          body.ollamaModel = $('#ollamaModel').value;
        } else if (provider === 'llama') {
          body.llamaHost = $('#llamaHost').value;
          body.llamaModel = $('#llamaModel').value;
        }
        await postStep('ai', body);
      } else if (step === 'backend') {
        const backend = $('#backend').value;
        const body = { backend };
        if (backend === 'bookstack') {
          body.bookstackUrl = $('#bookstackUrl').value;
          body.bookstackTokenId = $('#bookstackTokenId').value;
          body.bookstackTokenSecret = $('#bookstackTokenSecret').value;
        }
        await postStep('backend', body);
      } else if (step === 'smtp') {
        const mode = $('#smtpMode').value;
        const body = {
          mode,
          fromEmail: $('#smtpFromEmail').value,
          fromName: $('#smtpFromName').value,
        };
        if (mode === 'gmail-oauth') {
          body.gmailUser = $('#smtpGmailUser').value;
          body.gmailClientId = $('#smtpGmailClientId').value;
          body.gmailClientSecret = $('#smtpGmailClientSecret').value;
          body.gmailRefreshToken = $('#smtpGmailRefreshToken').value;
        } else if (mode === 'gmail-app-password') {
          body.gmailUser = $('#smtpGmailUser2').value;
          body.gmailAppPassword = $('#smtpGmailAppPassword').value;
        } else if (mode === 'generic') {
          body.host = $('#smtpHost').value;
          body.port = $('#smtpPort').value;
          body.secure = $('#smtpSecure').checked;
          body.user = $('#smtpUser').value;
          body.password = $('#smtpPassword').value;
        }
        await postStep('smtp', body);
      }
      await loadState();
      return true;
    } catch (e) {
      showError(step, `${t('setup.error.saveFailed')} ${e.message}`);
      return false;
    }
  }

  function bindActions() {
    $$('[data-next]').forEach(b => b.addEventListener('click', () => showStep(stepIdx + 1)));
    $$('[data-back]').forEach(b => b.addEventListener('click', () => showStep(stepIdx - 1)));
    $$('[data-skip]').forEach(b => b.addEventListener('click', () => showStep(stepIdx + 1)));
    $$('[data-save]').forEach(b => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        const ok = await saveStep(b.dataset.save);
        b.disabled = false;
        if (ok) showStep(stepIdx + 1);
      });
    });
    $$('[data-test]').forEach(b => {
      b.addEventListener('click', () => runTest(b.dataset.test));
    });
    $('#aiProvider').addEventListener('change', refreshProviderVisibility);
    $('#backend').addEventListener('change', refreshBackendVisibility);
    $('#smtpMode').addEventListener('change', refreshSmtpVisibility);

    $('#finish-btn').addEventListener('click', async () => {
      try {
        await fetch('/setup/complete', { method: 'POST', credentials: 'same-origin' });
      } catch (_) {}
      window.location.href = '/';
    });
  }

  function showFatal(msg) {
    const shell = document.querySelector('.setup-shell');
    while (shell && shell.firstChild) shell.removeChild(shell.firstChild);
    const err = document.createElement('p');
    err.className = 'setup-error is-visible';
    err.textContent = msg;
    if (shell) shell.appendChild(err);
  }

  async function init() {
    applyI18n();
    bindActions();
    try {
      await loadState();
    } catch (e) {
      showFatal(e.message);
      return;
    }
    const firstIncomplete = STEPS.findIndex(s => !isStepDone(s.key) && s.key !== 'welcome' && s.key !== 'done');
    showStep(firstIncomplete >= 0 ? firstIncomplete : 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
