// Tests für Pre-Save-Conflict-Check (Stage 1 Kollaborations-Awareness).
// BookStack hat keinen If-Match-Support — Optimistic-Concurrency baut die App
// selbst: kurz vor jedem PUT die Seite frisch lesen und `updated_at` mit dem
// Snapshot vom Editor-Open vergleichen. Mismatch = Cross-User-Konflikt.
//
// Zwei Verhaltensweisen:
//   - saveEdit (User-Klick): appConfirm-Modal, Cancel hält Draft.
//   - quickSave (Auto/Pre-Send): silent saveOffline-Banner, kein Modal.

import test from 'node:test';
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

// ── Helper-Direktcheck ──────────────────────────────────────────────────────

test('_checkPageConflict: returns null wenn updated_at identisch', async () => {
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => ({ id: 1, updated_at: 't1', html: '<p>x</p>' }),
    t: (k) => k,
  };
  const r = await ctx._checkPageConflict(1, 't1');
  assert.equal(r, null);
});

test('_checkPageConflict: liefert remote-Info bei updated_at-Mismatch', async () => {
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => ({
      id: 1,
      updated_at: 't2',
      html: '<p>fremde Änderung</p>',
      updated_by: { name: 'Alice' },
    }),
    t: (k) => k,
  };
  const r = await ctx._checkPageConflict(1, 't1');
  assert.equal(r.remoteUpdatedAt, 't2');
  assert.equal(r.remoteUserName, 'Alice');
  assert.equal(r.remoteHtml, '<p>fremde Änderung</p>');
});

test('_checkPageConflict: returns null bei fehlendem expectedUpdatedAt (kein Baseline)', async () => {
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => { throw new Error('darf nicht laufen'); },
    t: (k) => k,
  };
  assert.equal(await ctx._checkPageConflict(1, null), null);
  assert.equal(await ctx._checkPageConflict(1, ''), null);
  assert.equal(await ctx._checkPageConflict(1, undefined), null);
});

test('_checkPageConflict: returns null bei Read-Fehler (defensiv – kein false positive)', async () => {
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => { throw new Error('network'); },
    t: (k) => k,
  };
  assert.equal(await ctx._checkPageConflict(1, 't1'), null);
});

test('_checkPageConflict: fallback auf null-User wenn updated_by fehlt', async () => {
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => ({ updated_at: 't2', html: '' }),
  };
  const r = await ctx._checkPageConflict(1, 't1');
  assert.equal(r.remoteUserName, null);
});

test('_checkPageConflict: bsGet wird mit fresh:true aufgerufen (umgeht SW-Cache)', async () => {
  let captured = null;
  const ctx = {
    ...bookstackMethods,
    bsGet: async (path, opts) => {
      captured = { path, fresh: !!opts?.fresh };
      return { updated_at: 't1' };
    },
  };
  await ctx._checkPageConflict(42, 't1');
  assert.equal(captured.path, 'pages/42');
  assert.equal(captured.fresh, true,
    'Conflict-Check muss fresh sein, sonst sieht er ggf. den eigenen stale SW-Cache');
});
