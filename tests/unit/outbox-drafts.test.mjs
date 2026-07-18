// listDraftPageIds() — Basis für Reconnect-Outbox + Pending-Sync-Zähler.
// Reine localStorage-Iteration, hier gegen einen Map-Stub getestet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Map-backed localStorage-Stub (length + key(i) + get/set/remove), gesetzt
// bevor draft-storage.js importiert wird. `window` bleibt undefined → das
// draft:changed-Event ist ein No-op (guarded), stört Node also nicht.
function installLocalStorage() {
  const map = new Map();
  globalThis.localStorage = {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
  return map;
}

const store = installLocalStorage();
const { listDraftPageIds, writeDraft, clearDraft } = await import('../../public/js/editor/draft-storage.js');

test('leerer Store → keine Draft-IDs', () => {
  store.clear();
  assert.deepEqual(listDraftPageIds(), []);
});

test('nur editor_draft_<n>-Keys werden als IDs erkannt', () => {
  store.clear();
  store.set('editor_draft_5', '{}');
  store.set('editor_draft_12', '{}');
  store.set('some_other_key', 'x');
  store.set('editor_draft_abc', '{}'); // nicht-numerisch → ignoriert
  store.set('normal.snapshot', '{}');
  assert.deepEqual(listDraftPageIds().sort((a, b) => a - b), [5, 12]);
});

test('writeDraft fügt eine ID hinzu, clearDraft entfernt sie', () => {
  store.clear();
  writeDraft(42, '<p>hi</p>', '<p>base</p>', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(listDraftPageIds(), [42]);
  clearDraft(42);
  assert.deepEqual(listDraftPageIds(), []);
});

test('IDs sind Numbers (nicht Strings) für den identischen Vergleich mit currentPage.id', () => {
  store.clear();
  writeDraft(7, '<p>x</p>', '', null);
  const ids = listDraftPageIds();
  assert.equal(typeof ids[0], 'number');
  assert.equal(ids[0], 7);
});

test('writeDraft liefert true bei Erfolg, false bei Quota-Fehler', () => {
  store.clear();
  assert.equal(writeDraft(1, '<p>ok</p>', '', null), true);
  // localStorage voll simulieren: setItem wirft QuotaExceededError.
  const orig = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; };
  try {
    assert.equal(writeDraft(2, '<p>zu gross</p>', '', null), false);
  } finally {
    globalThis.localStorage.setItem = orig;
  }
  // Der fehlgeschlagene Draft darf nicht als vorhanden gelten.
  assert.deepEqual(listDraftPageIds(), [1]);
});
