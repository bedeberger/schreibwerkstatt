'use strict';
// app_users_devices: pro Browser/Geraet eine Row. Client generiert eine UUID
// in localStorage; Server speichert sie zusammen mit Auto-Label aus UA-String.
// Verwendet von page_presence (Multi-Device-Sichtbarkeit) und potenziell
// spaeter von einer Settings-UI (Geraete umbenennen/widerrufen).
//
// PK ist `device_id`. Wechselt ein User im selben Browser den Login, gewinnt
// der letzte User (last-owner-wins) — Edge-Case, siehe Plan.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { uaLabel } = require('../lib/ua-label');

const _stmtUpsert = db.prepare(`
  INSERT INTO app_users_devices (device_id, user_email, label, user_agent, created_at, last_seen_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  ON CONFLICT(device_id) DO UPDATE SET
    user_email   = excluded.user_email,
    user_agent   = excluded.user_agent,
    last_seen_at = ${NOW_ISO_SQL}
`);

function upsertDevice(deviceId, userEmail, userAgent) {
  if (!deviceId || !userEmail) return false;
  const label = uaLabel(userAgent || '');
  _stmtUpsert.run(deviceId, userEmail, label, userAgent || '');
  return true;
}

const _stmtGet = db.prepare(`
  SELECT device_id, user_email, label, user_agent, created_at, last_seen_at
    FROM app_users_devices
   WHERE device_id = ?
`);

function getDevice(deviceId) {
  if (!deviceId) return null;
  return _stmtGet.get(deviceId) || null;
}

const _stmtList = db.prepare(`
  SELECT device_id, user_email, label, user_agent, created_at, last_seen_at
    FROM app_users_devices
   WHERE user_email = ?
   ORDER BY last_seen_at DESC
`);

function listDevicesForUser(userEmail) {
  if (!userEmail) return [];
  return _stmtList.all(userEmail);
}

module.exports = { upsertDevice, getDevice, listDevicesForUser };
