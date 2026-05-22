// Unit-Tests fuer LT-Offset-Mapping. Verifiziert, dass buildOffsetTable einen
// LT-tauglichen Plain-Text-Stream + Positions-Index liefert und rangeFromOffset
// korrekt auf DOM-Ranges abbildet — auch ueber Text-Node-Boundaries hinweg.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.NodeFilter = window.NodeFilter;
globalThis.HTMLElement = window.HTMLElement;

const { buildOffsetTable, locateOffset } = await import('../../public/js/cards/editor-spellcheck/mapping.js');

function makeRoot(fragment) {
  // Per-Test frisches Dokument; linkedom parsed Fragment in body.
  const { document: d } = parseHTML(`<!doctype html><html><body><div id="root">${fragment}</div></body></html>`);
  return d.getElementById('root');
}

test('plain paragraph -> stream is text content', () => {
  const root = makeRoot('<p>Hello world.</p>');
  const { text, positions } = buildOffsetTable(root);
  assert.equal(text, 'Hello world.');
  assert.equal(positions.length, 1);
  assert.equal(positions[0].start, 0);
  assert.equal(positions[0].end, 12);
});

test('block boundary inserts paragraph break', () => {
  const root = makeRoot('<p>One.</p><p>Two.</p>');
  const { text } = buildOffsetTable(root);
  assert.equal(text, 'One.\n\nTwo.');
});

test('br inserts single newline', () => {
  const root = makeRoot('<p>Line one<br>Line two</p>');
  const { text } = buildOffsetTable(root);
  assert.equal(text, 'Line one\nLine two');
});

test('inline tags do not break stream', () => {
  const root = makeRoot('<p>Hello <strong>bold</strong> world.</p>');
  const { text, positions } = buildOffsetTable(root);
  assert.equal(text, 'Hello bold world.');
  assert.equal(positions.length, 3);
});

test('locateOffset maps single-node match', () => {
  const root = makeRoot('<p>Hello wrold.</p>');
  const table = buildOffsetTable(root);
  const loc = locateOffset(table, 6, 5);
  assert.ok(loc, 'loc not null');
  assert.equal(loc.startNode.nodeValue.slice(loc.startOffset, loc.endOffset), 'wrold');
});

test('locateOffset maps cross-node match', () => {
  const root = makeRoot('<p>Hello <em>wro</em>ld.</p>');
  const table = buildOffsetTable(root);
  const loc = locateOffset(table, 6, 5);
  assert.ok(loc);
  // text "Hello wrold."; offset 6 = start of "wro", end 11 = offset 2 in "ld."
  assert.equal(loc.startNode.nodeValue, 'wro');
  assert.equal(loc.startOffset, 0);
  assert.equal(loc.endNode.nodeValue, 'ld.');
  assert.equal(loc.endOffset, 2);
});

test('locateOffset on paragraph break returns null', () => {
  const root = makeRoot('<p>One</p><p>Two</p>');
  const table = buildOffsetTable(root);
  const loc = locateOffset(table, 3, 2);
  assert.equal(loc, null);
});

test('empty root -> empty stream', () => {
  const root = makeRoot('');
  const table = buildOffsetTable(root);
  assert.equal(table.text, '');
  assert.equal(table.positions.length, 0);
});

test('locateOffset out-of-range returns null', () => {
  const root = makeRoot('<p>Hi</p>');
  const table = buildOffsetTable(root);
  assert.equal(locateOffset(table, 100, 5), null);
});

test('positions cover entire text-node span', () => {
  const root = makeRoot('<p>abc<span>def</span>ghi</p>');
  const { text, positions } = buildOffsetTable(root);
  assert.equal(text, 'abcdefghi');
  assert.equal(positions.length, 3);
  assert.deepEqual(positions.map(p => [p.start, p.end]), [[0, 3], [3, 6], [6, 9]]);
});
