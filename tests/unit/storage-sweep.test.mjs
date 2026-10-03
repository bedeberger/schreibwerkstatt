// storage-sweep.js: entfernt nur, was nachweislich verwaist ist.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const map = new Map();
globalThis.localStorage = {
  get length() { return map.size; },
  key(i) { return [...map.keys()][i] ?? null; },
  getItem(k) { return map.has(k) ? map.get(k) : null; },
  setItem(k, v) { map.set(k, String(v)); },
  removeItem(k) { map.delete(k); },
};

const { findStaleJobKeys, findOrphanBookKeys, sweepStaleJobKeys, sweepOrphanBookKeys } =
  await import('../../public/js/storage-sweep.js');

const J1 = '11111111-1111-4111-8111-111111111111';
const J2 = '22222222-2222-4222-8222-222222222222';

test('findStaleJobKeys: nur Job-Merker mit UUID-Wert, die nicht aktiv sind', () => {
  const entries = [
    ['lektorat_check_job_5', J1],
    ['lektorat_review_job_2', J2],
    ['rueckblick_job_2_woche', J1],
    ['interview_job_9', 'kein-uuid'],
    ['sw:filters:a@x:2:plot', J1],
  ];
  assert.deepEqual(findStaleJobKeys(entries, [J2]), ['lektorat_check_job_5', 'rueckblick_job_2_woche']);
});

test('findOrphanBookKeys: nur Prefs des eigenen Kontos zu fehlenden Büchern', () => {
  const keys = [
    'sw:lastPage:a@x:1', 'sw:lastPage:a@x:2',
    'sw:filters:a@x:2:plot', 'sw:filters:a@x:1:plot',
    'sw:treeOpen:a@x:2', 'sw:diaryAnniversaryOpen:a@x:2',
    'sw:snapshotDrift:dismissed:2',
    'sw:lastPage:b@x:2',          // anderes Konto
    'sw:userpref:a@x:metric',     // buchunabhängig
    'sw:lastBookId:a@x',
  ];
  assert.deepEqual(findOrphanBookKeys(keys, 'a@x', [1]), [
    'sw:lastPage:a@x:2', 'sw:filters:a@x:2:plot', 'sw:treeOpen:a@x:2',
    'sw:diaryAnniversaryOpen:a@x:2', 'sw:snapshotDrift:dismissed:2',
  ]);
});

test('sweepStaleJobKeys: währenddessen neu gesetzter Merker bleibt stehen', async () => {
  map.clear();
  map.set('lektorat_check_job_5', J1);
  map.set('struktur_job_3', J1);
  map.set('lektorat_review_job_2', J2);
  const n = await sweepStaleJobKeys(async () => {
    map.set('struktur_job_3', J2.replace('2222-4', '3333-4')); // neuer Job gestartet
    return [{ id: J2 }];
  });
  assert.equal(n, 1);
  assert.deepEqual([...map.keys()].sort(), ['lektorat_review_job_2', 'struktur_job_3']);
});

test('sweepStaleJobKeys: Fehler oder Nicht-Array → nichts entfernt', async () => {
  map.clear();
  map.set('lektorat_check_job_5', J1);
  assert.equal(await sweepStaleJobKeys(async () => { throw new Error('offline'); }), 0);
  assert.equal(await sweepStaleJobKeys(async () => ({ error: 'x' })), 0);
  assert.ok(map.has('lektorat_check_job_5'));
});

test('sweepOrphanBookKeys: leere Buchliste ist kein Beleg', () => {
  map.clear();
  map.set('sw:lastPage:a@x:2', '7');
  assert.equal(sweepOrphanBookKeys('a@x', []), 0);
  assert.equal(sweepOrphanBookKeys('a@x', [{ id: 1 }]), 1);
  assert.equal(map.size, 0);
});
