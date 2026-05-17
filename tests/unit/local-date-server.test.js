// Server-Helper-Pendant zu local-date.test.mjs. CommonJS, weil lib/local-date.js
// require()'d wird (sync.js, history.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { localIsoDate, localIsoDaysAgo, currentTz } = require('../../lib/local-date.js');

test('server localIsoDate: Format YYYY-MM-DD', () => {
  const iso = localIsoDate();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
});

test('server localIsoDate: respektiert TZ-Override', () => {
  const d = new Date('2026-05-04T22:00:00Z'); // UTC Mo 22:00 = CEST Di 00:00
  // In Europe/Zurich ist es bereits Di 04.05+1
  const zurich = localIsoDate(d, 'Europe/Zurich');
  // In UTC ist es noch Mo 04.05.
  const utc = localIsoDate(d, 'UTC');
  assert.equal(utc, '2026-05-04');
  assert.equal(zurich, '2026-05-05');
});

test('server localIsoDaysAgo: chronologisch + DST-stabil', () => {
  const today = localIsoDaysAgo(0);
  const dates = new Set();
  for (let i = 0; i < 60; i++) dates.add(localIsoDaysAgo(i));
  assert.equal(dates.size, 60);
  assert.ok(dates.has(today));
});

test('server currentTz: app_settings-aware Fallback', () => {
  const tz = currentTz();
  assert.ok(typeof tz === 'string' && tz.length > 0);
});
