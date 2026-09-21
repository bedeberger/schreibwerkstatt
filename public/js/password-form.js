// Handler der beiden Passwort-Selbstbedienungs-Formen der lokalen Anmeldung:
// „Passwort setzen" (/auth/password) und „Passwort vergessen" (/auth/forgot).
//
// Eigene Datei statt inline, weil CSP `script-src 'self'` ohne 'unsafe-inline'
// Inline-Scripts blockiert. Beide Formen laufen vor dem SPA-Boot, also ohne
// i18n-Bundle — die Texte reisen als `data-msg-*` im Markup mit
// (routes/auth/providers/local.js).
//
// Ein Handler fuer beide: sie unterscheiden sich nur darin, ob die Antwort
// weiterleitet (Setzen) oder eine Bestaetigung stehen laesst (Vergessen).
(function () {
  const forms = document.querySelectorAll('form[data-password-endpoint]');
  if (!forms.length) return;

  const safe = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : null);

  forms.forEach((form) => {
    const endpoint = form.dataset.passwordEndpoint;
    const msgInvalid  = form.dataset.msgInvalid  || 'Something went wrong. Please try again.';
    const msgMismatch = form.dataset.msgMismatch || 'The two passwords do not match.';
    const msgExpired  = form.dataset.msgExpired  || 'This link is no longer valid.';
    const msgWeak     = form.dataset.msgWeak     || 'This password is too short.';
    const msgSent     = form.dataset.msgSent     || '';

    const errEl = form.querySelector('[data-login-err]');
    const msgEl = form.querySelector('[data-login-msg]');
    const show = (el, text) => {
      if (!el) return;
      el.textContent = text;
      el.hidden = false;
    };
    const clear = () => {
      if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      if (msgEl) { msgEl.hidden = true; msgEl.textContent = ''; }
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear();
      const field = (name) => form.querySelector(`input[name="${name}"]`)?.value ?? '';
      const password = field('password');
      const password2 = field('password2');
      // Die Wiederholung wird nur hier geprueft — sie ist eine Tippfehler-Bremse
      // fuer den Nutzer, keine Sicherheitseigenschaft, und hat darum am Server
      // nichts zu suchen.
      if (form.querySelector('input[name="password2"]') && password !== password2) {
        show(errEl, msgMismatch);
        return;
      }
      const body = {
        email: field('email').trim(),
        password,
        displayName: field('displayName').trim(),
        invite: field('invite'),
        token: field('token'),
        altcha: new FormData(form).get('altcha') || null,
      };
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const target = safe(j.redirect);
          if (target) {
            window.location.href = target;
            return;
          }
          // Kein Ziel: die Anfrage ist angekommen (Reset-Link). Die Antwort ist
          // absichtlich immer dieselbe, auch bei unbekannter Adresse.
          form.reset();
          show(msgEl, msgSent || msgInvalid);
          return;
        }
        if (j.error_code === 'PASSWORD_WEAK') show(errEl, msgWeak);
        else if (j.error_code === 'TOKEN_INVALID') show(errEl, msgExpired);
        else if (r.status === 429) show(errEl, msgExpired);
        else show(errEl, msgInvalid);
        try { form.querySelector('altcha-widget')?.reset?.(); } catch {}
      } catch (ex) {
        show(errEl, ex.message);
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  });
})();
