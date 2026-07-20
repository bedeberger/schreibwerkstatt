// Plot-Werkstatt: die Consistency-Prüfung erdet ihre Befunde an echten Textbelegen
// (persistierter Verankerungs-Index plot_beat_occurrences). Der Prompt-Builder muss
// die Marker pro Beat-Status korrekt einbetten — und ohne Index unverändert bleiben.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildPlotConsistencyPrompt } from '../../public/js/prompts/plot.js';

const ACTS = [{ id: 1, name: 'Akt 1' }];
const BEATS = [
  { id: 10, act_id: 1, titel: 'Aufbruch', status: 'im_buch', verworfen: 0 },
  { id: 11, act_id: 1, titel: 'Verrat', status: 'im_buch', verworfen: 0 },
  { id: 12, act_id: 1, titel: 'Finale', status: 'geplant', verworfen: 0 },
  { id: 13, act_id: 1, titel: 'Rest', status: 'geplant', verworfen: 0 },
  { id: 14, act_id: 1, titel: 'Ausgemustert', status: 'im_buch', verworfen: 1 },
];
const ANCHOR = {
  10: { count: 2, top: [{ page_name: 'S. 12', snippet: 'Er schnürte sein Bündel' }] },
  12: { count: 1, top: [{ page_name: 'S. 40' }] },
  14: { count: 3, top: [{ page_name: 'S. 5' }] }, // verworfen → darf NICHT als Beleg erscheinen
};

function line(prompt, titel) {
  return prompt.split('\n').find(l => l.includes(`- ${titel} [`)) || '';
}

test('im_buch + Textbeleg → Beleg mit Seite + Ausschnitt', () => {
  const p = buildPlotConsistencyPrompt(ACTS, BEATS, [], [], [], '', [], [], [], [], [], [], ANCHOR, {});
  const l = line(p, 'Aufbruch');
  assert.match(l, /Textbeleg S\. 12/);
  assert.match(l, /Er schnürte sein Bündel/);
});

test('im_buch OHNE Textbeleg → Drift-Marker', () => {
  const p = buildPlotConsistencyPrompt(ACTS, BEATS, [], [], [], '', [], [], [], [], [], [], ANCHOR, {});
  assert.match(line(p, 'Verrat'), /KEIN Textbeleg/);
});

test('geplant + Textbeleg → „bereits Textstellen vorhanden"', () => {
  const p = buildPlotConsistencyPrompt(ACTS, BEATS, [], [], [], '', [], [], [], [], [], [], ANCHOR, {});
  assert.match(line(p, 'Finale'), /bereits Textstellen vorhanden: S\. 40/);
});

test('geplant ohne Beleg → kein Marker', () => {
  const p = buildPlotConsistencyPrompt(ACTS, BEATS, [], [], [], '', [], [], [], [], [], [], ANCHOR, {});
  assert.doesNotMatch(line(p, 'Rest'), /⟨/);
});

test('verworfener Beat bekommt nie einen Beleg-Marker (auch mit Fundstellen)', () => {
  const p = buildPlotConsistencyPrompt(ACTS, BEATS, [], [], [], '', [], [], [], [], [], [], ANCHOR, {});
  assert.doesNotMatch(line(p, 'Ausgemustert'), /⟨/);
});

test('mit Index: Textbeleg-Regelblock erscheint; stale-Hinweis nur bei stale', () => {
  const withStale = buildPlotConsistencyPrompt(ACTS, BEATS, [], [], [], '', [], [], [], [], [], [], ANCHOR, { stale: true });
  assert.match(withStale, /TEXTBELEGE \(semantische Suche/);
  assert.match(withStale, /Beleg-Index ist evtl\. veraltet/);
  const fresh = buildPlotConsistencyPrompt(ACTS, BEATS, [], [], [], '', [], [], [], [], [], [], ANCHOR, { stale: false });
  assert.doesNotMatch(fresh, /Beleg-Index ist evtl\. veraltet/);
});

test('ohne Index (anchorMap=null): keine Marker, kein Regelblock (Rückwärtskompat)', () => {
  const p = buildPlotConsistencyPrompt(ACTS, BEATS);
  assert.doesNotMatch(p, /⟨/);
  assert.doesNotMatch(p, /TEXTBELEGE \(semantische Suche/);
});
