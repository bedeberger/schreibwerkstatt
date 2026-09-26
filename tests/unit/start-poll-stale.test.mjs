// startPoll: ein Tick, der beim Abräumen schon unterwegs war, darf nichts mehr
// anfassen — weder onDone/onProgress (Ergebnis des alten Buchs in der Karte des
// neuen) noch den Handle/lsKey eines Nachfolge-Pollers auf demselben timerProp.
import test from 'node:test';
import assert from 'node:assert/strict';

const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
globalThis.window = globalThis.window || {};

const { startPoll } = await import('../../public/js/cards/job-helpers.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch, dessen Antworten der Test von Hand freigibt.
function deferredFetch() {
  const pending = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));
  return {
    pending,
    release(job) {
      const r = pending.shift();
      r({ ok: true, status: 200, json: async () => job });
    },
  };
}

test('extern geclearter Timer: fliegender Tick ruft onDone nicht mehr', async () => {
  const f = deferredFetch();
  const ctx = { _t: null };
  let doneCalls = 0;
  startPoll(ctx, { timerProp: '_t', jobId: 1, intervalMs: 5, onDone: () => { doneCalls++; } });
  await sleep(15);
  assert.ok(f.pending.length >= 1, 'Tick sollte unterwegs sein');
  clearInterval(ctx._t); ctx._t = null; // wie card-lifecycle clearTimers
  f.release({ status: 'done', result: {} });
  await sleep(5);
  assert.equal(doneCalls, 0);
});

test('Nachfolge-Poller: alter Terminal-Tick räumt weder Handle noch lsKey des neuen', async () => {
  const f = deferredFetch();
  const ctx = { _t: null };
  let oldDone = 0;
  startPoll(ctx, { timerProp: '_t', jobId: 1, lsKey: 'k', intervalMs: 5, onDone: () => { oldDone++; } });
  await sleep(15);
  assert.ok(f.pending.length >= 1);
  const oldResolve = f.pending.shift();
  // Nachfolger übernimmt denselben timerProp (startPoll cleart den alten Timer).
  localStorage.setItem('k', 'new-job');
  startPoll(ctx, { timerProp: '_t', jobId: 2, lsKey: 'k', intervalMs: 100000 });
  const successor = ctx._t;
  oldResolve({ ok: true, status: 200, json: async () => ({ status: 'done' }) });
  await sleep(5);
  assert.equal(oldDone, 0);
  assert.equal(ctx._t, successor, 'Handle des Nachfolgers wurde genullt');
  assert.equal(localStorage.getItem('k'), 'new-job', 'lsKey des Nachfolgers entfernt');
  clearInterval(ctx._t);
});

test('regulärer Terminal-Tick: onDone einmal, Handle + lsKey geräumt', async () => {
  const f = deferredFetch();
  const ctx = { _t: null };
  localStorage.setItem('k2', 'job');
  let doneCalls = 0;
  startPoll(ctx, { timerProp: '_t', jobId: 3, lsKey: 'k2', intervalMs: 5, onDone: () => { doneCalls++; } });
  await sleep(15);
  while (f.pending.length) f.release({ status: 'done' });
  await sleep(5);
  assert.equal(doneCalls, 1);
  assert.equal(ctx._t, null);
  assert.equal(localStorage.getItem('k2'), null);
});
