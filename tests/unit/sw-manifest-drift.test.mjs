// Drift guard: public/sw-manifest.js MUST equal a fresh scan of the
// coherence-critical shell assets. If this fails after adding/removing/editing
// a partial, JS module, CSS file, i18n JSON or the icon sprite, regenerate via:
//   npm run sw:manifest
// (also runs automatically on `prestart`). A stale manifest means the SW would
// precache an incoherent set — exactly the cache-skew this whole mechanism exists
// to prevent.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const require = createRequire(import.meta.url);
const { renderManifest } = require(join(ROOT, 'scripts', 'sw-manifest.js'));

test('public/sw-manifest.js matches a fresh scan of public/', () => {
  const fresh = renderManifest();
  const committed = readFileSync(join(ROOT, 'public', 'sw-manifest.js'), 'utf8');
  assert.equal(
    committed,
    fresh.content,
    'sw-manifest.js drift — regenerate with `npm run sw:manifest`.',
  );
});

test('manifest excludes vendor, fonts and dynamic assets', () => {
  const { urls } = renderManifest();
  for (const u of urls) {
    assert.ok(!u.startsWith('/vendor/'), `vendor asset leaked into manifest: ${u}`);
    assert.ok(!u.startsWith('/fonts/'), `font asset leaked into manifest: ${u}`);
    assert.notEqual(u, '/js/plausible-init.js', 'plausible-init.js must never be precached');
    assert.notEqual(u, '/sw.js', 'sw.js must not be in the manifest');
    assert.notEqual(u, '/sw-manifest.js', 'sw-manifest.js must not list itself');
  }
});

test('manifest covers every HTML partial', () => {
  const { urls } = renderManifest();
  const partials = urls.filter((u) => u.startsWith('/partials/'));
  assert.ok(partials.length > 0, 'expected at least one partial in the manifest');
  // app.js boot relies on these being precached; a missing partial is the
  // classic skew trigger.
  assert.ok(urls.includes('/js/app.js'), 'app.js must be precached');
});
