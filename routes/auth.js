const crypto = require('crypto');
const express = require('express');
const { Issuer, generators } = require('openid-client');
const logger = require('../logger');
const { getUserToken, setUserToken, upsertUserLogin, getTokenForRequest } = require('../db/schema');
const { maybeAutoBackfillOnLogin } = require('./jobs/backfill');
const appUsers = require('../db/app-users');
const rateLimit = require('../lib/admin-login-ratelimit');
const appSettings = require('../lib/app-settings');

const router = express.Router();

// Öffentliche Basis-URL: SSoT ist app_settings (`app.public_url`). Im
// LOCAL_DEV_MODE fällt der Default auf den lokalen Dev-Port — sonst muss der
// Admin den Wert in der Settings-UI gesetzt haben, damit OIDC-Callback +
// Invite-Mails funktionieren.
function getPublicUrl() {
  const fromDb = appSettings.get('app.public_url');
  if (fromDb) return String(fromDb).replace(/\/$/, '');
  if (process.env.LOCAL_DEV_MODE === 'true') {
    return `http://localhost:${process.env.PORT || 3737}`;
  }
  return '';
}

// OIDC-Client wird einmalig initialisiert und gecacht. Bei Änderung relevanter
// app_settings-Keys (public_url, google.client_id/secret) verworfen, damit die
// neue Konfiguration beim nächsten Login greift — ohne Server-Restart.
let oidcClient = null;
appSettings.on('changed', ({ key }) => {
  if (key === 'app.public_url' || key === 'auth.google.client_id' || key === 'auth.google.client_secret') {
    oidcClient = null;
  }
});

async function getClient() {
  if (oidcClient) return oidcClient;
  const googleIssuer = await Issuer.discover('https://accounts.google.com');
  const appUrl = getPublicUrl();
  if (!appUrl) throw new Error('app.public_url ist nicht gesetzt — Admin muss die öffentliche URL in den App-Einstellungen hinterlegen.');
  oidcClient = new googleIssuer.Client({
    client_id: appSettings.get('auth.google.client_id') || process.env.GOOGLE_CLIENT_ID,
    client_secret: appSettings.get('auth.google.client_secret') || process.env.GOOGLE_CLIENT_SECRET,
    redirect_uris: [`${appUrl}/auth/callback`],
    response_types: ['code'],
  });
  return oidcClient;
}

// Maximal parallele offene Login-Flows pro Session (ältere werden verworfen)
const MAX_PENDING_FLOWS = 5;

function _clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || null;
}

