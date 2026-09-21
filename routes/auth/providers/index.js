'use strict';
// Registry der Anmelde-Verfahren.
//
// Genau EIN Verfahren ist aktiv; welches, steht in `auth.method`
// (lib/app-settings/keys/auth.js). Diese Datei ist die SSoT darueber, welche
// Verfahren es ueberhaupt gibt — die `oneOf`-Liste des Settings-Keys spiegelt
// sie, und tests/unit/auth-providers.test.js macht CI rot, sobald die beiden
// auseinanderlaufen.
//
// Vertrag eines Verfahrens (ein Modul in diesem Ordner):
//
//   id                 Kennung, identisch mit dem Wert in `auth.method`.
//   router             Express-Router mit den eigenen Endpunkten. Wird nur
//                      durchlaufen, solange dieses Verfahren aktiv ist.
//   isConfigured()     Hat der Admin alles gesetzt, was das Verfahren braucht?
//   configKeys         Settings-Keys, die dazu gehoeren (Admin-UI + Check).
//   inviteRedirect(t)  Wohin fuehrt ein angeklickter Einladungslink?
//   renderLoginBlock({ t, returnTo })  Block auf der Login-Seite (HTML-String).
//   loginScripts()     Zusaetzliche <script>-Tags fuer diesen Block.
//
// Ein weiteres Verfahren ist damit eine Datei plus zwei Zeilen: der Eintrag
// hier und der Wert in der `oneOf`-Liste. Weder die Login-Seite noch der
// Auth-Guard noch das Admin-UI muessen dafuer angefasst werden.

const appSettings = require('../../../lib/app-settings');

const PROVIDERS = [
  require('./google'),
  require('./local'),
];

const BY_ID = new Map(PROVIDERS.map(p => [p.id, p]));

/** Alle bekannten Verfahren (Reihenfolge = Anzeigereihenfolge im Admin-UI). */
function listProviders() {
  return PROVIDERS;
}

function getProvider(id) {
  return BY_ID.get(id) || null;
}

/**
 * Id des aktiven Verfahrens. Faellt auf 'google' zurueck, wenn in der DB ein
 * Wert steht, den diese Version nicht kennt — ein Downgrade soll die Instanz
 * nicht ohne Anmeldeweg zuruecklassen.
 */
function activeProviderId() {
  const id = appSettings.get('auth.method');
  return BY_ID.has(id) ? id : 'google';
}

function activeProvider() {
  return BY_ID.get(activeProviderId());
}

function isActive(id) {
  return activeProviderId() === id;
}

/** Mountet alle Provider-Router hinter je einem Gate auf das aktive Verfahren. */
function mountAll(router) {
  for (const p of PROVIDERS) {
    router.use((req, res, next) => (isActive(p.id) ? p.router(req, res, next) : next()));
  }
}

module.exports = {
  PROVIDER_IDS: PROVIDERS.map(p => p.id),
  listProviders, getProvider, activeProviderId, activeProvider, isActive, mountAll,
};
