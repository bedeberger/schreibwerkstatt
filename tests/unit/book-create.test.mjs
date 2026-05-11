// Unit-Tests fuer bookCreateMethods (public/js/book-create.js):
//   - open/cancel-Reset
//   - leerer Name → errorEmpty, kein Fetch
//   - Erfolg: POST /books, loadBooks aufgerufen, selectedBookId gesetzt,
//     toggleBookSettingsCard ausgeloest, Modal geschlossen
//   - Fehler (server detail): bookCreateError gesetzt mit Detail-Text
//   - bookCreateBusy verhindert doppeltes submit/cancel

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { bookCreateMethods } = await import('../../public/js/book-create.js');

function makeCtx(overrides = {}) {
  return {
    bookCreateOpen: false,
    bookCreateName: '',
    bookCreateBusy: false,
    bookCreateError: '',
    selectedBookId: '',
    showBookSettingsCard: false,
    _toggleCalls: 0,
    _loadBooksCalls: 0,
    t(key, params) {
      if (key === 'book.create.errorEmpty') return 'Bitte Titel eingeben.';
      if (key === 'book.create.errorGeneric') return `Erstellen fehlgeschlagen: ${params?.msg || ''}`;
      return key;
    },
    $nextTick(fn) { fn?.(); },
    async loadBooks() { this._loadBooksCalls++; },
    toggleBookSettingsCard() {
      this._toggleCalls++;
      this.showBookSettingsCard = !this.showBookSettingsCard;
    },
    ...overrides,
    openCreateBook: bookCreateMethods.openCreateBook,
    cancelCreateBook: bookCreateMethods.cancelCreateBook,
    submitCreateBook: bookCreateMethods.submitCreateBook,
  };
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  };
  return calls;
}

test('openCreateBook setzt Defaults und oeffnet Modal', () => {
  const ctx = makeCtx({ bookCreateName: 'old', bookCreateError: 'err' });
  ctx.openCreateBook();
  assert.equal(ctx.bookCreateOpen, true);
  assert.equal(ctx.bookCreateName, '');
  assert.equal(ctx.bookCreateError, '');
  assert.equal(ctx.bookCreateBusy, false);
});

test('cancelCreateBook schliesst und setzt zurueck — nur wenn nicht busy', () => {
  const ctx = makeCtx({ bookCreateOpen: true, bookCreateName: 'X', bookCreateError: 'E' });
  ctx.cancelCreateBook();
  assert.equal(ctx.bookCreateOpen, false);
  assert.equal(ctx.bookCreateName, '');
  assert.equal(ctx.bookCreateError, '');

  const busy = makeCtx({ bookCreateOpen: true, bookCreateBusy: true, bookCreateName: 'X' });
  busy.cancelCreateBook();
  assert.equal(busy.bookCreateOpen, true, 'cancel im busy-State ist no-op');
  assert.equal(busy.bookCreateName, 'X');
});

test('submitCreateBook ohne Name → errorEmpty, kein Fetch', async () => {
  const ctx = makeCtx({ bookCreateName: '   ' });
  const calls = mockFetch(() => { throw new Error('soll nicht aufgerufen werden'); });
  await ctx.submitCreateBook();
  assert.equal(ctx.bookCreateError, 'Bitte Titel eingeben.');
  assert.equal(ctx.bookCreateBusy, false);
  assert.equal(calls.length, 0);
});

test('submitCreateBook erfolgreich → loadBooks, selectedBookId, toggleBookSettings, close', async () => {
  const ctx = makeCtx({ bookCreateOpen: true, bookCreateName: 'Mein Roman' });
  mockFetch(async () => new Response(JSON.stringify({ id: 42, name: 'Mein Roman' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
  await ctx.submitCreateBook();
  assert.equal(ctx._loadBooksCalls, 1);
  assert.equal(ctx.selectedBookId, '42');
  assert.equal(ctx._toggleCalls, 1, 'Book-Settings-Karte oeffnen');
  assert.equal(ctx.showBookSettingsCard, true);
  assert.equal(ctx.bookCreateOpen, false);
  assert.equal(ctx.bookCreateError, '');
  assert.equal(ctx.bookCreateBusy, false);
});

test('submitCreateBook bei bereits geoeffneter BookSettings → kein Re-Toggle', async () => {
  const ctx = makeCtx({
    bookCreateOpen: true, bookCreateName: 'X',
    showBookSettingsCard: true,
  });
  mockFetch(async () => new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  await ctx.submitCreateBook();
  assert.equal(ctx._toggleCalls, 0, 'nicht erneut toggeln wenn schon offen');
});

test('submitCreateBook Server-Fehler → errorGeneric mit detail', async () => {
  const ctx = makeCtx({ bookCreateOpen: true, bookCreateName: 'Bad' });
  mockFetch(async () => new Response(JSON.stringify({ error_code: 'CREATE_FAILED', detail: 'BookStack abgelehnt' }), {
    status: 500, headers: { 'Content-Type': 'application/json' },
  }));
  await ctx.submitCreateBook();
  assert.match(ctx.bookCreateError, /BookStack abgelehnt/);
  assert.equal(ctx.bookCreateOpen, true, 'Modal bleibt offen bei Fehler');
  assert.equal(ctx.bookCreateBusy, false);
});

test('submitCreateBook bei laufendem Submit → no-op', async () => {
  const ctx = makeCtx({ bookCreateOpen: true, bookCreateName: 'X', bookCreateBusy: true });
  const calls = mockFetch(() => { throw new Error('soll nicht aufgerufen werden'); });
  await ctx.submitCreateBook();
  assert.equal(calls.length, 0);
});
