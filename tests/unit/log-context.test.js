'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithContext, getContext, setContext, bookParamHandler } = require('../../lib/log-context');

test('setContext mutiert Store innerhalb runWithContext', () => {
  runWithContext({ job: 'http', user: 'a@b.c' }, () => {
    assert.equal(getContext().book, undefined);
    setContext({ book: 42 });
    assert.equal(getContext().book, 42);
    assert.equal(getContext().user, 'a@b.c');
  });
});

test('setContext ausserhalb runWithContext = no-op', () => {
  setContext({ book: 99 });
  assert.equal(getContext().book, undefined);
});

test('setContext überschreibt vorhandene Felder', () => {
  runWithContext({ book: 1 }, () => {
    setContext({ book: 2 });
    assert.equal(getContext().book, 2);
  });
});

test('bookParamHandler setzt book in Context', () => {
  runWithContext({ job: 'http' }, () => {
    let nextCalled = false;
    bookParamHandler({}, {}, () => { nextCalled = true; }, '603');
    assert.equal(nextCalled, true);
    assert.equal(getContext().book, 603);
  });
});

test('bookParamHandler ignoriert invalid IDs', () => {
  runWithContext({ job: 'http' }, () => {
    bookParamHandler({}, {}, () => {}, 'abc');
    assert.equal(getContext().book, undefined);
    bookParamHandler({}, {}, () => {}, '0');
    assert.equal(getContext().book, undefined);
  });
});

test('bookParamHandler ruft next() immer', () => {
  let calls = 0;
  bookParamHandler({}, {}, () => { calls++; }, 'invalid');
  bookParamHandler({}, {}, () => { calls++; }, '42');
  assert.equal(calls, 2);
});