// Konstant-zeit-Vergleich gleichgrosser Buffer. ENV-Passwort + User-Input
// auf SHA-256 normalisieren, damit Buffer-Laenge identisch ist.
function _passwordsMatch(expected, given) {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(given)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Phase 4a Status-Gates: 'suspended' / 'deleted' → 403, audit + denied-Render.
function _renderDenied(res, lang, reasonKey) {
  res.status(403);
  const t = lang === 'en'
    ? { title: 'Access denied', body: { suspended: 'Your account is suspended.', deleted: 'Your account has been deleted.', notInvited: 'No access. Ask your administrator for an invite.' }, cta: 'Use another account' }
    : { title: 'Zugriff verweigert', body: { suspended: 'Dein Konto ist gesperrt.', deleted: 'Dein Konto wurde gelöscht.', notInvited: 'Kein Zugang. Bitte Admin um eine Einladung.' }, cta: 'Anderes Konto verwenden' };
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${t.title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><h1>${t.title}</h1><p>${t.body[reasonKey] || t.body.notInvited}</p>
<p><a href="/auth/logout">${t.cta}</a></p></body></html>`);
}

function _bodyLang(req) {
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  return accept.startsWith('en') ? 'en' : 'de';
}

// GET /auth/login → redirect zu Google (oder direkt zu / im LOCAL_DEV_MODE)
router.get('/auth/login', async (req, res) => {
  if (process.env.LOCAL_DEV_MODE === 'true') {
    return res.redirect('/');
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send(
      'Google OAuth nicht konfiguriert. Bitte GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET in der .env setzen.'
    );
  }
  try {
    const client = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    const rawReturn = req.query.returnTo || '/';
    const returnTo = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';
    // Mehrere parallele Login-Flows (z.B. mehrere Tabs) nebeneinander erlauben:
    // State → { nonce, returnTo } ablegen, im Callback gezielt nachschlagen.
    const pending = Array.isArray(req.session.oidcPending) ? req.session.oidcPending : [];
    pending.push({ state, nonce, returnTo, ts: Date.now() });
    while (pending.length > MAX_PENDING_FLOWS) pending.shift();
    req.session.oidcPending = pending;
    const url = client.authorizationUrl({ scope: 'openid email profile', state, nonce });
    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error('Session save error: ' + saveErr.message);
        return res.status(500).send('Session-Fehler: ' + saveErr.message);
      }
      res.redirect(url);
    });
  } catch (err) {
    logger.error('Auth login error: ' + err.message);
    res.status(500).send('Anmeldung fehlgeschlagen: ' + err.message);
  }
});

// GET /auth/callback → Token validieren, Session anlegen
router.get('/auth/callback', async (req, res) => {
  try {
    const client = await getClient();
    const appUrl = getPublicUrl();
    const params = client.callbackParams(req);
    // Passenden pending-Flow suchen (Mehrtab-Support). `oidcPending` ist seit
    // Multi-Tab-Refactor die einzige Quelle; ältere `oidcState`/`oidcNonce`-
    // Felder werden nirgends mehr geschrieben.
    const pending = Array.isArray(req.session.oidcPending) ? req.session.oidcPending : [];
    const flowIdx = pending.findIndex(f => f.state === params.state);
    const flow = flowIdx >= 0 ? pending[flowIdx] : null;
    if (!flow) {
      logger.warn(`Auth callback: kein passender Login-Flow für state=${params.state}`);
      return res.status(400).send(
        'Anmeldung abgelaufen oder ungültig. <a href="/auth/login">Erneut anmelden</a>'
      );
    }
    const tokenSet = await client.callback(
      `${appUrl}/auth/callback`,
      params,
      { state: flow.state, nonce: flow.nonce }
    );
    const claims = tokenSet.claims();
    const email = (claims.email || '').toLowerCase();
    const ip = _clientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const lang = _bodyLang(req);

    // Optionale E-Mail-Whitelist (ALLOWED_EMAILS=a@b.com,c@d.com)
    const allowed = process.env.ALLOWED_EMAILS;
    if (allowed) {
      const list = allowed.split(',').map(e => e.trim().toLowerCase());
      if (!list.includes(email)) {
        logger.warn('Login verweigert (nicht in ALLOWED_EMAILS).', { user: email });
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: 'not-in-allowed-emails' } });
        return _renderDenied(res, lang, 'notInvited');
      }
    }

    // Phase 4a: app_users-Lookup + Status-Gate + Invite-Accept-Flow.
    let user = appUsers.getUser(email);
    if (user) {
      if (user.status === 'suspended') {
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: 'suspended' } });
        return _renderDenied(res, lang, 'suspended');
      }
      if (user.status === 'deleted') {
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: 'deleted' } });
        return _renderDenied(res, lang, 'deleted');
      }
    } else {
      // Kein Eintrag in app_users: pruefen, ob ein gueltiger Invite-Token
      // im returnTo verlinkt ist, oder ALLOW_OPEN_SIGNUP greift.
      const inviteToken = (() => {
        try { return new URL(flow.returnTo || '', 'http://x').searchParams.get('invite'); }
        catch { return null; }
      })();
      let acceptedInvite = null;
      if (inviteToken) {
        const inv = appUsers.findInviteByToken(inviteToken);
        if (inv && inv.email === email && appUsers.inviteStatus(inv) === 'active') {
          acceptedInvite = inv;
        }
      }
      if (acceptedInvite) {
        user = appUsers.createUser({
          email,
          displayName: claims.name || email,
          globalRole: acceptedInvite.global_role,
          status: 'active',
          invitedBy: acceptedInvite.invited_by,
        });
        appUsers.acceptInvite(acceptedInvite.id);
      } else if (process.env.ALLOW_OPEN_SIGNUP === 'true') {
        user = appUsers.createUser({
          email,
          displayName: claims.name || email,
          globalRole: 'user',
          status: 'active',
        });
      } else {
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: 'not-invited' } });
        logger.warn('Login verweigert (kein Invite, ALLOW_OPEN_SIGNUP=false).', { user: email });
        return _renderDenied(res, lang, 'notInvited');
      }
    }

    const returnTo = (flow.returnTo && flow.returnTo.startsWith('/') && !flow.returnTo.startsWith('//')) ? flow.returnTo : '/';
    // Verbrauchten Flow entfernen; übrige parallele Flows nicht antasten.
    if (flowIdx >= 0) {
      pending.splice(flowIdx, 1);
      req.session.oidcPending = pending;
    }
    delete req.session.oidcState;
    delete req.session.oidcNonce;
    delete req.session.returnTo;
    req.session.user = {
      email,
      name: claims.name || user.display_name || email,
      picture: claims.picture || null,
      role: user.global_role,
    };
    req.session.loginAt = Date.now();
    req.session.lastSeen = Date.now();
    upsertUserLogin(email, claims.name || email);
    appUsers.touchLogin(email, claims.name || null);
    appUsers.recordAuditEvent(email, 'login', { ip, userAgent, meta: { method: 'oidc' } });
    // Gespeicherten BookStack-Token in Session laden (falls vorhanden)
    const stored = getUserToken(email);
    if (stored) req.session.bookstackToken = { id: stored.token_id, pw: stored.token_pw };
    logger.info(`Login${stored ? ' (Token geladen)' : ' (kein Token hinterlegt)'}`, { user: email });
    // Phase 0b Auto-Trigger: leere DB → Backfill anstossen.
    if (stored) maybeAutoBackfillOnLogin(email, req.session.bookstackToken);
    res.redirect(returnTo);
  } catch (err) {
    logger.error('Auth callback error: ' + err.message);
    res.status(500).send('Anmeldung fehlgeschlagen: ' + err.message);
  }
});

// GET /login → Landing-Page mit Google-Button + optionaler Admin-Form.
// Auth-Guard redirected unauth User hierhin (statt direkt zu Google),
// damit Admin-Pfad sichtbar ist. Wenn ADMIN_PASSWORD-ENV leer ist, wird
// die Admin-Form ausgeblendet (Plan-Pfad B deaktiviert).
router.get('/login', (req, res) => {
  if (process.env.LOCAL_DEV_MODE === 'true') return res.redirect('/');
  if (req.session?.user) return res.redirect(req.query.returnTo || '/');
  const lang = _bodyLang(req);
  const hasGoogle = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const hasAdminPw = !!process.env.ADMIN_PASSWORD;
  const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/') && !req.query.returnTo.startsWith('//')
    ? req.query.returnTo : '/';
  const t = lang === 'en'
    ? { title: 'Sign in', google: 'Sign in with Google', adminTitle: 'Admin login', email: 'Admin email', password: 'Password', submit: 'Sign in as admin', or: 'or', noAdmin: 'Admin login disabled.' }
    : { title: 'Anmeldung', google: 'Mit Google anmelden', adminTitle: 'Admin-Login', email: 'Admin-E-Mail', password: 'Passwort', submit: 'Als Admin anmelden', or: 'oder', noAdmin: 'Admin-Login deaktiviert.' };
  res.set('Cache-Control', 'no-store');
  res.send(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${t.title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
  h1{font-size:1.5em;margin-bottom:24px}
  .btn-google{display:inline-block;padding:10px 16px;background:#fff;border:1px solid #ccc;border-radius:4px;text-decoration:none;color:#1a1a1a;font-size:1em}
  .btn-google:hover{background:#f0f0f0}
  fieldset{border:1px solid #ddd;border-radius:4px;padding:16px;margin-top:24px}
  legend{padding:0 8px;color:#666;font-size:0.9em}
  label{display:block;margin-top:8px;font-size:0.9em;color:#555}
  input[type=email],input[type=password]{width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;font-size:1em;box-sizing:border-box;margin-top:4px}
  button[type=submit]{margin-top:12px;padding:10px 16px;background:#0070d0;color:#fff;border:0;border-radius:4px;font-size:1em;cursor:pointer}
  button[type=submit]:hover{background:#005bb0}
  .err{color:#c00;margin-top:8px;font-size:0.9em;min-height:1.2em}
  .sep{margin:24px 0;text-align:center;color:#999;font-size:0.9em}
</style></head>
<body>
<h1>${t.title}</h1>
${hasGoogle ? `<p><a class="btn-google" href="/auth/login?returnTo=${encodeURIComponent(returnTo)}">${t.google}</a></p>` : ''}
${hasGoogle && hasAdminPw ? `<div class="sep">— ${t.or} —</div>` : ''}
${hasAdminPw ? `<fieldset><legend>${t.adminTitle}</legend>
<form id="admin-form">
  <label>${t.email}<input type="email" id="email" required autocomplete="username"></label>
  <label>${t.password}<input type="password" id="password" required autocomplete="current-password"></label>
  <button type="submit">${t.submit}</button>
  <div class="err" id="err"></div>
</form></fieldset>
<script>
document.getElementById('admin-form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  try {
    const r = await fetch('/auth/admin-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.ok) { window.location.href = ${JSON.stringify(returnTo)}; return; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) {
      const sec = j.retryAfter || 900;
      err.textContent = ${lang === 'en' ? `'Too many attempts. Retry in ' + sec + 's.'` : `'Zu viele Versuche. Erneut in ' + sec + 's.'`};
    } else {
      err.textContent = ${JSON.stringify(lang === 'en' ? 'Invalid credentials.' : 'Falsche Zugangsdaten.')};
    }
  } catch (ex) {
    err.textContent = ex.message;
  }
});
</script>` : (hasGoogle ? '' : `<p>${t.noAdmin}</p>`)}
</body></html>`);
});

