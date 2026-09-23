'use strict';
// Kurzlebige Session fuer Token-Requests (Bearer `sw_…` = api_tokens/Metrics,
// `swd_…` = device_tokens/native Clients).
//
// Token-Clients authentifizieren sich mit jedem Request neu und senden das
// Session-Cookie nicht zurueck. Liefe ein solcher Request durch express-session,
// wuerde das Setzen von `req.session.user` (lib/bearer-auth, server.js
// Device-Auth) die Session "modified" machen: pro Request eine neue Zeile in
// `sessions` plus ein Set-Cookie, das niemand liest — beim 15-s-Scrape von Home
// Assistant und dem Sekundentakt des Mac-Clients Zehntausende Zeilen pro Woche.
//
// Stattdessen bekommen diese Requests ein reines In-Memory-Objekt: downstream
// (Auth-Guard, ACL, Logging, Scope-Gate) sieht wie gewohnt `req.session.user`,
// persistiert wird nichts, ein Cookie entsteht nicht. Ein mitgeschicktes
// Session-Cookie wird dabei bewusst ignoriert — Device-Auth hat ohnehin Vorrang
// vor der Session (siehe Auth-Guard in server.js), und ein ungueltiges Token
// darf nicht auf eine Cookie-Session zurueckfallen.

const { extractBearer } = require('./device-auth');
const apiTokens = require('../db/api-tokens');
const deviceTokens = require('../db/device-tokens');

function hasTokenBearer(req) {
  const plain = extractBearer(req);
  if (!plain) return false;
  return plain.startsWith(deviceTokens.TOKEN_PREFIX) || plain.startsWith(apiTokens.TOKEN_PREFIX);
}

// Methoden-Set von express-session, soweit Handler es aufrufen (save nach Login,
// destroy bei Konto-Selbstloeschung). Nicht-enumerable, damit das Objekt beim
// Loggen/Serialisieren wie eine Session-Payload aussieht.
function createEphemeralSession() {
  const sess = {};
  const done = (cb) => { if (typeof cb === 'function') cb(); return sess; };
  for (const name of ['save', 'destroy', 'regenerate', 'reload', 'touch', 'resetMaxAge']) {
    Object.defineProperty(sess, name, { value: done, enumerable: false });
  }
  Object.defineProperty(sess, 'ephemeral', { value: true, enumerable: false });
  return sess;
}

// Wrappt die express-session-Middleware: Token-Requests umgehen sie komplett.
function tokenAwareSession(sessionMiddleware) {
  return function tokenAwareSessionMiddleware(req, res, next) {
    if (hasTokenBearer(req)) {
      req.session = createEphemeralSession();
      return next();
    }
    return sessionMiddleware(req, res, next);
  };
}

module.exports = { tokenAwareSession, hasTokenBearer, createEphemeralSession };
