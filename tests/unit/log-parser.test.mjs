// log-parser: winston-Format-Roundtrip, Stack-Trace-Append, malformed-Skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseBuffer } = require('../../lib/log-parser');

test('parses header line with full tag', () => {
  const text = '2026-05-20 12:34:56 [INFO] [lektorat|alice@example.com|42|abc12345] check started';
  const [e] = parseBuffer(text);
  assert.equal(e.ts, '2026-05-20 12:34:56');
  assert.equal(e.level, 'info');
  assert.equal(e.scope, 'lektorat');
  assert.equal(e.user, 'alice@example.com');
  assert.equal(e.book, '42');
  assert.equal(e.jobId, 'abc12345');
  assert.equal(e.msg, 'check started');
  assert.equal(e.stack, null);
});

test('handles missing jobId slot', () => {
  const text = '2026-05-20 12:34:56 [WARN] [http|-|-] page load failed';
  const [e] = parseBuffer(text);
  assert.equal(e.level, 'warn');
  assert.equal(e.scope, 'http');
  assert.equal(e.user, null);
  assert.equal(e.book, null);
  assert.equal(e.jobId, null);
  assert.equal(e.msg, 'page load failed');
});

test('appends stack-trace lines to previous entry', () => {
  const text = [
    '2026-05-20 12:34:56 [ERROR] [lektorat|alice@example.com|42] boom',
    'Error: something went wrong',
    '    at foo (/srv/app/x.js:1:1)',
    '    at bar (/srv/app/y.js:2:2)',
    '2026-05-20 12:35:00 [INFO] [http|-|-] next entry',
  ].join('\n');
  const entries = parseBuffer(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].stack, [
    'Error: something went wrong',
    '    at foo (/srv/app/x.js:1:1)',
    '    at bar (/srv/app/y.js:2:2)',
  ]);
  assert.equal(entries[1].msg, 'next entry');
});

test('skips malformed lines without a pending header', () => {
  const text = [
    'garbage line without timestamp',
    '2026-05-20 12:34:56 [INFO] [app|-|-] ok',
  ].join('\n');
  const entries = parseBuffer(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].msg, 'ok');
});

test('all level variants', () => {
  for (const lvl of ['INFO', 'WARN', 'ERROR', 'DEBUG']) {
    const text = `2026-05-20 12:00:00 [${lvl}] [app|-|-] m`;
    const [e] = parseBuffer(text);
    assert.equal(e.level, lvl.toLowerCase());
  }
});

test('preserves message with brackets and pipes', () => {
  const text = '2026-05-20 12:34:56 [INFO] [app|-|-] foo [bar] baz | qux';
  const [e] = parseBuffer(text);
  assert.equal(e.msg, 'foo [bar] baz | qux');
});
