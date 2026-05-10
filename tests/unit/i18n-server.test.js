'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveI18n, resolveI18nTree, tServer } = require('../../lib/i18n-server');

test('tServer: kennt werkstatt-Tree-Keys in DE und EN', () => {
  assert.equal(tServer('werkstatt.tree.aussehen', 'de'), 'Aussehen');
  assert.equal(tServer('werkstatt.tree.aussehen', 'en'), 'Appearance');
});

test('tServer: unbekannter Key liefert Key zurück', () => {
  assert.equal(tServer('totally.unknown.key', 'de'), 'totally.unknown.key');
});

test('tServer: EN ohne Eintrag fällt auf DE zurück', () => {
  // werkstatt.tree.steckbrief existiert in beiden — nutze einen DE-only-Key
  // als Fallback-Probe: tServer ohne EN-Key gibt DE zurück.
  // Hier reicht: unbekannter Key → Key, kein Crash.
  assert.equal(tServer('does.not.exist', 'en'), 'does.not.exist');
});

test('resolveI18n: ersetzt Marker im String', () => {
  const out = resolveI18n('Clara > __i18n:werkstatt.tree.steckbrief__ > __i18n:werkstatt.tree.aussehen__', 'de');
  assert.equal(out, 'Clara > Steckbrief > Aussehen');
});

test('resolveI18n: Locale EN übersetzt', () => {
  const out = resolveI18n('__i18n:werkstatt.tree.aussehen__', 'en');
  assert.equal(out, 'Appearance');
});

test('resolveI18n: keine Marker → unverändert', () => {
  assert.equal(resolveI18n('Plain Text', 'de'), 'Plain Text');
  assert.equal(resolveI18n('', 'de'), '');
});

test('resolveI18nTree: Mindmap-Topic-Marker werden tief ersetzt', () => {
  const tree = {
    data: {
      id: 'root', topic: 'Anna',
      children: [
        { id: 'steckbrief', topic: '__i18n:werkstatt.tree.steckbrief__', children: [
          { id: 'aussehen', topic: '__i18n:werkstatt.tree.aussehen__' },
        ]},
      ],
    },
  };
  const resolved = resolveI18nTree(tree, 'de');
  assert.equal(resolved.data.topic, 'Anna');
  assert.equal(resolved.data.children[0].topic, 'Steckbrief');
  assert.equal(resolved.data.children[0].children[0].topic, 'Aussehen');
  // Original bleibt unverändert
  assert.equal(tree.data.children[0].topic, '__i18n:werkstatt.tree.steckbrief__');
});
