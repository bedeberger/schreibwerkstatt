// Unit: Tagebuch-Rückblick-Prompts + Schema (prompts/tagebuch.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRueckblickPrompt, buildRueckblickReducePrompt, mergeRueckblickFacets, SCHEMA_RUECKBLICK, SCHEMA_RUECKBLICK_SYNTH } from '../../public/js/prompts/tagebuch.js';
import { configurePrompts } from '../../public/js/prompts.js';
import { readFileSync } from 'node:fs';

// Prompt-Config laden (configurePrompts setzt _isLocal → _jsonOnly()).
const cfg = JSON.parse(readFileSync(new URL('../../prompt-config.json', import.meta.url), 'utf8'));
configurePrompts(cfg, 'claude');

const ENTRIES = [
  { datum: '2024-03-04', titel: '2024-03-04', text: 'Heute war ein guter Tag.' },
  { datum: '2024-03-15', titel: '2024-03-15', text: 'Anna besucht.' },
];

test('buildRueckblickPrompt: Zeitraum, Einträge, JSON-Only-Marker', () => {
  const p = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03' });
  assert.match(p, /2024-03/);
  assert.match(p, /### 2024-03-04/);
  assert.match(p, /### 2024-03-15/);
  // JSON-Only-Marker (Claude-Modus) am Ende angehängt.
  assert.match(p, /ausschliesslich mit einem JSON-Objekt/);
});

test('buildRueckblickPrompt: Halluzinations-Constraint + kein Schreiben in den Text', () => {
  const p = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03' });
  assert.match(p, /Erfinde nichts/);
  assert.match(p, /mit mindestens einem Eintragsdatum/);
  assert.match(p, /Schreibe NICHT in den Tagebuchtext/);
});

test('buildRueckblickPrompt: optionaler Figuren-/Orts-Kontext (Namen + Info)', () => {
  const withCtx = buildRueckblickPrompt(ENTRIES, {
    zeitraum: '2024-03',
    figuren: [{ name: 'Anna', info: 'Protagonistin, auch: Annie' }],
    orte: [{ name: 'Zürich', info: 'Stadt, Schweiz' }],
  });
  assert.match(withCtx, /Bekannte Figuren/);
  assert.match(withCtx, /- Anna \(Protagonistin, auch: Annie\)/);
  assert.match(withCtx, /- Zürich \(Stadt, Schweiz\)/);
  const noCtx = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03' });
  assert.doesNotMatch(noCtx, /Bekannte Figuren/);
});

test('buildRueckblickPrompt: nackte Namen-Strings bleiben unterstützt', () => {
  const p = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03', figuren: ['Anna'], orte: ['Zürich'] });
  assert.match(p, /- Anna\n/);
  assert.match(p, /- Zürich\n/);
});

test('buildRueckblickPrompt: vorheriger Rückblick als Entwicklungs-Kontext', () => {
  const vorblick = {
    zeitraum: '2024-02',
    result: {
      themen: [{ label: 'Umzug', haeufigkeit: 3, belege: ['2024-02-01'] }],
      personen: [{ name: 'Anna', haeufigkeit: 2 }],
      orte: [], bemerkenswerteTage: [], zusammenfassung: 'Februar war turbulent.',
    },
  };
  const p = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03', vorblick });
  assert.match(p, /<vorheriger_rueckblick zeitraum="2024-02">/);
  assert.match(p, /Themen: Umzug/);
  assert.match(p, /Februar war turbulent\./);
  // Belege des Vorblicks dürfen NICHT eingebettet sein (nur verdichtet).
  assert.doesNotMatch(p, /2024-02-01/);
  // Kein Vorblick → kein Block.
  const noVb = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03' });
  assert.doesNotMatch(noVb, /vorheriger_rueckblick/);
});

test('buildRueckblickReducePrompt: vorheriger Rückblick fliesst in den Reduce', () => {
  const monthResults = [
    { monat: '2024-01', themen: [], personen: [], orte: [], bemerkenswerteTage: [], zusammenfassung: 'Januar.' },
  ];
  const vorblick = { zeitraum: '2023', result: { themen: [], personen: [], orte: [], bemerkenswerteTage: [], zusammenfassung: 'Das Vorjahr.' } };
  const p = buildRueckblickReducePrompt(monthResults, { zeitraum: '2024', vorblick });
  assert.match(p, /<vorheriger_rueckblick zeitraum="2023">/);
  assert.match(p, /Das Vorjahr\./);
});

test('buildRueckblickReducePrompt: verdichtete Facetten + Synthese-Auftrag', () => {
  const monthResults = [
    { monat: '2024-01', themen: [{ label: 'Arbeit', haeufigkeit: 2, belege: ['2024-01-03', '2024-01-10'] }], personen: [], orte: [], bemerkenswerteTage: [], zusammenfassung: 'Januar.' },
    { monat: '2024-02', themen: [], personen: [{ name: 'Anna', haeufigkeit: 1, belege: ['2024-02-01'] }], orte: [], bemerkenswerteTage: [], zusammenfassung: 'Februar.' },
  ];
  const p = buildRueckblickReducePrompt(monthResults, { zeitraum: '2024' });
  // Monats-Labels als Teil-Header (ohne "Monat "-Präfix im neuen Format).
  assert.match(p, /## 2024-01/);
  assert.match(p, /## 2024-02/);
  // Facetten sind bereits gemergt und werden dem Modell final vorgelegt.
  assert.match(p, /<verdichtete_facetten/);
  assert.match(p, /Arbeit \(2×\)/);
  assert.match(p, /Anna \(1×\)/);
  // Synthese-Auftrag: nur Tage + Zusammenfassung, Facetten nicht erneut ausgeben.
  assert.match(p, /bemerkenswertesten Tage/);
  assert.match(p, /Gib die Facetten NICHT erneut aus/);
  assert.match(p, /ausschliesslich mit einem JSON-Objekt/);
});

test('SCHEMA_RUECKBLICK: Struktur + Pflichtfelder', () => {
  assert.equal(SCHEMA_RUECKBLICK.type, 'object');
  assert.equal(SCHEMA_RUECKBLICK.additionalProperties, false);
  for (const k of ['themen', 'personen', 'orte', 'bemerkenswerteTage', 'zusammenfassung']) {
    assert.ok(SCHEMA_RUECKBLICK.properties[k], `Feld ${k} fehlt`);
    assert.ok(SCHEMA_RUECKBLICK.required.includes(k), `${k} nicht required`);
  }
  assert.equal(SCHEMA_RUECKBLICK.properties.themen.type, 'array');
  assert.equal(SCHEMA_RUECKBLICK.properties.themen.items.properties.haeufigkeit.type, 'number');
  assert.equal(SCHEMA_RUECKBLICK.properties.zusammenfassung.type, 'string');
});

test('SCHEMA_RUECKBLICK: Personen + Orte tragen Datums-Belege', () => {
  for (const k of ['personen', 'orte']) {
    const item = SCHEMA_RUECKBLICK.properties[k].items;
    assert.ok(item.properties.belege, `${k}: belege-Feld fehlt`);
    assert.equal(item.properties.belege.type, 'array');
    assert.equal(item.properties.belege.items.type, 'string');
    assert.ok(item.required.includes('belege'), `${k}: belege nicht required`);
  }
});

test('buildRueckblickPrompt: Personen/Orte-Belege im Output-Schema + Constraint', () => {
  const p = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03' });
  // Output-Beispiel enthält belege bei personen/orte.
  assert.match(p, /"personen":[^\]]*"belege"/);
  assert.match(p, /"orte":[^\]]*"belege"/);
  // Constraint deckt Personen/Orte explizit ab.
  assert.match(p, /jede Person, jeder Ort/);
});

test('SCHEMA_RUECKBLICK_SYNTH: nur Tage + Zusammenfassung', () => {
  assert.equal(SCHEMA_RUECKBLICK_SYNTH.type, 'object');
  assert.deepEqual(Object.keys(SCHEMA_RUECKBLICK_SYNTH.properties).sort(), ['bemerkenswerteTage', 'zusammenfassung']);
  assert.ok(!SCHEMA_RUECKBLICK_SYNTH.properties.themen, 'Facetten dürfen nicht Teil des Synth-Schemas sein');
});

test('mergeRueckblickFacets: Belege-Union + haeufigkeit = eindeutige Belegtage', () => {
  const parts = [
    { monat: '2024-01', themen: [{ label: 'Arbeit', haeufigkeit: 1, belege: ['2024-01-03'] }], personen: [{ name: 'Anna', haeufigkeit: 1, belege: ['2024-01-05'] }], orte: [] },
    { monat: '2024-02', themen: [{ label: 'arbeit', haeufigkeit: 1, belege: ['2024-01-03', '2024-02-08'] }], personen: [{ name: 'Anna', haeufigkeit: 1, belege: ['2024-02-09'] }], orte: [] },
  ];
  const m = mergeRueckblickFacets(parts);
  // 'Arbeit' + 'arbeit' verschmelzen (case-insensitiv); Belege dedupliziert + vereinigt.
  assert.equal(m.themen.length, 1);
  assert.equal(m.themen[0].label, 'Arbeit');
  assert.deepEqual(m.themen[0].belege, ['2024-01-03', '2024-02-08']);
  assert.equal(m.themen[0].haeufigkeit, 2);
  // Anna über zwei Monate → zwei eindeutige Belegtage.
  assert.equal(m.personen.length, 1);
  assert.equal(m.personen[0].haeufigkeit, 2);
  assert.deepEqual(m.orte, []);
});
