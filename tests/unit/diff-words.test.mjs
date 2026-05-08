import test from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff, findingDiff } from '../../public/js/diff-words.js';

test('wordDiff: identische Strings → nur eq', () => {
  const out = wordDiff('Hallo Welt', 'Hallo Welt');
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'eq');
  assert.equal(out[0].text, 'Hallo Welt');
});

test('wordDiff: ein Wort ersetzt → del + ins, eq drumherum', () => {
  const out = wordDiff('Der schnelle Fuchs', 'Der flinke Fuchs');
  // Reassembled-Text zusammenklatschen
  const fullDel = out.filter(s => s.type !== 'ins').map(s => s.text).join('');
  const fullIns = out.filter(s => s.type !== 'del').map(s => s.text).join('');
  assert.equal(fullDel, 'Der schnelle Fuchs');
  assert.equal(fullIns, 'Der flinke Fuchs');
  assert.ok(out.some(s => s.type === 'del' && s.text.trim() === 'schnelle'));
  assert.ok(out.some(s => s.type === 'ins' && s.text.trim() === 'flinke'));
});

test('wordDiff: Wort eingefügt', () => {
  const out = wordDiff('Der Fuchs', 'Der schnelle Fuchs');
  const ins = out.filter(s => s.type === 'ins').map(s => s.text).join('');
  assert.ok(ins.includes('schnelle'));
  assert.ok(!out.some(s => s.type === 'del'));
});

test('wordDiff: Wort gelöscht', () => {
  const out = wordDiff('Der schnelle Fuchs', 'Der Fuchs');
  const del = out.filter(s => s.type === 'del').map(s => s.text).join('');
  assert.ok(del.includes('schnelle'));
  assert.ok(!out.some(s => s.type === 'ins'));
});

test('wordDiff: leere Strings → leeres Array', () => {
  assert.deepEqual(wordDiff('', ''), []);
});

test('wordDiff: leerer Original-String → alles ins', () => {
  const out = wordDiff('', 'neuer Text');
  assert.ok(out.every(s => s.type === 'ins'));
});

test('wordDiff: adjazente del/ins werden verschmolzen wenn keine LCS-Matches dazwischen', () => {
  // Komplett disjunkte Tokens, kein gemeinsames Whitespace → ein del + ein ins
  const out = wordDiff('alphabeta', 'gammadelta');
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'del');
  assert.equal(out[0].text, 'alphabeta');
  assert.equal(out[1].type, 'ins');
  assert.equal(out[1].text, 'gammadelta');
});

test('wordDiff: gemeinsame Whitespace-Tokens bleiben als eq-Anker erhalten', () => {
  // Dokumentiert bewusst: Whitespace-Tokens matchen → del/ins werden NICHT
  // über sie hinweg verschmolzen, damit Spacing-Struktur erhalten bleibt.
  const out = wordDiff('a b c', 'x y z');
  assert.ok(out.some(s => s.type === 'eq' && s.text.trim() === ''));
  const dels = out.filter(s => s.type === 'del').map(s => s.text).join('');
  const inss = out.filter(s => s.type === 'ins').map(s => s.text).join('');
  assert.equal(dels, 'abc');
  assert.equal(inss, 'xyz');
});

test('wordDiff: Whitespace bleibt erhalten (Roundtrip)', () => {
  const orig = 'Er  ging schnell.';
  const corr = 'Er ging zügig.';
  const out = wordDiff(orig, corr);
  const reconstructedDel = out.filter(s => s.type !== 'ins').map(s => s.text).join('');
  const reconstructedIns = out.filter(s => s.type !== 'del').map(s => s.text).join('');
  assert.equal(reconstructedDel, orig);
  assert.equal(reconstructedIns, corr);
});

test('findingDiff: ohne korrektur → nur del', () => {
  const out = findingDiff({ original: 'fragwürdig', korrektur: '' });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'del');
  assert.equal(out[0].text, 'fragwürdig');
});

test('findingDiff: leerer Eintrag → leeres Array', () => {
  assert.deepEqual(findingDiff(null), []);
  assert.deepEqual(findingDiff({}), []);
});

test('findingDiff: vollständiger Eintrag → diff', () => {
  const out = findingDiff({ original: 'sehr gross', korrektur: 'riesig' });
  assert.ok(out.some(s => s.type === 'del'));
  assert.ok(out.some(s => s.type === 'ins'));
});
