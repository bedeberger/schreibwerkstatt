// resolveCurrentQuote: trennt match / moved / changed / gone für den
// Owner-Kommentar-Diff (Stelle seit dem Kommentar geändert?).

import test from 'node:test';
import assert from 'node:assert/strict';

// share-anchor.js nutzt CSS.escape + querySelector — minimal stubben.
globalThis.CSS = globalThis.CSS || { escape: (s) => String(s) };

// Fake-rootEl: querySelector('[data-bid="X"]') → block mit textContent.
function root(bid, text) {
  const block = text == null ? null : { textContent: text };
  return { querySelector: (sel) => (text != null && sel.includes(bid) ? block : null) };
}

const { resolveCurrentQuote } = await import('../../public/js/share-anchor.js');

test('kein Block (bid weg / andere Seite) → gone', () => {
  assert.equal(resolveCurrentQuote(root('b1', null), { bid: 'b1', quote: 'x', start: 0, end: 1 }).status, 'gone');
  assert.equal(resolveCurrentQuote(null, { bid: 'b1' }).status, 'gone');
  assert.equal(resolveCurrentQuote(root('b1', 'txt'), { bid: '' }).status, 'gone');
});

test('Quote unverändert an Offsets → match', () => {
  const r = resolveCurrentQuote(root('b1', 'Hallo Welt!'), { bid: 'b1', quote: 'Welt', start: 6, end: 10 });
  assert.equal(r.status, 'match');
  assert.equal(r.currentText, 'Welt');
});

test('Quote verschoben (Offsets passen nicht, aber vorhanden) → moved', () => {
  const r = resolveCurrentQuote(root('b1', 'Noch ein Hallo Welt!'), { bid: 'b1', quote: 'Welt', start: 6, end: 10 });
  assert.equal(r.status, 'moved');
  assert.equal(r.currentText, 'Welt');
});

test('Quote weg → changed, currentText um die Offsets gekappt', () => {
  const r = resolveCurrentQuote(root('b1', 'Hallo schöne neue Erde!'), { bid: 'b1', quote: 'Welt', start: 6, end: 10 });
  assert.equal(r.status, 'changed');
  assert.ok(r.currentText.length > 0);
  assert.ok(!r.currentText.includes('Welt'));
});
