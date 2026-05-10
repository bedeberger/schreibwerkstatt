// Tests für public/js/prompts/figur-werkstatt.js — Schemas + Prompt-Builder.
// Schema-Severity-Enum muss Frontend-Severity-Tag-Skala matchen.
import test from 'node:test';
import assert from 'node:assert/strict';

const promptsUrl = new URL('../../public/js/prompts/figur-werkstatt.js', import.meta.url).href;

const sampleMindmap = {
  meta: { name: 'figur-werkstatt', version: '1' },
  format: 'node_tree',
  data: {
    id: 'root', topic: 'Anna',
    children: [
      { id: 'steckbrief', topic: 'Steckbrief', children: [
        { id: 'aussehen', topic: 'Aussehen' },
        { id: 'hintergrund', topic: 'Hintergrund' },
      ]},
    ],
  },
};

test('SCHEMA_BRAINSTORM: vorschlaege-Array mit label + begruendung', async () => {
  const m = await import(promptsUrl);
  const s = m.SCHEMA_BRAINSTORM;
  assert.equal(s.type, 'object');
  assert.deepEqual(s.required, ['vorschlaege']);
  const item = s.properties.vorschlaege.items;
  assert.equal(item.type, 'object');
  assert.deepEqual(item.required.sort(), ['begruendung', 'label']);
});

test('SCHEMA_CONSISTENCY: konflikte + fazit, schwere als Severity-Enum', async () => {
  const m = await import(promptsUrl);
  const s = m.SCHEMA_CONSISTENCY;
  assert.equal(s.type, 'object');
  assert.deepEqual(s.required.sort(), ['fazit', 'konflikte']);

  const k = s.properties.konflikte.items;
  assert.deepEqual(k.required.sort(), ['feld', 'problem', 'schwere', 'vorschlag']);
  assert.deepEqual(
    k.properties.schwere.enum,
    ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'],
    'schwere muss die 5er-Severity-Skala aus DESIGN.md tragen',
  );
});

test('WERKSTATT_SEVERITY_ENUM matcht .severity-tag--*-Skala', async () => {
  const m = await import(promptsUrl);
  assert.deepEqual(m.WERKSTATT_SEVERITY_ENUM, ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig']);
});

test('buildBrainstormPrompt: enthält Figur, Knoten-Pfad, Buchkontext, JSON-Schema-Hinweis', async () => {
  const { buildBrainstormPrompt } = await import(promptsUrl);
  const p = buildBrainstormPrompt('Anna', 'protagonist', 'Steckbrief > Hintergrund', sampleMindmap, 'Krimi, 1920er');
  assert.match(p, /Anna/);
  assert.match(p, /Archetyp: protagonist/);
  assert.match(p, /Steckbrief > Hintergrund/);
  assert.match(p, /Krimi, 1920er/);
  assert.match(p, /"vorschlaege":/);
  assert.match(p, /"label":/);
  assert.match(p, /"begruendung":/);
});

test('buildBrainstormPrompt: ohne Buchkontext + ohne Archetyp → kein Block', async () => {
  const { buildBrainstormPrompt } = await import(promptsUrl);
  const p = buildBrainstormPrompt('Anna', null, 'Stimme', sampleMindmap, '');
  assert.doesNotMatch(p, /BUCH-KONTEXT/);
  assert.doesNotMatch(p, /Archetyp:/);
  assert.doesNotMatch(p, /BESTEHENDE FIGUREN/);
});

test('buildBrainstormPrompt: bestehende Figuren werden mit Typ + Beschreibung gelistet', async () => {
  const { buildBrainstormPrompt } = await import(promptsUrl);
  const p = buildBrainstormPrompt('Anna', 'protagonist', 'Stimme', sampleMindmap, 'Krimi', [
    { name: 'Boris', typ: 'antagonist', beschreibung: 'Schurke mit Vergangenheit' },
    { name: 'Clara', typ: 'nebenfigur' },
  ]);
  assert.match(p, /BESTEHENDE FIGUREN/);
  assert.match(p, /Boris \[antagonist\]: Schurke mit Vergangenheit/);
  assert.match(p, /Clara \[nebenfigur\]/);
  assert.match(p, /Keine Doppelung von Eigenschaften bestehender Figuren/);
});

test('buildBrainstormPrompt: Orte mit Beschreibung gelistet', async () => {
  const { buildBrainstormPrompt } = await import(promptsUrl);
  const p = buildBrainstormPrompt('Anna', null, 'Hintergrund', sampleMindmap, '', [], [
    { name: 'Bergdorf', typ: 'siedlung', beschreibung: 'Abgeschieden im Hochtal' },
    { name: 'Stadt', typ: 'siedlung' },
  ]);
  assert.match(p, /BESTEHENDE ORTE IM BUCH/);
  assert.match(p, /Bergdorf \[siedlung\]: Abgeschieden im Hochtal/);
  assert.match(p, /Stadt \[siedlung\]/);
});

test('buildBrainstormPrompt: existierende Sub-Knoten werden zur Vermeidung gelistet', async () => {
  const { buildBrainstormPrompt } = await import(promptsUrl);
  const p = buildBrainstormPrompt('Anna', null, 'Steckbrief', sampleMindmap, '', [], [], [
    'Aussehen', 'Hintergrund',
  ]);
  assert.match(p, /VORHANDENE SUB-KNOTEN AM ZIEL-KNOTEN/);
  assert.match(p, /- Aussehen/);
  assert.match(p, /- Hintergrund/);
  assert.match(p, /NICHT wiederholen/);
});

test('buildBrainstormPrompt: ohne Sub-Knoten/Orte/Figuren → keine leeren Blöcke', async () => {
  const { buildBrainstormPrompt } = await import(promptsUrl);
  const p = buildBrainstormPrompt('Anna', null, 'Stimme', sampleMindmap, '', [], [], []);
  assert.doesNotMatch(p, /BESTEHENDE ORTE/);
  assert.doesNotMatch(p, /VORHANDENE SUB-KNOTEN/);
});

test('buildConsistencyPrompt: enthält Figuren-Liste, Orte-Liste mit Beschreibung, Severity-Skala', async () => {
  const { buildConsistencyPrompt } = await import(promptsUrl);
  const p = buildConsistencyPrompt(
    'Anna', 'protagonist', sampleMindmap, 'Mittelalter',
    [{ name: 'Boris', typ: 'antagonist', beschreibung: 'Schurke' }],
    [{ name: 'Burg', typ: 'gebäude', beschreibung: 'düstere Festung' }],
  );
  assert.match(p, /Anna/);
  assert.match(p, /BESTEHENDE FIGUREN/);
  assert.match(p, /Boris/);
  assert.match(p, /BESTEHENDE ORTE/);
  assert.match(p, /Burg \[gebäude\]: düstere Festung/);
  assert.match(p, /kritisch/);
  assert.match(p, /niedrig/);
  assert.match(p, /"konflikte":/);
  assert.match(p, /"fazit":/);
});

test('buildConsistencyPrompt: ohne Figuren/Orte → keine leeren Blöcke', async () => {
  const { buildConsistencyPrompt } = await import(promptsUrl);
  const p = buildConsistencyPrompt('Anna', null, sampleMindmap, '', [], []);
  assert.doesNotMatch(p, /BESTEHENDE FIGUREN/);
  assert.doesNotMatch(p, /BESTEHENDE ORTE/);
});
