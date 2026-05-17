// Unit-Tests fuer lib/content-mapper.js: round-trip BookStack-JSON → Domain-Shape.
// SSoT-Test: wenn BookStack-API jemals Felder umbenennt (oder das localdb-
// Backend das Shape aus lokalen Tabellen baut), faengt dieser Test Drift gegen
// die Vertraege ab, auf die routes/content.js und kuenftige Repo-Konsumenten
// bauen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { mapBook, mapChapter, mapPage, mapPageMeta } = await import('../../lib/content-mapper.js');

test('mapBook extrahiert Pflichtfelder und ignoriert BookStack-Extras', () => {
  const out = mapBook({
    id: 42,
    name: 'Mein Roman',
    slug: 'mein-roman',
    description: 'Klappentext',
    updated_at: '2026-05-16T10:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    owned_by: { id: 1, name: 'Anna' },
    tags: [{ name: 'wip' }],
  });
  assert.deepEqual(out, {
    id: 42,
    name: 'Mein Roman',
    slug: 'mein-roman',
    description: 'Klappentext',
    updated_at: '2026-05-16T10:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  });
});

test('mapBook tolerant gegen fehlende Felder', () => {
  const out = mapBook({ id: 7 });
  assert.equal(out.id, 7);
  assert.equal(out.name, '');
  assert.equal(out.slug, null);
  assert.equal(out.description, '');
});

test('mapBook null/undefined → null', () => {
  assert.equal(mapBook(null), null);
  assert.equal(mapBook(undefined), null);
  assert.equal(mapBook('not an object'), null);
});

test('mapChapter mapt priority auf position', () => {
  const out = mapChapter({
    id: 99,
    book_id: 42,
    name: 'Kapitel 1',
    slug: 'kapitel-1',
    description: '',
    priority: 5,
    updated_at: '2026-05-16T10:00:00.000Z',
  });
  assert.equal(out.id, 99);
  assert.equal(out.book_id, 42);
  assert.equal(out.position, 5);
  assert.equal(out.name, 'Kapitel 1');
});

test('mapChapter position bleibt null wenn priority fehlt', () => {
  const out = mapChapter({ id: 1, book_id: 1, name: 'X' });
  assert.equal(out.position, null);
});

test('mapPageMeta enthaelt keinen Body', () => {
  const out = mapPageMeta({
    id: 100,
    book_id: 42,
    chapter_id: 99,
    name: 'Seite',
    priority: 0,
    html: '<p>sollte nicht im meta sein</p>',
  });
  assert.equal(out.id, 100);
  assert.equal(out.chapter_id, 99);
  assert.equal(out.position, 0);
  assert.equal(out.html, undefined);
});

test('mapPageMeta chapter_id=0 → null (Top-Level-Seite)', () => {
  const out = mapPageMeta({ id: 1, book_id: 1, chapter_id: 0, name: 'Top' });
  assert.equal(out.chapter_id, null);
});

test('mapPage enthaelt html + Meta', () => {
  const out = mapPage({
    id: 100,
    book_id: 42,
    chapter_id: 99,
    name: 'Seite',
    priority: 3,
    html: '<p>Inhalt</p>',
    markdown: '# Inhalt',
    updated_at: '2026-05-16T10:00:00.000Z',
    draft: false,
    template: false,
  });
  assert.equal(out.id, 100);
  assert.equal(out.html, '<p>Inhalt</p>');
  assert.equal(out.markdown, '# Inhalt');
  assert.equal(out.position, 3);
  assert.equal(out.draft, false);
});

test('mapPage tolerant gegen fehlendes html', () => {
  const out = mapPage({ id: 1, book_id: 1, name: 'leer' });
  assert.equal(out.html, '');
  assert.equal(out.markdown, null);
});

test('Mapper ignorieren unbekannte Felder ohne Crash', () => {
  const out = mapPage({
    id: 1, book_id: 1, name: 'x',
    bookstack_specific_field: 'value',
    nested: { foo: 'bar' },
  });
  assert.equal(out.id, 1);
  assert.equal(out.bookstack_specific_field, undefined);
});
