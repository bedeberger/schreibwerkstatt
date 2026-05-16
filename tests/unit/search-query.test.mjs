// Phase 7 (BookStack-Exit): Unit-Tests fuer lib/search.js Query-Parser +
// HTML-Text-Normalisierung. Voller Index-Flow wird in der Integration getestet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'search-query-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    search: require_('../../lib/search'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch (_e) {} },
  };
}

test('buildMatchQuery: Single-Token sanitized + quoted', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('hallo'), '"hallo"');
    assert.equal(search.buildMatchQuery('  hallo  '), '"hallo"');
  } finally { teardown(); }
});

test('buildMatchQuery: AND-Verkettung mehrerer Tokens', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('alpha beta'), '"alpha" "beta"');
  } finally { teardown(); }
});

test('buildMatchQuery: Phrase mit Anfuehrungszeichen', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('"hallo welt"'), '"hallo welt"');
    assert.equal(search.buildMatchQuery('alpha "hallo welt" beta'),
      '"hallo welt" "alpha" "beta"');
  } finally { teardown(); }
});

test('buildMatchQuery: Negation via -prefix', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('alpha -beta'), '"alpha" -"beta"');
  } finally { teardown(); }
});

test('buildMatchQuery: Prefix-Match via trailing *', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('schwert*'), '"schwert"*');
  } finally { teardown(); }
});

test('buildMatchQuery: Spezialzeichen werden gestrippt — kein FTS5-Syntax-Error', () => {
  const { search, teardown } = _bootstrap();
  try {
    // SQL-Syntax-Versuch: Quote + Semicolon + AND-Operator. Alles raus.
    const out = search.buildMatchQuery(`'; DROP TABLE search_index; --`);
    assert.match(out, /^"DROP" "TABLE" "search_index"$/);
    // Klammer/Punkt/Komma werden gestrippt.
    assert.equal(search.buildMatchQuery('(alpha, beta).'), '"alpha" "beta"');
  } finally { teardown(); }
});

test('buildMatchQuery: leere/zu kurze Tokens werden verworfen', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery(''), '');
    assert.equal(search.buildMatchQuery('   '), '');
    // Einzelner Buchstabe < 2 Zeichen.
    assert.equal(search.buildMatchQuery('a b cd'), '"cd"');
  } finally { teardown(); }
});

test('htmlToText: identisch zu sync/page-revisions Normalisierung', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.htmlToText('<p>Hallo  <b>Welt</b></p>'), 'Hallo Welt');
    assert.equal(search.htmlToText('<p>A</p><p>B</p>'), 'A B');
    assert.equal(search.htmlToText('  '), '');
    assert.equal(search.htmlToText(null), '');
    assert.equal(search.htmlToText(undefined), '');
  } finally { teardown(); }
});

test('query: Empty-Input liefert leere Hits', () => {
  const { search, teardown } = _bootstrap();
  try {
    const r1 = search.query('');
    assert.deepEqual(r1, { hits: [], fallback: false });
    const r2 = search.query('   ');
    assert.deepEqual(r2, { hits: [], fallback: false });
  } finally { teardown(); }
});

test('query: book_id-Filter geht durch + Empty-allowedBookIds short-circuits', () => {
  const { search, teardown } = _bootstrap();
  try {
    // Bei leerer Allowlist (kein Buch-Zugang) keine Treffer.
    const r = search.query('hallo', { allowedBookIds: [] });
    assert.deepEqual(r, { hits: [], fallback: false });
  } finally { teardown(); }
});
