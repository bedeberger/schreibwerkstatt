// routes/jobs/pdf-export-results.js (TTL + Byte-Deckel mit LRU) und die
// reinen Helfer des PDF-Export-Jobs (Probeseiten-Kuerzung, Render-Hinweise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

// Das Job-Modul zieht DB-Module — Wegwerf-DB vor dem ersten require.
useTmpDb('pdf-export-results');
const require = createRequire(import.meta.url);
const { createResultStore } = require('../../routes/jobs/pdf-export-results');

const buf = (n) => Buffer.alloc(n, 1);

test('Byte-Deckel: aelteste (am laengsten nicht abgeholte) Eintraege fallen zuerst', () => {
  const s = createResultStore({ maxBytes: 100 });
  s.set('a', { buffer: buf(40), mime: 'application/pdf', filename: 'a.pdf' });
  s.set('b', { buffer: buf(40), mime: 'application/pdf', filename: 'b.pdf' });
  assert.ok(s.get('a'));          // a frisch abgeholt → b ist jetzt LRU
  s.set('c', { buffer: buf(40), mime: 'application/pdf', filename: 'c.pdf' });
  assert.equal(s.get('b'), null);
  assert.ok(s.get('a'));
  assert.ok(s.get('c'));
  assert.equal(s.totalBytes, 80);
  s.clear();
});

test('Abholen loescht nicht; Eintrag groesser als der Deckel bleibt allein liegen', () => {
  const s = createResultStore({ maxBytes: 50 });
  s.set('a', { buffer: buf(10), mime: 'm', filename: 'a' });
  assert.ok(s.get('a'));
  assert.ok(s.get('a'));
  s.set('big', { buffer: buf(80), mime: 'm', filename: 'big' });
  assert.equal(s.get('a'), null);
  assert.ok(s.get('big'));
  assert.equal(s.size, 1);
  s.clear();
});

test('TTL: abgelaufener Eintrag liefert null', () => {
  let t = 1000;
  const s = createResultStore({ ttlMs: 50, now: () => t });
  s.set('a', { buffer: buf(1), mime: 'm', filename: 'a' });
  assert.ok(s.get('a'));
  t += 51;
  assert.equal(s.get('a'), null);
  assert.equal(s.totalBytes, 0);
  s.clear();
});

test('sampleGroups: Buch → erstes Top-Level-Kapitel samt Unterkapiteln, ohne kapitellose Vorseiten', () => {
  require('../../db/migrations');
  const { sampleGroups, renderWarningsFromMeta } = require('../../routes/jobs/pdf-export');
  const g = (id, parent = null) => ({ chapterId: id, chapter: { id, parent_chapter_id: parent }, pages: [{}] });
  const loose = { chapterId: null, chapter: null, pages: [{}] };
  // A hat keine eigenen Seiten (taucht nicht als Gruppe auf), A1/A2 schon.
  const groups = [loose, g(11, 1), g(12, 1), g(2), g(21, 2)];
  assert.deepEqual(sampleGroups(groups, 'book').map(x => x.chapterId), [11, 12]);
  // A mit eigenen Seiten.
  assert.deepEqual(sampleGroups([g(1), g(11, 1), g(2)], 'book').map(x => x.chapterId), [1, 11]);
  assert.deepEqual(sampleGroups([g(5), g(51, 5)], 'chapter').map(x => x.chapterId), [5]);
  assert.equal(sampleGroups([loose], 'book').length, 1);
  assert.equal(sampleGroups(groups, 'page'), groups);

  const w = renderWarningsFromMeta({ dpiWarnings: [{ dpi: 100 }], fontFallbacks: [{ role: 'title', requested: 'X', used: 'Lora' }], footnoteOverflowPages: 2 });
  assert.equal(w.dpiWarnings.length, 1);
  assert.equal(w.fontFallbacks[0].used, 'Lora');
  assert.equal(w.footnoteOverflowPages, 2);
  assert.equal(w.oversizeImages, 0);
  assert.equal(w.footnoteFallback, false);
  assert.deepEqual(renderWarningsFromMeta().xrefUnresolved, []);
});
