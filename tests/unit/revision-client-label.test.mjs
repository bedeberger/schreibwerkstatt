// Revision-Client-Label (_clientFromCtx): Per-Request-Selbstidentifikation hat
// Vorrang vor statischen Token-Feldern, damit ein geteiltes Device-Token auf
// mehreren Geraeten (Mac + Android) trotzdem das richtige „Geraet" anzeigt.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.DB_PATH = path.join('/tmp', `rev-client-label-${process.pid}-${Date.now()}.db`);

require('../../db/connection');
require('../../db/migrations');
const appUsers = require('../../db/app-users');
const deviceTokens = require('../../db/device-tokens');
const { _clientFromCtx } = require('../../lib/content-store');

appUsers.createUser({ email: 'dev@x.test', displayName: 'Dev' });

function deviceCtx(extra = {}) {
  return { session: { user: { via: 'device_token', ...extra } } };
}

test('per-request device + platform schlaegt das Token (geteiltes Token)', () => {
  // tokenId zeigt auf ein „macclient"-Token, aber der Request kommt von Android.
  const tok = deviceTokens.createDeviceToken({ userEmail: 'dev@x.test', deviceName: 'macclient', platform: 'macos' });
  const label = _clientFromCtx(deviceCtx({ tokenId: tok.id, clientDevice: 'Pixel 8', clientPlatform: 'android' }));
  assert.strictEqual(label, 'Pixel 8 · Android');
});

test('per-request nur Plattform → "<Platform>-App"', () => {
  assert.strictEqual(_clientFromCtx(deviceCtx({ clientPlatform: 'android' })), 'Android-App');
});

test('Plattform-Codes werden huebsch gemappt', () => {
  assert.strictEqual(_clientFromCtx(deviceCtx({ clientPlatform: 'macos' })), 'macOS-App');
  assert.strictEqual(_clientFromCtx(deviceCtx({ clientPlatform: 'ios' })), 'iOS-App');
});

test('Fallback auf statische Token-Felder ohne Request-Header', () => {
  const tok = deviceTokens.createDeviceToken({ userEmail: 'dev@x.test', deviceName: 'MacBook', platform: 'macos' });
  assert.strictEqual(_clientFromCtx(deviceCtx({ tokenId: tok.id })), 'MacBook · macOS');
});

test('Browser-Request → User-Agent-Label, kein Device-Pfad', () => {
  const ctx = {
    session: { user: { via: 'session' } },
    get: (h) => (h === 'user-agent' ? 'Mozilla/5.0 (Macintosh) Safari/605' : null),
  };
  const label = _clientFromCtx(ctx);
  assert.ok(label && label.length > 0);
  assert.ok(!label.includes('android'));
});

test('kein ctx / kein User → null', () => {
  assert.strictEqual(_clientFromCtx(null), null);
  assert.strictEqual(_clientFromCtx({}), null);
});
