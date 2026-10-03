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
const { listDraftPageIds, writeDraft, clearDraft, readDraft, setDraftOwner } = await import('../../public/js/editor/draft-storage.js');

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

// Zwei Konten nacheinander auf demselben Browser: der Entwurf von A darf B
// weder angezeigt noch von dessen Outbox gespeichert werden — und Bs Entwurf
// derselben Seite darf As nicht überschreiben.
test('Entwürfe sind pro Konto getrennt', () => {
  store.clear();
  setDraftOwner('a@example.com');
  writeDraft(10, '<p>von A</p>', '<p>base</p>', null);
  assert.ok(store.has('editor_draft_u:a@example.com:10'));
  assert.equal(readDraft(10)?.owner, 'a@example.com');

  setDraftOwner('b@example.com');
  assert.equal(readDraft(10), null, 'fremder Entwurf unsichtbar');
  assert.deepEqual(listDraftPageIds(), [], 'fremder Entwurf zählt nicht als wartend');
  writeDraft(10, '<p>von B</p>', '<p>base</p>', null);
  clearDraft(10);

  setDraftOwner('a@example.com');
  assert.equal(readDraft(10)?.html, '<p>von A</p>', 'As Entwurf übersteht Bs Schreiben und Löschen');
  assert.deepEqual(listDraftPageIds(), [10]);
  setDraftOwner(null);
});

test('Alt-Entwurf wird beim Anmelden in den Konto-Schlüssel migriert', () => {
  store.clear();
  store.set('editor_draft_3', JSON.stringify({ html: '<p>alt</p>', originalHtml: '', savedAt: 1 }));
  store.set('editor_draft_4', JSON.stringify({ html: '<p>von A</p>', owner: 'a@example.com', savedAt: 1 }));
  setDraftOwner('b@example.com');
  assert.equal(store.has('editor_draft_3'), false);
  assert.equal(readDraft(3)?.html, '<p>alt</p>', 'ownerloser Alt-Entwurf gehört dem ersten Konto');
  assert.equal(readDraft(4), null, 'Alt-Entwurf mit owner bleibt dessen Konto');
  assert.ok(store.has('editor_draft_u:a@example.com:4'));
  assert.deepEqual(listDraftPageIds(), [3]);
  setDraftOwner(null);
});

test('Migration scheitert an Quota → Alt-Entwurf bleibt les- und löschbar', () => {
  store.clear();
  store.set('editor_draft_8', JSON.stringify({ html: '<p>alt</p>', savedAt: 1 }));
  const orig = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('quota'); };
  try { setDraftOwner('b@example.com'); } finally { globalThis.localStorage.setItem = orig; }
  assert.ok(store.has('editor_draft_8'), 'nichts verloren');
  assert.equal(readDraft(8)?.html, '<p>alt</p>');
  assert.deepEqual(listDraftPageIds(), [8]);
  clearDraft(8);
  assert.equal(store.has('editor_draft_8'), false);
  setDraftOwner(null);
});
