// safe-storage.js: kein Griff darf werfen — weder bei gesperrtem Speicher
// (der Zugriff auf `localStorage` selbst wirft, Safari Private Mode /
// blockierte Site-Daten) noch bei vollem Speicher (setItem wirft).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { lsGet, lsSet, lsRemove, lsGetJSON, lsSetJSON, lsKeys } = await import('../../public/js/safe-storage.js');

function withStorage(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...value });
  try { fn(); }
  finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
}

function mapStorage() {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

test('Round-Trip mit funktionierendem Speicher', () => {
  const s = mapStorage();
  withStorage({ value: s }, () => {
    assert.equal(lsSet('a', 1), true);
    assert.equal(lsGet('a'), '1');
    assert.equal(lsSetJSON('j', { x: [1] }), true);
    assert.deepEqual(lsGetJSON('j'), { x: [1] });
    assert.deepEqual(lsKeys('j'), ['j']);
    lsRemove('a');
    assert.equal(lsGet('a'), null);
  });
});

test('gesperrter Speicher: der Getter selbst wirft', () => {
  withStorage({ get() { throw new Error('SecurityError'); } }, () => {
    assert.equal(lsGet('a'), null);
    assert.equal(lsSet('a', 'x'), false);
    assert.doesNotThrow(() => lsRemove('a'));
    assert.equal(lsGetJSON('a', 'fb'), 'fb');
    assert.deepEqual(lsKeys(), []);
  });
});

test('voller Speicher: setItem wirft → false, kein Throw', () => {
  const s = mapStorage();
  s.setItem = () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; };
  withStorage({ value: s }, () => {
    assert.equal(lsSet('a', 'x'), false);
    assert.equal(lsSetJSON('a', { y: 1 }), false);
  });
});

test('kaputtes JSON → Fallback', () => {
  const s = mapStorage();
  s.map.set('j', '{nope');
  withStorage({ value: s }, () => {
    assert.equal(lsGetJSON('j', 42), 42);
  });
});
