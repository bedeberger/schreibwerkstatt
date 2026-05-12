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

// ── revision_count-Check (Sub-Sekunden-Konflikt-Erkennung) ─────────────────

test('_checkPageConflict: erkennt Sub-Sekunden-Konflikt via revision_count', async () => {
  // updated_at matcht (selbe Sekunde), aber revision_count divergiert →
  // Fremd-Save passierte innerhalb derselben Sekunde wie unser Snapshot.
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => ({
      id: 1,
      updated_at: 't1',
      revision_count: 8,
      html: '<p>fremd</p>',
      updated_by: { name: 'Bob' },
    }),
    t: (k) => k,
  };
  const r = await ctx._checkPageConflict(1, 't1', 7);
  assert.ok(r, 'Konflikt muss erkannt werden trotz updated_at-Match');
  assert.equal(r.remoteRevisionCount, 8);
  assert.equal(r.remoteUserName, 'Bob');
});

test('_checkPageConflict: kein Konflikt wenn updated_at und revision_count matchen', async () => {
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => ({ id: 1, updated_at: 't1', revision_count: 7, html: '' }),
    t: (k) => k,
  };
  assert.equal(await ctx._checkPageConflict(1, 't1', 7), null);
});

test('_checkPageConflict: revision_count optional (legacy Aufrufer ohne Snapshot)', async () => {
  // Kein erwarteter rev_count → fällt zurück auf reinen updated_at-Vergleich.
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => ({ id: 1, updated_at: 't1', revision_count: 5, html: '' }),
    t: (k) => k,
  };
  assert.equal(await ctx._checkPageConflict(1, 't1'), null);
  assert.equal(await ctx._checkPageConflict(1, 't1', null), null);
});

test('_checkPageConflict: remote ohne revision_count → kein false positive', async () => {
  // BookStack-Version ohne revision_count im Response → Vergleich soll nicht
  // wegen `undefined !== 7` Konflikt melden.
  const ctx = {
    ...bookstackMethods,
    bsGet: async () => ({ id: 1, updated_at: 't1', html: '' }),
    t: (k) => k,
  };
  assert.equal(await ctx._checkPageConflict(1, 't1', 7), null);
});

// ── Server-OCC-Pfad (bsPut mit ifMatchRevision-Option) ─────────────────────

test('_bsWrite: opts.ifMatchRevision setzt X-If-Match-Revision-Header', async () => {
  let capturedHeaders = null;
  globalThis.fetch = async (url, init) => {
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify({ id: 1, updated_at: 't2', revision_count: 8 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const ctx = { ...bookstackMethods, t: (k) => k };
  await ctx.bsPut('pages/1', { html: 'x', name: 'N' }, { ifMatchRevision: 7 });
  assert.equal(capturedHeaders['X-If-Match-Revision'], '7',
    'Header muss mit erwartetem rev_count gesetzt sein, sonst greift Server-OCC nicht');
});

test('_bsWrite: 412 wird als PRECONDITION_FAILED mit remote-Info propagiert', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    error_code: 'BOOKSTACK_REVISION_MISMATCH',
    remote: { revisionCount: 9, updatedAt: 't3', userName: 'Carol' },
  }), { status: 412, headers: { 'Content-Type': 'application/json' } });
  const ctx = { ...bookstackMethods, t: (k) => k };
  await assert.rejects(
    () => ctx.bsPut('pages/1', { html: 'x' }, { ifMatchRevision: 7 }),
    (err) => {
      assert.equal(err.code, 'PRECONDITION_FAILED');
      assert.equal(err.remote.revisionCount, 9);
      assert.equal(err.remote.userName, 'Carol');
      return true;
    },
  );
});

test('_bsWrite: ohne ifMatchRevision-Option wird kein OCC-Header gesetzt', async () => {
  let capturedHeaders = null;
  globalThis.fetch = async (url, init) => {
    capturedHeaders = init?.headers;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const ctx = { ...bookstackMethods, t: (k) => k };
  await ctx.bsPut('pages/1', { html: 'x' });
  assert.equal(capturedHeaders['X-If-Match-Revision'], undefined,
    'Ohne Option: kein Header — sonst würden Overwrite-Bestätigungen blockiert');
});