// POST /auth/admin-login → ENV-getriebener Admin-Login.
//
// Wahrheit lebt in ENV: ADMIN_EMAIL + ADMIN_PASSWORD. timingSafeEqual ueber
// SHA-256-Hash beider Werte (gleiche Buffer-Laenge, konstantzeit-Vergleich).
// Rate-Limit pro IP via lib/admin-login-ratelimit. Ohne ADMIN_PASSWORD-ENV
// liefert die Route 404 (Login-Pfad B komplett deaktiviert).
router.post('/auth/admin-login', express.json(), (req, res) => {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    return res.status(404).json({ error_code: 'ADMIN_LOGIN_DISABLED' });
  }
  const ip = _clientIp(req);
  const state = rateLimit.getState(ip);
  if (state.blocked) {
    res.set('Retry-After', String(state.retryAfterSec || 900));
    return res.status(429).json({ error_code: 'RATE_LIMITED', retryAfter: state.retryAfterSec });
  }
  const { email, password } = req.body || {};
  const givenEmail = (email || '').toLowerCase().trim();
  const expectedEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const userAgent = req.headers['user-agent'] || null;

  const emailMatch = givenEmail && expectedEmail && givenEmail === expectedEmail;
  const passwordMatch = _passwordsMatch(process.env.ADMIN_PASSWORD, password);

  if (!emailMatch || !passwordMatch) {
    const after = rateLimit.recordFailure(ip);
    appUsers.recordAuditEvent(givenEmail || expectedEmail, 'login-denied', { ip, userAgent, meta: { method: 'env', failCount: after.failCount } });
    logger.warn('Admin-Login fehlgeschlagen.', { user: givenEmail || expectedEmail });
    return res.status(401).json({ error_code: 'INVALID_CREDENTIALS' });
  }

  rateLimit.recordSuccess(ip);
  // Sicherstellen, dass app_users-Row existiert + global_role='admin'.
  appUsers.ensureAdminFromEnv();
  appUsers.touchLogin(givenEmail);
  appUsers.recordAuditEvent(givenEmail, 'login', { ip, userAgent, meta: { method: 'env' } });

  req.session.user = { email: givenEmail, name: 'Admin', picture: null, role: 'admin' };
  req.session.loginAt = Date.now();
  req.session.lastSeen = Date.now();
  upsertUserLogin(givenEmail, 'Admin');
  logger.info('Admin-Login (ENV-Pfad).', { user: givenEmail });
  req.session.save(err => {
    if (err) return res.status(500).json({ error_code: 'SESSION_SAVE_FAILED' });
    res.json({ ok: true });
  });
});

