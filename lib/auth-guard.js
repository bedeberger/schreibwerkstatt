'use strict';
// Session-/Device-Token-Guard vor allen geschuetzten Routen.
//
// Antwort ohne Anmeldung: nur eine Browser-Navigation bekommt den Redirect auf
// /login, jeder andere Request `401 { error_code: 'NOT_LOGGED_IN' }`. Die
// Entscheidung haengt am Request, nicht an einer Pfadliste: eine Liste
// „API-Praefixe" deckt nie alle gemounteten Router ab, und ein fetch(), der
// statt des 401 ein 302 auf Login-HTML bekommt, laeuft am zentralen
// session-expired-Handling vorbei (public/js/app.js) und scheitert als
// JSON-Parse-Fehler. Clients ohne Sec-Fetch-Header (native Clients, Skripte)
// senden kein `Accept: text/html` und bekommen darum ebenfalls den 401.

const logger = require('../logger');
const { setContext } = require('./log-context');
const { tryDeviceAuth, extractBearer } = require('./device-auth');
const deviceTokens = require('../db/device-tokens');
const appUsers = require('../db/app-users');

/** true = Browser-Navigation, die auf die Login-Seite umgeleitet werden soll. */
function wantsLoginRedirect(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const mode = req.headers['sec-fetch-mode'];
  if (mode) return mode === 'navigate';
  // Ohne Fetch-Metadata (aeltere Browser): nur wer HTML vor JSON bevorzugt.
  const accept = String(req.headers.accept || '');
  if (!/text\/html/i.test(accept)) return false;
  return req.accepts(['html', 'json']) === 'html';
}

function rejectUnauthenticated(req, res) {
  if (wantsLoginRedirect(req)) {
    return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
}

// LOCAL_DEV_MODE: Auto-Dev-Session als Admin (idempotenter Upsert).
function _ensureDevSession(req) {
  req.session.user = { email: 'dev@local', name: 'Dev (lokal)', role: 'admin' };
  try {
    const existing = appUsers.getUser('dev@local');
    if (!existing) {
      appUsers.createUser({ email: 'dev@local', displayName: 'Dev (lokal)', globalRole: 'admin', status: 'active' });
    } else if (existing.global_role !== 'admin' || existing.status !== 'active') {
      if (existing.global_role !== 'admin') appUsers.setGlobalRole('dev@local', 'admin');
      if (existing.status !== 'active') appUsers.setStatus('dev@local', 'active');
    }
    appUsers.touchLogin('dev@local', 'Dev (lokal)');
  } catch (e) { logger.warn(`dev-mode admin upsert: ${e.message}`); }
}

function makeAuthGuard({ localDevMode = false } = {}) {
  return function authGuard(req, res, next) {
    // Device-Token (native Clients, z.B. Mac-Focus-Writer): Bearer swd_… loest auf
    // den echten User + dessen echte Rolle auf und respektiert das Status-Gate.
    // req.session.user wird gesetzt, sodass downstream (ACL, Logging, Activity)
    // den Request wie eine normale Session behandelt.
    //
    // Traegt der Request ein swd_-Bearer-Token, hat die Device-Auth IMMER Vorrang —
    // ein mitgeschicktes Session-Cookie zaehlt nicht. Token-Requests laufen darum
    // auf einer leeren In-Memory-Session (lib/token-session.js); wuerde ein Cookie
    // die Device-Auth kurzschliessen, fror die touchTokenUsage-Telemetrie ein und
    // widerrufene Tokens blieben gueltig. Bei ungueltigem/widerrufenem Token geht
    // es deshalb direkt in 401/Redirect, nie zurueck auf eine Cookie-Session.
    const bearer = extractBearer(req);
    const isDeviceBearer = !!bearer && bearer.startsWith(deviceTokens.TOKEN_PREFIX);
    if (req.session?.user && !isDeviceBearer) return next();
    const deviceUser = tryDeviceAuth(req);
    if (deviceUser) {
      req.session.user = deviceUser;
      // Der ALS-Log-Context wurde mit user=null eingefroren (Device-Auth laeuft
      // erst hier, nach Session-Pruefung) — User nachtragen, damit Client-Requests
      // im Log-Tag dem User zugeordnet sind.
      setContext({ user: deviceUser.email });
      return next();
    }
    if (isDeviceBearer) return rejectUnauthenticated(req, res);
    // Dev-Logout-Marker (gesetzt durch /auth/logout): Auto-Dev-Session unterbinden,
    // damit der User Logout/Login-Flow wie in Prod testen kann. /auth/login raeumt
    // den Marker.
    if (localDevMode && !/(?:^|;\s*)sw_devout=1(?:;|$)/.test(req.headers.cookie || '')) {
      _ensureDevSession(req);
      return next();
    }
    return rejectUnauthenticated(req, res);
  };
}

module.exports = { makeAuthGuard, wantsLoginRedirect, rejectUnauthenticated };
