// Tests für den Recherche-Verknüpfungs-Prompt (public/js/prompts/recherche.js):
//  - buildResearchLinkPrompt listet nur die gelieferten Kandidaten + Schnipsel
//  - System-Prompt zwingt JSON-Only (Claude) und verbietet neue Entitäten
//  - SCHEMA_RESEARCH_LINK ist strukturell gültig
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(path.resolve(here, '..', '..', 'prompt-config.json'), 'utf8'));
const promptsUrl = new URL('../../public/js/prompts.js', import.meta.url).href;

async function freshPrompts(provider = 'claude') {
  const mod = await import(`${promptsUrl}?t=${Date.now()}_${Math.random()}`);
  mod.configurePrompts(cfg, provider);
  return mod;
}

const CANDS = {
  figur: [{ id: 1, label: 'Anna' }, { id: 2, label: 'Ben' }],
  ort:   [{ id: 10, label: 'Olten' }],
  szene: [],
  beat:  [],
};

test('buildResearchLinkPrompt: enthält Schnipseltext + Kandidaten-IDs', async () => {
  const m = await freshPrompts('claude');
  const p = m.buildResearchLinkPrompt(
    { title: 'Recherche zu Anna', body: 'Notiz über Olten', source: '', url: '' },
    CANDS,
  );
  assert.match(p, /Recherche zu Anna/);
  assert.match(p, /id=1: Anna/);
  assert.match(p, /id=10: Olten/);
  assert.match(p, /"links"/);
});

test('buildResearchLinkPrompt: leere Kandidaten-Gruppen werden als „(keine)" gezeigt', async () => {
  const m = await freshPrompts('claude');
  const p = m.buildResearchLinkPrompt({ title: 'T', body: '', source: '', url: '' }, CANDS);
  assert.match(p, /Szenen: \(keine\)/);
  assert.match(p, /Plot-Abschnitte: \(keine\)/);
});

test('buildSystemResearchLink (claude): JSON-Only + keine neuen Entitäten', async () => {
  const m = await freshPrompts('claude');
  const s = m.buildSystemResearchLink();
  assert.match(s, /Antworte ausschliesslich mit einem JSON-Objekt/);
  assert.match(s, /Erfinde keine ids/i);
});

test('buildSystemResearchLink (ollama): kein JSON-Only-Footer', async () => {
  const m = await freshPrompts('ollama');
  const s = m.buildSystemResearchLink();
  assert.doesNotMatch(s, /Antworte ausschliesslich mit einem JSON-Objekt/);
});

test('SCHEMA_RESEARCH_LINK: gültige Struktur mit links-Array', async () => {
  const m = await freshPrompts('claude');
  const s = m.SCHEMA_RESEARCH_LINK;
  assert.equal(s.type, 'object');
  assert.equal(s.properties.links.type, 'array');
  const item = s.properties.links.items;
  assert.deepEqual(Object.keys(item.properties).sort(), ['art', 'grund', 'id']);
});
