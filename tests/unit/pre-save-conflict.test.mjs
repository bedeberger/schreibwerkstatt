// Tests für Pre-Save-Conflict-Check (Stage 1 Kollaborations-Awareness).
// App hat keinen If-Match-Support — Optimistic-Concurrency baut sie selbst:
// kurz vor jedem PUT die Seite frisch lesen und `updated_at` mit dem
// Snapshot vom Editor-Open vergleichen. Mismatch = Cross-User-Konflikt.
//
// Reads gehen ueber contentRepo.loadPage (= GET /content/pages/:id). Wir
// stubben globalThis.fetch, contentRepo macht den HTTP-Call.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
};
globalThis.document = globalThis.document || {
  createElement: () => ({ innerHTML: '', querySelectorAll: () => [], appendChild: () => {} }),
};

const { bookstackMethods } = await import('../../public/js/api-bookstack.js');

let originalFetch;
let originalNavigatorDesc;
let fetchCalls;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { serviceWorker: { controller: { postMessage() {} } } },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNavigatorDesc) Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc);
  else delete globalThis.navigator;
});

function mockFetch(handler) {
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    return handler(String(url), opts || {});
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function makeCtx() {
  return { ...bookstackMethods, t: (k) => k };
}

test('_checkPageConflict: returns null wenn updated_at identisch', async () => {
  mockFetch(() => jsonResponse({ id: 1, updated_at: 't1', html: '<p>x</p>' }));
  const r = await makeCtx()._checkPageConflict(1, 't1');
  assert.equal(r, null);
});

test('_checkPageConflict: liefert remote-Info bei updated_at-Mismatch', async () => {
  mockFetch(() => jsonResponse({
    id: 1,
    updated_at: 't2',
    html: '<p>fremde Änderung</p>',
    updated_by_name: 'Alice',
  }));
  const r = await makeCtx()._checkPageConflict(1, 't1');
  assert.equal(r.remoteUpdatedAt, 't2');
  assert.equal(r.remoteUserName, 'Alice');
  assert.equal(r.remoteHtml, '<p>fremde Änderung</p>');
});

test('_checkPageConflict: returns null bei fehlendem expectedUpdatedAt (kein Baseline)', async () => {
  mockFetch(() => { throw new Error('darf nicht laufen'); });
  assert.equal(await makeCtx()._checkPageConflict(1, null), null);
  assert.equal(await makeCtx()._checkPageConflict(1, ''), null);
  assert.equal(await makeCtx()._checkPageConflict(1, undefined), null);
  assert.equal(fetchCalls.length, 0);
});

test('_checkPageConflict: returns null bei Read-Fehler (defensiv – kein false positive)', async () => {
  mockFetch(() => { throw new Error('network'); });
  assert.equal(await makeCtx()._checkPageConflict(1, 't1'), null);
});

test('_checkPageConflict: fallback auf null-User wenn updated_by_name fehlt', async () => {
  mockFetch(() => jsonResponse({ updated_at: 't2', html: '' }));
  const r = await makeCtx()._checkPageConflict(1, 't1');
  assert.equal(r.remoteUserName, null);
});

test('_checkPageConflict: loadPage wird mit fresh:true aufgerufen (umgeht SW-Cache)', async () => {
  mockFetch(() => jsonResponse({ updated_at: 't1' }));
  await makeCtx()._checkPageConflict(42, 't1');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/content/pages/42?__fresh=1',
    'Conflict-Check muss fresh-Marker setzen, sonst sieht er ggf. den eigenen stale SW-Cache');
});
