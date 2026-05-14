// Tests für Namens-Disambiguierung in Kontinuitäts-Prompts.
// Verhindert, dass zwei Figuren mit geteiltem Vornamen (z.B. «Dieter Nünlist»
// + «Dieter») vom Modell als selbe Person interpretiert werden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.resolve(here, '..', '..', 'prompt-config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const promptsUrl = new URL('../../public/js/prompts.js', import.meta.url).href;

async function freshPrompts(provider = 'claude') {
  const mod = await import(`${promptsUrl}?t=${Date.now()}_${Math.random()}`);
  mod.configurePrompts(cfg, provider);
  return mod;
}

const FIGS_WITH_COLLISION = [
  { name: 'Dieter Nünlist', typ: 'nebenfigur', beschreibung: 'Schulkollege Stefans' },
  { name: 'Dieter', typ: 'nebenfigur', beschreibung: 'Bar-Betreiber, Vater von Josef' },
  { name: 'Stefan', typ: 'hauptfigur', beschreibung: 'Protagonist' },
];

const FIGS_NO_COLLISION = [
  { name: 'Stefan', typ: 'hauptfigur', beschreibung: 'Protagonist' },
  { name: 'Andrea', typ: 'nebenfigur', beschreibung: 'Mutter' },
];

const FIGS_HONORIFIC = [
  { name: 'Herr Gottfried', typ: 'nebenfigur', beschreibung: 'Lehrer' },
  { name: 'Herr Koch', typ: 'nebenfigur', beschreibung: 'Lehrer' },
];

const FACTS = [{ kapitel: 'K1', fakten: [{ kategorie: 'figur', subjekt: 'Stefan', fakt: 'lebt' }] }];

test('CheckPrompt: emittiert Disambig-Block bei Vornamen-Kollision', async () => {
  const m = await freshPrompts();
  const p = m.buildKontinuitaetCheckPrompt('Buch', FACTS, FIGS_WITH_COLLISION, []);
  assert.match(p, /Namens-Disambiguierung/);
  assert.match(p, /«dieter»/);
  assert.match(p, /«Dieter Nünlist»/);
  assert.match(p, /«Dieter»/);
  assert.match(p, /UNTERSCHIEDLICHE Personen/);
});

test('CheckPrompt: kein Disambig-Block ohne Kollision', async () => {
  const m = await freshPrompts();
  const p = m.buildKontinuitaetCheckPrompt('Buch', FACTS, FIGS_NO_COLLISION, []);
  assert.doesNotMatch(p, /Namens-Disambiguierung/);
});

test('CheckPrompt: leere Figurenliste → kein Disambig-Block', async () => {
  const m = await freshPrompts();
  const p = m.buildKontinuitaetCheckPrompt('Buch', FACTS, [], []);
  assert.doesNotMatch(p, /Namens-Disambiguierung/);
});

test('CheckPrompt: «Herr» als Stopword → keine Falsch-Kollision', async () => {
  const m = await freshPrompts();
  const p = m.buildKontinuitaetCheckPrompt('Buch', FACTS, FIGS_HONORIFIC, []);
  assert.doesNotMatch(p, /Namens-Disambiguierung/);
});

test('SinglePassPrompt: emittiert Disambig-Block bei Vornamen-Kollision', async () => {
  const m = await freshPrompts();
  const p = m.buildKontinuitaetSinglePassPrompt('Buch', 'Buchtext', FIGS_WITH_COLLISION, []);
  assert.match(p, /Namens-Disambiguierung/);
  assert.match(p, /«dieter»/);
  assert.match(p, /«Dieter Nünlist»/);
});

test('SinglePassPrompt: kein Disambig-Block ohne Kollision', async () => {
  const m = await freshPrompts();
  const p = m.buildKontinuitaetSinglePassPrompt('Buch', 'Buchtext', FIGS_NO_COLLISION, []);
  assert.doesNotMatch(p, /Namens-Disambiguierung/);
});

test('CheckPrompt: drei Figuren mit selbem Vornamen → eine Gruppe mit allen drei', async () => {
  const m = await freshPrompts();
  const figs = [
    { name: 'Dieter Nünlist', typ: 'nebenfigur', beschreibung: 'a' },
    { name: 'Dieter Müller', typ: 'nebenfigur', beschreibung: 'b' },
    { name: 'Dieter', typ: 'nebenfigur', beschreibung: 'c' },
  ];
  const p = m.buildKontinuitaetCheckPrompt('Buch', FACTS, figs, []);
  assert.match(p, /«Dieter Nünlist».*«Dieter Müller».*«Dieter»|«Dieter».*«Dieter Müller».*«Dieter Nünlist»|«Dieter Müller».*«Dieter Nünlist».*«Dieter»|«Dieter Nünlist».*«Dieter».*«Dieter Müller»|«Dieter».*«Dieter Nünlist».*«Dieter Müller»|«Dieter Müller».*«Dieter».*«Dieter Nünlist»/);
});

test('CheckPrompt: Nachnamen-Kollision wird ebenfalls erfasst', async () => {
  const m = await freshPrompts();
  const figs = [
    { name: 'Paul Schmidt', typ: 'nebenfigur', beschreibung: 'a' },
    { name: 'Marta Schmidt', typ: 'nebenfigur', beschreibung: 'b' },
  ];
  const p = m.buildKontinuitaetCheckPrompt('Buch', FACTS, figs, []);
  assert.match(p, /Namens-Disambiguierung/);
  assert.match(p, /«schmidt»/);
});
