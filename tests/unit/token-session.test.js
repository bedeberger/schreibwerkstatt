'use strict';
// Token-Requests (sw_ Metrics, swd_ Device) duerfen keine Session persistieren
// und kein Session-Cookie setzen — sonst eine `sessions`-Zeile pro Request.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmp = useTmpDb('token-session');

require('../../db/schema');
const express = require('express');
const session = require('express-session');
const { tokenAwareSession, hasTokenBearer, createEphemeralSession } = require('../../lib/token-session');

function countingStore() {
  const store = new session.MemoryStore();
  store.writes = 0;
  const origSet = store.set.bind(store);
  store.set = (sid, sess, cb) => { store.writes++; return origSet(sid, sess, cb); };
  return store;
}

async function withApp(store, fn) {
  const app = express();
  app.use(tokenAwareSession(session({
    store, secret: 'test', resave: false, saveUninitialized: false,
  })));
  // Wie bearer-auth/Device-Auth: User auf die Session setzen.
  app.get('/x', (req, res) => {
    req.session.user = { email: 'a@x.test', via: 'test' };
    res.json({ ephemeral: req.session.ephemeral === true });
  });
  app.get('/destroy', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

test('hasTokenBearer: nur sw_/swd_-Bearer', () => {
  const req = (h) => ({ headers: h ? { authorization: h } : {} });
  assert.equal(hasTokenBearer(req('Bearer sw_abc')), true);
  assert.equal(hasTokenBearer(req('Bearer swd_abc')), true);
  assert.equal(hasTokenBearer(req('Bearer other_abc')), false);
  assert.equal(hasTokenBearer(req('Basic xyz')), false);
  assert.equal(hasTokenBearer(req(null)), false);
});

test('Token-Request: keine Store-Zeile, kein Set-Cookie', async () => {
  const store = countingStore();
  await withApp(store, async (base) => {
    for (const tok of ['sw_abc', 'swd_abc']) {
      const r = await fetch(`${base}/x`, { headers: { authorization: `Bearer ${tok}` } });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ephemeral: true });
      assert.equal(r.headers.get('set-cookie'), null);
    }
  });
  assert.equal(store.writes, 0);
});

test('Token-Request ignoriert ein mitgeschicktes Session-Cookie', async () => {
  const store = countingStore();
  await withApp(store, async (base) => {
    const first = await fetch(`${base}/x`);
    const cookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal(store.writes, 1);
    const r = await fetch(`${base}/x`, { headers: { cookie, authorization: 'Bearer swd_abc' } });
    assert.deepEqual(await r.json(), { ephemeral: true });
  });
  assert.equal(store.writes, 1);
});

test('Browser-Request ohne Token: normale Session wie bisher', async () => {
  const store = countingStore();
  await withApp(store, async (base) => {
    const r = await fetch(`${base}/x`);
    assert.deepEqual(await r.json(), { ephemeral: false });
    assert.match(r.headers.get('set-cookie') || '', /connect\.sid=/);
  });
  assert.equal(store.writes, 1);
});

test('Ephemere Session: destroy/save rufen den Callback', async () => {
  const s = createEphemeralSession();
  await new Promise(r => s.destroy(r));
  await new Promise(r => s.save(r));
  s.user = { email: 'a@x.test' };
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { user: { email: 'a@x.test' } });
  const store = countingStore();
  await withApp(store, async (base) => {
    const r = await fetch(`${base}/destroy`, { headers: { authorization: 'Bearer swd_abc' } });
    assert.deepEqual(await r.json(), { ok: true });
  });
});
