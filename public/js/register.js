(function () {
  const cfgEl = document.getElementById('register-config');
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent || '{}');
  const siteKey = cfg.captchaSiteKey || '';
  const I18N = cfg.i18n || {};

  if (siteKey) {
    const slot = document.getElementById('captcha-slot');
    if (slot) slot.hidden = false;
    const s = document.createElement('script');
    s.src = 'https://js.hcaptcha.com/1/api.js';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }

  const form = document.getElementById('register-form');
  const msg = document.getElementById('register-msg');
  if (!form || !msg) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.hidden = true;
    msg.className = 'public-msg';

    const data = new FormData(form);
    let captchaToken = null;
    if (siteKey && typeof hcaptcha !== 'undefined') {
      try { captchaToken = hcaptcha.getResponse(); } catch {}
    }
    const payload = {
      email: (data.get('email') || '').trim(),
      displayName: (data.get('displayName') || '').trim() || null,
      message: (data.get('message') || '').trim() || null,
      captchaToken,
    };

    try {
      const r = await fetch('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 202) {
        form.reset();
        msg.textContent = I18N.success || '';
        msg.className = 'public-msg public-msg--ok';
        msg.hidden = false;
        return;
      }
      let j = {};
      try { j = await r.json(); } catch {}
      if (r.status === 429) {
        msg.textContent = I18N.rateLimit || '';
      } else if (r.status === 400) {
        msg.textContent = j.error_code === 'EMAIL_INVALID' ? (I18N.invalid || '') : (I18N.error || '');
      } else {
        msg.textContent = I18N.error || '';
      }
      msg.className = 'public-msg public-msg--err';
      msg.hidden = false;
    } catch {
      msg.textContent = I18N.error || '';
      msg.className = 'public-msg public-msg--err';
      msg.hidden = false;
    }
  });
}());