// GET /auth/logout → Session löschen + Landing-Page anzeigen.
// Kein Auto-Redirect zu /auth/login: Google-Session wäre meist noch aktiv und
// würde uns sofort silent wieder einloggen. User klickt aktiv "Erneut anmelden".
router.get('/auth/logout', (req, res) => {
  const email = req.session.user?.email;
  const loginAt = req.session.loginAt;
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  const lang = accept.startsWith('en') ? 'en' : 'de';
  const ip = _clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  if (email) {
    appUsers.recordAuditEvent(email, 'logout', { ip, userAgent });
  }
  req.session.destroy(() => {
    if (email) {
      const durMin = loginAt ? Math.round((Date.now() - loginAt) / 60000) : null;
      logger.info(`Logout${durMin != null ? ` (Session ${durMin} min)` : ''}`, { user: email });
    }
    const t = lang === 'en'
      ? { title: 'Signed out', body: 'You have been signed out.', cta: 'Sign in again' }
      : { title: 'Abgemeldet', body: 'Du wurdest abgemeldet.', cta: 'Erneut anmelden' };
    res.set('Cache-Control', 'no-store');
    res.send(`<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${t.title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><h1>${t.title}</h1><p>${t.body}</p>
<p><a href="/auth/login">${t.cta}</a></p></body></html>`);
  });
});

// GET /auth/me → aktueller User (JSON, für Frontend)
router.get('/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  res.json(req.session.user);
});

// GET /auth/token → ob ein BookStack-Token hinterlegt ist (kein Klartext!)
router.get('/auth/token', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  res.json({ hasToken: !!getTokenForRequest(req) });
});

// PUT /auth/token → BookStack-Token speichern (DB + Session)
router.put('/auth/token', express.json(), (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const { tokenId, tokenPw } = req.body || {};
  if (!tokenId || !tokenPw) return res.status(400).json({ error_code: 'TOKEN_ID_PW_REQUIRED' });
  const email = req.session.user.email;
  setUserToken(email, tokenId, tokenPw);
  req.session.bookstackToken = { id: tokenId, pw: tokenPw };
  logger.info('BookStack-Token gespeichert.');
  res.json({ ok: true });
});

module.exports = router;
