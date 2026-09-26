// Gate fuer das Aufraeumen des VENDOR_CACHE im Service Worker (public/sw.js
// #pruneVendorCache). Der Cache ist generationsunabhaengig und ueberlebt jeden
// Deploy — ohne Pruning bliebe jede ersetzte Vendor-Version (neuer Dateiname)
// fuer immer liegen. Die Liste des aktuellen Bestands kommt als __VENDOR_SET aus
// scripts/sw-manifest.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const require = createRequire(import.meta.url);
const { renderManifest } = require(path.join(ROOT, 'scripts', 'sw-manifest.js'));

function makeCache(paths) {
  const store = new Map(paths.map(p => ['https://example.test' + p, { body: p }]));
  return {
    store,
    async keys() { return [...store.keys()].map(url => ({ url })); },
    async delete(req) { return store.delete(typeof req === 'string' ? req : req.url); },
    async match() { return undefined; },
    async put() {},
  };
}

function loadSw({ vendorSet, vendorCache }) {
  const named = new Map();
  const caches = {
    async open(name) {
      if (name === 'schreibwerkstatt-vendor-v1') return vendorCache;
      if (!named.has(name)) named.set(name, makeCache([]));
      return named.get(name);
    },
    async keys() { return ['schreibwerkstatt-vendor-v1']; },
    async delete() { return true; },
  };
  const listeners = {};
  const sandbox = { console, URL, JSON, Response: class {}, Request: class {}, caches, fetch: async () => { throw new Error('offline'); }, importScripts() {} };
  sandbox.self = sandbox;
  sandbox.self.__SHELL_BUILD = 'testbuild';
  sandbox.self.__SHELL_MANIFEST = ['/js/app.js'];
  if (vendorSet) sandbox.self.__VENDOR_SET = vendorSet;
  sandbox.self.addEventListener = (type, fn) => { listeners[type] = fn; };
  sandbox.self.location = { origin: 'https://example.test' };
  vm.runInContext(SW_SRC, vm.createContext(sandbox));
  return listeners;
}

async function activate(listeners) {
  let p;
  listeners.activate({ waitUntil: (x) => { p = x; } });
  await p;
}

test('activate entfernt Vendor-Eintraege, die nicht mehr im Bestand stehen', async () => {
  const vendorCache = makeCache(['/vendor/alpine-3.15.12.min.js', '/vendor/alpine-3.14.0.min.js', '/fonts/Inter.var.woff2']);
  const listeners = loadSw({ vendorSet: ['/vendor/alpine-3.15.12.min.js', '/fonts/Inter.var.woff2'], vendorCache });
  await activate(listeners);
  assert.deepEqual([...vendorCache.store.keys()].sort(), [
    'https://example.test/fonts/Inter.var.woff2',
    'https://example.test/vendor/alpine-3.15.12.min.js',
  ]);
});

test('ohne __VENDOR_SET (Manifest eines aelteren Generators) bleibt der Cache unangetastet', async () => {
  const vendorCache = makeCache(['/vendor/alpine-3.14.0.min.js']);
  const listeners = loadSw({ vendorSet: null, vendorCache });
  await activate(listeners);
  assert.equal(vendorCache.store.size, 1);
});

test('Generator listet vendor/ + fonts/ als __VENDOR_SET, getrennt vom Precache-Satz', () => {
  const { urls, vendorUrls, content } = renderManifest();
  assert.ok(vendorUrls.length > 0);
  for (const u of vendorUrls) assert.match(u, /^\/(?:vendor|fonts)\//);
  assert.ok(vendorUrls.some(u => /^\/vendor\/alpine-[\d.]+\.min\.js$/.test(u)), 'Alpine-Core fehlt im Vendor-Bestand');
  for (const u of urls) assert.ok(!vendorUrls.includes(u));
  assert.match(content, /self\.__VENDOR_SET = \[/);
});
