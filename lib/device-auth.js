'use strict';
// Device-Token-Auth fuer native Clients (Mac-Focus-Writer).
//
// Im Gegensatz zum admin-scoped Metrics-Bearer (lib/bearer-auth) loest ein
// Device-Token auf den ECHTEN User + dessen ECHTE Rolle auf und respektiert das
// Status-Gate (suspended/deleted → abgewiesen). `tryDeviceAuth` wird im globalen
// Auth-Guard (server.js) aufgerufen: liefert es ein User-Objekt, behandelt der
// Guard den Request wie eine normale Session. Liefert es null, faellt der Guard
// auf seinen 401/Redirect-Pfad zurueck.

const logger = require('../logger');
const deviceTokens = require('../db/device-tokens');
const appUsers = require('../db/app-users');

function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// Versucht, den Request ueber ein Device-Token zu authentifizieren.
// Gibt `{ email, name, role, via:'device_token', tokenId, scopes }` oder null.
function tryDeviceAuth(req) {
  const plain = extractBearer(req);
  if (!plain || !plain.startsWith(deviceTokens.TOKEN_PREFIX)) return null;
  const row = deviceTokens.findActiveTokenByPlain(plain);
  if (!row) return null;

  const user = appUsers.getUser(row.user_email);
  if (!user || user.status === 'suspended' || user.status === 'deleted') return null;

  try {
    const ip = (req.ip || '').toString();
    const clientVersion = req.headers['x-client-version'] || null;
    deviceTokens.touchTokenUsage(row.id, ip, clientVersion);
  } catch (e) {
    logger.warn(`device_tokens.touchTokenUsage: ${e.message}`);
  }

  return {
    email: user.email,
    name: user.display_name || user.email,
    role: user.global_role || 'user',
    via: 'device_token',
    tokenId: row.id,
    scopes: row.scopes,
  };
}

module.exports = { tryDeviceAuth, extractBearer };
