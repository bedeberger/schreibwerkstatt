// Tests für die Stilprofil-Injektion (public/js/prompts/core.js):
//  - Profil fliesst NUR in text-erzeugende Prompts (Imitate-Framing) und
//    Bewertungs-Prompts (Referenz-Framing).
//  - Analyse-Prompts (Figuren/Komplett/Orte/Kontinuität) bleiben unberührt.
//  - Ohne Profil erscheint kein Marker.
//  - SYSTEM_STILPROFIL (Extraktions-Persona) ist gesetzt.
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

const PROFILE = 'STILMARKER_XYZ123: kurze parataktische Sätze, trockener Ton.';
const MARKER = 'ETABLIERTES STILPROFIL DES AUTORS';

test('Stilprofil: Imitate-Framing in text-erzeugenden Prompts', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '', false, null, PROFILE);
  for (const key of ['SYSTEM_LEKTORAT', 'SYSTEM_SYNONYM', 'SYSTEM_CHAT', 'SYSTEM_BOOK_CHAT']) {
    assert.ok(out[key].includes(PROFILE), `${key} enthält das Profil nicht`);
    assert.match(out[key], /nahtlos in diesen Stil einfügen/, `${key} fehlt Imitate-Framing`);
  }
  // Lektorat-_BLOCKS: Profil im per-Buch-Block (zweites Element).
  const blocks = out.SYSTEM_LEKTORAT_BLOCKS;
  assert.ok(Array.isArray(blocks), 'SYSTEM_LEKTORAT_BLOCKS sollte mit Profil ein Array sein');
  assert.ok(blocks.some(b => (b.text || '').includes(PROFILE)), 'Profil fehlt im Lektorat-BookContext-Block');
});

test('Stilprofil: Referenz-Framing in Bewertungs-Prompts', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '', false, null, PROFILE);
  for (const key of ['SYSTEM_BUCHBEWERTUNG', 'SYSTEM_KAPITELREVIEW']) {
    assert.ok(out[key].includes(PROFILE), `${key} enthält das Profil nicht`);
    assert.match(out[key], /Massstab für Stimmen-Treue/, `${key} fehlt Referenz-Framing`);
  }
});

test('Stilprofil: NICHT in Analyse-Prompts', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '', false, null, PROFILE);
  for (const key of ['SYSTEM_FIGUREN', 'SYSTEM_KOMPLETT_EXTRAKTION', 'SYSTEM_ORTE', 'SYSTEM_KONTINUITAET']) {
    assert.ok(!out[key].includes(PROFILE), `${key} darf das Profil NICHT enthalten`);
  }
});

test('Stilprofil: ohne Profil kein Marker', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '', false, null, null);
  for (const key of ['SYSTEM_LEKTORAT', 'SYSTEM_SYNONYM', 'SYSTEM_CHAT', 'SYSTEM_BUCHBEWERTUNG', 'SYSTEM_KAPITELREVIEW']) {
    assert.ok(!out[key].includes(MARKER), `${key} sollte ohne Profil keinen Marker tragen`);
  }
});

test('Stilprofil: SYSTEM_STILPROFIL-Persona ist gesetzt', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '', false, null, null);
  assert.ok(out.SYSTEM_STILPROFIL && out.SYSTEM_STILPROFIL.length > 0, 'SYSTEM_STILPROFIL fehlt');
  assert.match(out.SYSTEM_STILPROFIL, /Stilanalytiker/i);
  // Extraktions-Persona ist deskriptiv → kein Buch-Kontext-Marker.
  assert.ok(!out.SYSTEM_STILPROFIL.includes(MARKER));
});

test('Stilprofil: buildStilprofilPrompt enthält Leseprobe + Schema-Feld', async () => {
  const m = await freshPrompts('claude');
  const p = m.buildStilprofilPrompt('Es war einmal ein Test.');
  assert.match(p, /Es war einmal ein Test\./);
  assert.match(p, /"stilprofil"/);
  assert.ok(m.SCHEMA_STILPROFIL && m.SCHEMA_STILPROFIL.properties?.stilprofil, 'SCHEMA_STILPROFIL fehlt');
});
