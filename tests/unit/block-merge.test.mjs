// Unit-Tests für den Block-Level-Merge (public/js/editor/shared/block-merge.js).
// Läuft in Node über den Regex-Fallback von parseBlocks (kein DOMParser).
// Lauf: `node --test tests/unit/block-merge.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeBlocks, mergeBlockLists, parseBlocks, mergedToHtml, buildResolvedHtml,
} from '../../public/js/editor/shared/block-merge.js';

// Helper: Block mit data-bid bauen.
const p = (bid, txt) => `<p data-bid="${bid}">${txt}</p>`;

test('parseBlocks: extrahiert bid + tag + outerHTML', () => {
  const blocks = parseBlocks(`${p('a1', 'A')}<h2 data-bid="b2">B</h2>`);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(b => [b.bid, b.tag]), [['a1', 'p'], ['b2', 'h2']]);
});

test('identische Inputs → kein Konflikt, unverändert', () => {
  const html = `${p('a', 'Eins')}${p('b', 'Zwei')}`;
  const { merged, conflicts } = mergeBlocks(html, html, html);
  assert.equal(conflicts.length, 0);
  assert.equal(mergedToHtml(merged), html);
});

test('lokal ändert Block A, remote ändert Block B → beide gemerged, kein Konflikt', () => {
  const base = `${p('a', 'A')}${p('b', 'B')}`;
  const local = `${p('a', 'A-lokal')}${p('b', 'B')}`;
  const remote = `${p('a', 'A')}${p('b', 'B-remote')}`;
  const { merged, conflicts } = mergeBlocks(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(mergedToHtml(merged), `${p('a', 'A-lokal')}${p('b', 'B-remote')}`);
});

test('beide ändern Block A unterschiedlich → Konflikt', () => {
  const base = p('a', 'A');
  const local = p('a', 'A-lokal');
  const remote = p('a', 'A-remote');
  const { conflicts } = mergeBlocks(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].bid, 'a');
  assert.match(conflicts[0].local_html, /A-lokal/);
  assert.match(conflicts[0].remote_html, /A-remote/);
});

test('beide ändern Block A gleich → kein Konflikt', () => {
  const base = p('a', 'A');
  const same = p('a', 'A-neu');
  const { conflicts, merged } = mergeBlocks(base, same, same);
  assert.equal(conflicts.length, 0);
  assert.equal(mergedToHtml(merged), same);
});

test('lokal löscht Block A, remote unverändert → Löschung gewinnt (silent)', () => {
  const base = `${p('a', 'A')}${p('b', 'B')}`;
  const local = p('b', 'B');
  const remote = `${p('a', 'A')}${p('b', 'B')}`;
  const { merged, conflicts } = mergeBlocks(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(mergedToHtml(merged), p('b', 'B'));
});

test('lokal löscht Block A, remote ändert Block A → Konflikt', () => {
  const base = `${p('a', 'A')}${p('b', 'B')}`;
  const local = p('b', 'B');
  const remote = `${p('a', 'A-remote')}${p('b', 'B')}`;
  const { conflicts } = mergeBlocks(base, local, remote);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].bid, 'a');
  assert.equal(conflicts[0].local_html, null); // lokal gelöscht
  assert.match(conflicts[0].remote_html, /A-remote/);
});

test('lokal fügt X nach A ein, remote fügt Y nach A ein → beide eingefügt, deterministisch', () => {
  const base = `${p('a', 'A')}${p('z', 'Z')}`;
  const local = `${p('a', 'A')}${p('x', 'X')}${p('z', 'Z')}`;
  const remote = `${p('a', 'A')}${p('y', 'Y')}${p('z', 'Z')}`;
  const { merged, conflicts } = mergeBlocks(base, local, remote);
  assert.equal(conflicts.length, 0);
  // local-only (X) vor remote-only (Y), zwischen Ankern A und Z.
  assert.equal(mergedToHtml(merged), `${p('a', 'A')}${p('x', 'X')}${p('y', 'Y')}${p('z', 'Z')}`);
});

test('remote fügt neuen Block hinzu (nicht in base/local) → übernommen', () => {
  const base = p('a', 'A');
  const local = p('a', 'A');
  const remote = `${p('a', 'A')}${p('neu', 'Neu')}`;
  const { merged, conflicts } = mergeBlocks(base, local, remote);
  assert.equal(conflicts.length, 0);
  assert.equal(mergedToHtml(merged), `${p('a', 'A')}${p('neu', 'Neu')}`);
});

test('Reihenfolge-Drift: remote sortiert Blöcke um → Merge bleibt deterministisch', () => {
  const base = `${p('a', 'A')}${p('b', 'B')}${p('c', 'C')}`;
  const local = `${p('a', 'A')}${p('b', 'B')}${p('c', 'C')}`;
  const remote = `${p('c', 'C')}${p('a', 'A')}${p('b', 'B')}`;
  const { merged, conflicts } = mergeBlocks(base, local, remote);
  // Block-Move ist MVP-out-of-scope: kein Inhaltskonflikt, alle Blöcke erhalten,
  // Reihenfolge deterministisch (nicht zwingend local-Order).
  assert.equal(conflicts.length, 0);
  const order = [...mergedToHtml(merged).matchAll(/data-bid="(\w)"/g)].map(m => m[1]).sort().join('');
  assert.equal(order, 'abc'); // alle drei genau einmal
  assert.equal(mergedToHtml(merged), mergedToHtml(mergeBlocks(base, local, remote).merged)); // deterministisch
});

test('Whitespace-/Attribut-Rauschen erzeugt keinen Konflikt', () => {
  const base = '<p data-bid="a">Hallo Welt</p>';
  const local = '<p data-bid="a">Hallo   Welt</p>'; // nur Whitespace
  const remote = '<p  data-bid="a" >Hallo Welt</p>'; // nur Attribut-Spacing
  const { conflicts } = mergeBlocks(base, local, remote);
  assert.equal(conflicts.length, 0);
});

test('Duplikat-bids im Input → robust (kein Crash, letzter gewinnt in Map)', () => {
  const dup = `${p('a', 'A1')}${p('a', 'A2')}`;
  assert.doesNotThrow(() => mergeBlocks(dup, dup, dup));
});

test('buildResolvedHtml: Entscheidungen werden angewandt', () => {
  const base = `${p('a', 'A')}${p('b', 'B')}`;
  const local = `${p('a', 'A-lokal')}${p('b', 'B-lokal')}`;
  const remote = `${p('a', 'A-remote')}${p('b', 'B-remote')}`;
  const { merged, conflicts } = mergeBlocks(base, local, remote);
  assert.equal(conflicts.length, 2);
  // a → remote, b → both
  const out = buildResolvedHtml(merged, { a: 'remote', b: 'both' });
  assert.match(out, /A-remote/);
  assert.doesNotMatch(out, /A-lokal/);
  assert.match(out, /B-lokal/);
  assert.match(out, /B-remote/);
});

test('buildResolvedHtml: Default ohne Entscheidung = local', () => {
  const { merged } = mergeBlocks(p('a', 'A'), p('a', 'L'), p('a', 'R'));
  assert.match(buildResolvedHtml(merged, {}), /L/);
});

test('mergeBlockLists: pure Block-Arrays direkt', () => {
  const { conflicts } = mergeBlockLists(
    [{ bid: 'a', tag: 'p', html: '<p data-bid="a">A</p>' }],
    [{ bid: 'a', tag: 'p', html: '<p data-bid="a">L</p>' }],
    [{ bid: 'a', tag: 'p', html: '<p data-bid="a">R</p>' }],
  );
  assert.equal(conflicts.length, 1);
});
