'use strict';
// Invite-URL-Builder. Eine Quelle fuer den Link, der per Mail an eingeladene
// User geht — sowohl Initial-Invite (Admin-User-Tab + Registration-Approval)
// als auch Reminder-Mails verwenden die gleiche Form:
//
//   {publicUrl}/invite/{token}
//
// Die Route /invite/:token (routes/auth.js) loggt den Klick und leitet auf
// /login?returnTo=/?invite={token} weiter, damit der bestehende OIDC-Callback-
// Flow den Token aus returnTo zieht und appUsers.acceptInvite ruft.
//
// Fallback ohne app.public_url (LOCAL_DEV_MODE oder noch nicht konfiguriert):
// relativer Pfad — funktioniert beim Manuell-Weitergeben, nicht aber in echten
// Mails. Caller pruefen Mailer-Status separat.

const appSettings = require('./app-settings');

function buildInviteUrl(token) {
  if (!token) return '';
  const base = (appSettings.get('app.public_url') || '').replace(/\/$/, '');
  const path = `/invite/${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
}

module.exports = { buildInviteUrl };
