'use strict';
// Oeffentliche Basis-URL der Instanz. SSoT ist `app_settings` (`app.public_url`).
//
// Im LOCAL_DEV_MODE faellt der Wert auf den lokalen Dev-Port zurueck; sonst muss
// der Admin ihn in der Settings-UI gesetzt haben, damit OIDC-Callback,
// Einladungs- und Passwort-Links absolut adressieren koennen. Leerer String
// heisst „nicht konfiguriert" — Aufrufer, die einen Link bauen, fallen dann auf
// den relativen Pfad zurueck (der beim Weitergeben von Hand traegt, in Mails
// aber nicht).

const appSettings = require('./app-settings');

function publicUrl() {
  const fromDb = appSettings.get('app.public_url');
  if (fromDb) return String(fromDb).replace(/\/$/, '');
  if (process.env.LOCAL_DEV_MODE === 'true') {
    return `http://localhost:${process.env.PORT || 3737}`;
  }
  return '';
}

/** Absoluter Link auf einen App-Pfad; ohne konfigurierte Basis-URL relativ. */
function absoluteUrl(path) {
  const base = publicUrl();
  return base ? `${base}${path}` : path;
}

module.exports = { publicUrl, absoluteUrl };
