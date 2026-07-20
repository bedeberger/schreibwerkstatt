// Drift-Berechnung „lohnt sich eine neue Fassung?" (lib/snapshot-drift.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeDrift } = require('../../lib/snapshot-drift.js');

// buildBookJson-Format: { book:{settings}, tree:[{type:'page',srcId,html}…] }
function content(pages, settings = null) {
  return {
    book: { name: 'X', settings },
    tree: pages.map((p) => ({ type: 'page', srcId: p.id, name: p.name || '', html: p.html })),
  };
}

test('identischer Stand → 0% Drift, nicht empfehlenswert', () => {
  const c = content([{ id: 1, html: '<p>Es war einmal ein Wald.</p>' }]);
  const d = computeDrift({ baselineContent: c, currentContent: c });
  assert.equal(d.text.changePct, 0);
  assert.equal(d.text.unchangedPages, 1);
  assert.equal(d.worthwhile, false);
});

test('Voll-Umschrieb einer Seite → ~100% Drift', () => {
  const base = content([{ id: 1, html: '<p>alpha beta gamma delta</p>' }]);
  const cur = content([{ id: 1, html: '<p>eins zwei drei vier</p>' }]);
  const d = computeDrift({ baselineContent: base, currentContent: cur });
  assert.equal(d.text.changedPages, 1);
  assert.ok(d.text.changePct >= 90, `changePct=${d.text.changePct}`);
  assert.equal(d.worthwhile, true);
});

test('kleine Aenderung in grossem Text → unter Schwelle, nicht empfehlenswert', () => {
  const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
  const base = content([{ id: 1, html: `<p>${words}</p>` }]);
  const cur = content([{ id: 1, html: `<p>${words} extra</p>` }]);
  const d = computeDrift({ baselineContent: base, currentContent: cur });
  assert.equal(d.text.changedPages, 1);
  assert.ok(d.text.changePct < 10, `changePct=${d.text.changePct}`);
  assert.equal(d.worthwhile, false);
});

test('neue + entfernte Seiten werden gezaehlt und fliessen in die Drift', () => {
  const base = content([{ id: 1, html: '<p>bleibt gleich</p>' }, { id: 2, html: '<p>faellt weg bald jetzt</p>' }]);
  const cur = content([{ id: 1, html: '<p>bleibt gleich</p>' }, { id: 3, html: '<p>ganz neue seite hier</p>' }]);
  const d = computeDrift({ baselineContent: base, currentContent: cur });
  assert.equal(d.text.addedPages, 1);
  assert.equal(d.text.removedPages, 1);
  assert.equal(d.text.unchangedPages, 1);
  assert.ok(d.text.changePct > 0);
});

test('Publikations-Aenderung macht empfehlenswert (auch ohne Textdrift)', () => {
  const c = content([{ id: 1, html: '<p>unveraendert</p>' }]);
  const d = computeDrift({
    baselineContent: c, currentContent: c,
    baselinePubMeta: { isbn: '111', author_name: 'A' },
    currentPubMeta: { isbn: '222', author_name: 'A' },
  });
  assert.equal(d.text.changePct, 0);
  assert.equal(d.publicationChanged, true);
  assert.deepEqual(d.publicationFields, ['isbn']);
  assert.equal(d.worthwhile, true);
});

test('Einstellungs-Aenderung macht empfehlenswert', () => {
  const c = content([{ id: 1, html: '<p>gleich</p>' }]);
  const d = computeDrift({
    baselineContent: c, currentContent: c,
    baselineSettings: { buchtyp: 'roman', is_finished: 0 },
    currentSettings: { buchtyp: 'roman', is_finished: 1 },
  });
  assert.equal(d.settingsChanged, true);
  assert.deepEqual(d.settingsFields, ['is_finished']);
  assert.equal(d.worthwhile, true);
});

test('0/null/"" in Einstellungen zaehlen nicht als Aenderung', () => {
  const c = content([{ id: 1, html: '<p>x</p>' }]);
  const d = computeDrift({
    baselineContent: c, currentContent: c,
    baselineSettings: { daily_goal_chars: 0, schauplatz_land: null },
    currentSettings: { daily_goal_chars: '0', schauplatz_land: '' },
  });
  assert.equal(d.settingsChanged, false);
});
