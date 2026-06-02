// Admin-Login-Form-Handler. Eigene Datei statt inline, weil CSP `script-src 'self'`
// ohne `'unsafe-inline'` Inline-Scripts blockiert. Strings + returnTo per data-*.
(function () {
  const form = document.getElementById('admin-form');
  if (!form) return;
  const returnTo = form.dataset.returnto || '/';
  const msgInvalid = form.dataset.msgInvalid || 'Invalid credentials.';
  const msgRateTpl = form.dataset.msgRateTpl || 'Too many attempts. Retry in {sec}s.';
  const msgCaptcha = form.dataset.msgCaptcha || 'Verification failed. Please retry.';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.hidden = true;
    err.textContent = '';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    // ALTCHA-Loesung (form-assoziiertes Widget). Feld fehlt, wenn ALTCHA aus ist.
    const altcha = new FormData(form).get('altcha') || null;
    try {
      const r = await fetch('/auth/admin-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, altcha }),
      });
      if (r.ok) {
        window.location.href = returnTo;
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        const sec = j.retryAfter || 900;
        err.textContent = msgRateTpl.replace('{sec}', sec);
      } else if (r.status === 400 && j.error_code === 'CAPTCHA_FAILED') {
        err.textContent = msgCaptcha;
        try { document.querySelector('#admin-form altcha-widget')?.reset?.(); } catch {}
      } else {
        err.textContent = msgInvalid;
      }
      err.hidden = false;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
})();
