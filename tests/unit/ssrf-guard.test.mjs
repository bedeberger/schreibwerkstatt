// Unit-Tests fuer lib/ssrf-guard.js — IP-Blockliste inkl. aller IPv6-Formen,
// die eine IPv4-Adresse einbetten. Die URL-Varianten laufen durch WHATWG-URL,
// weil genau dessen Normalisierung (`[::ffff:127.0.0.1]` -> `[::ffff:7f00:1]`)
// ein Match auf die dotted Form aushebelt.
//
// Lauf: `node --test tests/unit/ssrf-guard.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isBlockedIp, isBlockedHost, assertPublicUrl, expandIPv6 } = require('../../lib/ssrf-guard.js');

test('expandIPv6: Kompression, dotted Tail, ungueltige Formen', () => {
  assert.deepEqual(expandIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIPv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(expandIPv6('2001:db8::'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
  assert.equal(expandIPv6('1::2::3'), null);
  assert.equal(expandIPv6('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(expandIPv6('gggg::'), null);
});

const BLOCKED_URLS = [
  'http://[::ffff:127.0.0.1]:3737/',
  'http://[::ffff:7f00:1]/',
  'http://[::ffff:169.254.169.254]/latest/meta-data/',
  'http://[::ffff:a9fe:a9fe]/',
  'http://[0:0:0:0:0:ffff:10.0.0.1]/',
  'http://[::127.0.0.1]/',
  'http://[64:ff9b::127.0.0.1]/',
  'http://[64:ff9b::a9fe:a9fe]/',
  'http://[64:ff9b:1::1]/',
  'http://[2002:7f00:1::]/',
  'http://[2002:c0a8:101::1]/',
  'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
  'http://[::1]/',
  'http://[::]/',
  'http://[fe80::1]/',
  'http://[fd00::1]/',
  'http://[ff02::1]/',
  'http://127.0.0.1/',
  'http://169.254.169.254/',
  'http://localhost/',
];

for (const url of BLOCKED_URLS) {
  test(`assertPublicUrl blockt ${url}`, async () => {
    await assert.rejects(assertPublicUrl(url), (e) => e.code === 'SSRF_BLOCKED_HOST');
  });
}

test('oeffentliche IPv6-Adressen und eingebettete oeffentliche IPv4 bleiben erlaubt', () => {
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2002:808:808::1']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('isBlockedHost versteht eckige Klammern und hex-mapped Form', () => {
  assert.equal(isBlockedHost('[::ffff:7f00:1]'), true);
  assert.equal(isBlockedHost('example.com'), false);
});

test('assertPublicUrl: oeffentliches IPv6-Literal geht durch', async () => {
  await assertPublicUrl('http://[2606:4700:4700::1111]/');
});
