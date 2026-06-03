// Unit: Tagebuch-Rückblick-Prompts + Schema (prompts/tagebuch.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRueckblickPrompt, buildRueckblickReducePrompt, SCHEMA_RUECKBLICK } from '../../public/js/prompts/tagebuch.js';
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

test('buildRueckblickPrompt: optionaler Figuren-/Orts-Kontext', () => {
  const withCtx = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03', figurenNamen: ['Anna'], orteNamen: ['Zürich'] });
  assert.match(withCtx, /Bekannte Figuren/);
  assert.match(withCtx, /Anna/);
  assert.match(withCtx, /Zürich/);
  const noCtx = buildRueckblickPrompt(ENTRIES, { zeitraum: '2024-03' });
  assert.doesNotMatch(noCtx, /Bekannte Figuren/);
});

test('buildRueckblickReducePrompt: Monats-Teilergebnisse + Konsolidierung', () => {
  const monthResults = [
    { monat: '2024-01', themen: [{ label: 'Arbeit', haeufigkeit: 2, belege: ['2024-01-03'] }], personen: [], orte: [], bemerkenswerteTage: [], zusammenfassung: 'Januar.' },
    { monat: '2024-02', themen: [], personen: [{ name: 'Anna', haeufigkeit: 1 }], orte: [], bemerkenswerteTage: [], zusammenfassung: 'Februar.' },
  ];
  const p = buildRueckblickReducePrompt(monthResults, { zeitraum: '2024' });
  assert.match(p, /Monat 2024-01/);
  assert.match(p, /Monat 2024-02/);
  assert.match(p, /Konsolidiere/);
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
