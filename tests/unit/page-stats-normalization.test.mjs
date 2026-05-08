// Regression-Sentinel: Frontend-Save-Pfad (_syncPageStatsAfterSave in tree.js)
// MUSS exakt dieselbe HTML→Text-Normalisierung verwenden wie der Server-Sync
// (routes/sync.js#htmlToText). Andernfalls schreibt jeder Page-Save inflated
// `chars` in page_stats (DOMParser textContent behält Whitespace zwischen
// Block-Tags), und Heute-Ring/7-Tage-Bars driften gegenüber dem Cron-Snapshot.
//
// Bug-Symptom (vor Fix): Donut zeigte 10'296 Z heute, 7-Tage-Bar derselbe
// Tag nur +1'845. Differenz war HTML-Inter-Tag-Whitespace, kein realer Text.
import test from 'node:test';
import assert from 'node:assert/strict';

// Server-Normalisierung (Spiegel von routes/sync.js#htmlToText).
function serverNormalize(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Frontend-Normalisierung (Spiegel des aktuellen tree.js#_syncPageStatsAfterSave-
// Codes — wenn dieser Test bricht, ist die Frontend-Inline-Logik divergiert
// und tokEsts wird wieder driften).
function frontendNormalize(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CASES = [
  ['<h1>Title</h1>\n<p>Para 1</p>\n<p>Para 2</p>', 'mehrzeiliger HTML mit Block-Boundaries'],
  ['<p>Hello   <strong>World</strong></p>', 'Inline-Tags + multi-space'],
  ['<div><p>A</p><p>B</p></div>', 'verschachtelte Blocks ohne Inter-Tag-Whitespace'],
  ['<h1>X</h1>\n\n\n<p>Y</p>', 'mehrere Newlines zwischen Tags'],
  ['<p></p><p>Lonely</p>', 'leerer Block + voller Block'],
  ['', 'leerer String'],
  ['<p>   </p>', 'nur Whitespace'],
  ['Text ohne Tags', 'plain text'],
  ['<p>Wort  mit  Doppelspaces</p>', 'doppel-spaces innerhalb Block'],
  ['<ul><li>A</li><li>B</li><li>C</li></ul>', 'Liste'],
];

for (const [html, label] of CASES) {
  test(`Normalisierung match: ${label}`, () => {
    const s = serverNormalize(html);
    const f = frontendNormalize(html);
    assert.equal(f, s, `Frontend "${f}" != Server "${s}"`);
    assert.equal(f.length, s.length);
  });
}

test('Normalisierung: Whitespace-Bias eliminiert', () => {
  // Pathologisches Beispiel: 50 Paragraphen, jeweils Newline zwischen Tags.
  // Vor Fix (DOMParser textContent): zusätzlich ~50 Newline-Chars im Output.
  // Nach Fix: 0 zusätzliche Chars vs Server-Snapshot.
  const html = Array.from({ length: 50 }, (_, i) => `<p>Para ${i}</p>`).join('\n');
  const f = frontendNormalize(html);
  const s = serverNormalize(html);
  assert.equal(f, s);
  // Sanity: Output enthält keine Newlines.
  assert.ok(!f.includes('\n'));
});
