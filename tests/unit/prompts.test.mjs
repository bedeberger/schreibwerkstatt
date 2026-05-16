// Tests für public/js/prompts.js – Build-Logik:
//  - configurePrompts() füllt System-Prompts aus locales-Map
//  - JSON_ONLY-Footer in System-Prompts (Claude-Mode)
//  - getLocalePromptsForBook() augmentiert baseRules mit BUCHTYP-KONTEXT + Freitext
//  - User-Freitext erscheint mit «VORRANGIGE ANGABEN»-Marker
//  - Lokale Provider (ollama/llama) lassen JSON_ONLY weg
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
  // ESM-Module-Cache umgehen: Cache-Buster pro Test, sonst bleibt der State
  // aus dem vorherigen configurePrompts-Aufruf liegen.
  const mod = await import(`${promptsUrl}?t=${Date.now()}_${Math.random()}`);
  mod.configurePrompts(cfg, provider);
  return mod;
}

test('configurePrompts: setzt System-Prompts auf Default-Locale (de-CH)', async () => {
  const m = await freshPrompts('claude');
  assert.ok(m.SYSTEM_LEKTORAT && m.SYSTEM_LEKTORAT.length > 0);
  assert.ok(m.SYSTEM_BUCHBEWERTUNG && m.SYSTEM_BUCHBEWERTUNG.length > 0);
  assert.ok(m.SYSTEM_FIGUREN && m.SYSTEM_FIGUREN.length > 0);
  assert.ok(m.SYSTEM_KOMPLETT_EXTRAKTION && m.SYSTEM_KOMPLETT_EXTRAKTION.length > 0);
  // Default-Locale ist de-CH → Schweizer Schreibnorm im Prompt
  assert.match(m.SYSTEM_LEKTORAT, /Schweizer/i);
});

test('configurePrompts (claude): JSON_ONLY-Footer in jedem Analyse-Prompt', async () => {
  const m = await freshPrompts('claude');
  // JSON_ONLY-Marker: "Antworte ausschliesslich mit einem JSON-Objekt"
  for (const key of [
    'SYSTEM_LEKTORAT', 'SYSTEM_BUCHBEWERTUNG', 'SYSTEM_KAPITELANALYSE',
    'SYSTEM_KAPITELREVIEW', 'SYSTEM_FIGUREN', 'SYSTEM_STILKORREKTUR',
    'SYSTEM_SYNONYM',
  ]) {
    assert.match(m[key], /Antworte ausschliesslich mit einem JSON-Objekt/, `${key} fehlt JSON_ONLY`);
    assert.match(m[key], /Beginne deine Antwort direkt mit \{/, `${key} fehlt Klammer-Anweisung`);
  }
});

test('configurePrompts (ollama): JSON_ONLY entfällt – Grammar-Constrained Output zwingt Format', async () => {
  const m = await freshPrompts('ollama');
  for (const key of ['SYSTEM_LEKTORAT', 'SYSTEM_BUCHBEWERTUNG', 'SYSTEM_FIGUREN']) {
    assert.doesNotMatch(m[key], /Antworte ausschliesslich mit einem JSON-Objekt/,
      `${key} darf JSON_ONLY im Lokal-Modus NICHT enthalten`);
  }
});

test('getLocalePromptsForBook: ohne Buchtyp + ohne Freitext → keine Augmentation', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '');
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /BUCHTYP-KONTEXT/);
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /VORRANGIGE ANGABEN DES AUTORS/);
  assert.equal(out.BUCH_KONTEXT, '');
});

test('getLocalePromptsForBook: Buchtyp injiziert BUCHTYP-KONTEXT in baseRules', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'krimi', '');
  assert.match(out.SYSTEM_LEKTORAT, /BUCHTYP-KONTEXT:/);
  assert.match(out.SYSTEM_LEKTORAT, /Krimi oder Thriller/);
  // Auch in Buchbewertung – baseRules wird in alle Analyse-Prompts gemergt.
  assert.match(out.SYSTEM_BUCHBEWERTUNG, /BUCHTYP-KONTEXT:/);
});

test('getLocalePromptsForBook: Buchtyp "andere" hat leeren zusatz → kein Block', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'andere', '');
  // zusatz="" → kein BUCHTYP-KONTEXT-Block
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /BUCHTYP-KONTEXT/);
});

test('getLocalePromptsForBook: Freitext erscheint als VORRANGIGE-ANGABEN-Block', async () => {
  const m = await freshPrompts('claude');
  const freitext = 'Spielt 1893 in Zürich, Erzähler ist 12-jähriges Mädchen.';
  const out = m.getLocalePromptsForBook('de-CH', null, freitext);
  assert.match(out.SYSTEM_LEKTORAT, /VORRANGIGE ANGABEN DES AUTORS/);
  assert.match(out.SYSTEM_LEKTORAT, /übersteuern bei Konflikt/);
  assert.ok(out.SYSTEM_LEKTORAT.includes(freitext), 'Freitext muss wörtlich erscheinen');
  assert.equal(out.BUCH_KONTEXT, freitext);
});

test('getLocalePromptsForBook: Buchtyp + Freitext → beide Blöcke, Freitext nach Buchtyp', async () => {
  const m = await freshPrompts('claude');
  const freitext = 'Schauplatz: Mars-Kolonie 2189.';
  const out = m.getLocalePromptsForBook('de-CH', 'fantasy_scifi', freitext);
  const idxBuchtyp = out.SYSTEM_LEKTORAT.indexOf('BUCHTYP-KONTEXT');
  const idxFreitext = out.SYSTEM_LEKTORAT.indexOf('VORRANGIGE ANGABEN');
  assert.ok(idxBuchtyp > 0);
  assert.ok(idxFreitext > 0);
  assert.ok(idxFreitext > idxBuchtyp,
    'Freitext muss NACH Buchtyp stehen, damit User-Angaben Buchtyp-Defaults übersteuern können');
});

test('getLocalePromptsForBook: isFinished=true injiziert WERK-ABGESCHLOSSEN in alle Prompts', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '', true);
  // baseRules-Augmentation landet in allen Prompt-Bundles, die rules nutzen
  for (const key of ['SYSTEM_LEKTORAT', 'SYSTEM_BUCHBEWERTUNG', 'SYSTEM_KAPITELREVIEW', 'SYSTEM_CHAT', 'SYSTEM_BOOK_CHAT']) {
    assert.match(out[key], /WERK ABGESCHLOSSEN/, `${key} fehlt WERK-ABGESCHLOSSEN-Block`);
    assert.match(out[key], /Figuren und Szenen werden nicht mehr weiterentwickelt/, `${key} fehlt Kern-Aussage`);
  }
});

test('getLocalePromptsForBook: isFinished=false → kein WERK-ABGESCHLOSSEN-Block', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '', false);
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /WERK ABGESCHLOSSEN/);
  assert.doesNotMatch(out.SYSTEM_BUCHBEWERTUNG, /WERK ABGESCHLOSSEN/);
});

test('getLocalePromptsForBook: isFinished default (omitted) → kein Block', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '');
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /WERK ABGESCHLOSSEN/);
});

test('getLocalePromptsForBook (en-US): isFinished → englische WORK-COMPLETED-Variante', async () => {
  const m = await freshPrompts('claude');
  if (!cfg.locales['en-US']) return;
  const out = m.getLocalePromptsForBook('en-US', null, '', true);
  assert.match(out.SYSTEM_LEKTORAT, /WORK COMPLETED/);
  assert.match(out.SYSTEM_BOOK_CHAT, /WORK COMPLETED/);
});

test('getLocalePromptsForBook: unbekannter Buchtyp → ignoriert, kein Crash', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'gibtsnicht', '');
  assert.doesNotMatch(out.SYSTEM_LEKTORAT, /BUCHTYP-KONTEXT/);
  assert.ok(out.SYSTEM_LEKTORAT.length > 0, 'Prompt muss trotzdem aufgebaut werden');
});

test('getLocalePromptsForBook: unbekannte Locale → fällt auf Default zurück', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('xx-YY', null, '');
  assert.ok(out.SYSTEM_LEKTORAT && out.SYSTEM_LEKTORAT.length > 0);
});

test('getLocalePromptsForBook (en-US): erzeugt englische Prompts', async () => {
  const m = await freshPrompts('claude');
  if (!cfg.locales['en-US']) return; // optional – nur testen wenn locale definiert ist
  const out = m.getLocalePromptsForBook('en-US', null, '');
  // englische Locale enthält "JSON FIELD NAMES"-Hinweis aus commonRules.en
  assert.ok(out.SYSTEM_LEKTORAT.length > 0);
});

test('PROMPTS_VERSION: ist gesetzter String – wird als Cache-Key verwendet', async () => {
  const m = await freshPrompts('claude');
  assert.equal(typeof m.PROMPTS_VERSION, 'string');
  assert.ok(m.PROMPTS_VERSION.length > 0);
});

test('buildLektoratPrompt: erzeugt nicht-leeren Prompt-Body', async () => {
  const m = await freshPrompts('claude');
  const out = m.buildLektoratPrompt('Der Hund läuft im Wald.', { buchtyp: 'roman' });
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 50);
  assert.ok(out.includes('Der Hund läuft im Wald.'));
});

test('buildLektoratPrompt (claude): enthält alle 17 Typen im Enum + 5 neue Spezial-Blöcke', async () => {
  const m = await freshPrompts('claude');
  const out = m.buildLektoratPrompt('Der Hund läuft im Wald.', { buchtyp: 'roman' });
  for (const t of ['filterwort', 'klischee', 'pleonasmus', 'namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal']) {
    assert.match(out, new RegExp(t), `Typ «${t}» fehlt im Cloud-Prompt`);
  }
  assert.match(out, /Filterwort-Regeln/);
  assert.match(out, /Klischee-Regeln/);
  assert.match(out, /Pleonasmus-Regeln/);
});

test('buildLektoratPrompt (claude): Figurenkonsistenz-Block nur bei figuren.length > 0', async () => {
  const m = await freshPrompts('claude');
  const ohne = m.buildLektoratPrompt('Text.', { figuren: [] });
  const mit  = m.buildLektoratPrompt('Text.', { figuren: [{ name: 'Anna', geschlecht: 'weiblich' }] });
  assert.ok(!ohne.includes('Figurenkonsistenz-Regeln'), 'darf ohne Figuren nicht eingebunden sein');
  assert.match(mit, /Figurenkonsistenz-Regeln/);
  assert.match(mit, /laut Figurenkartei/);
});

test('buildLektoratPrompt (claude): Schauplatzkonsistenz-Block nur bei orte.length > 0', async () => {
  const m = await freshPrompts('claude');
  const ohne = m.buildLektoratPrompt('Text.', { orte: [] });
  const mit  = m.buildLektoratPrompt('Text.', { orte: [{ name: 'Berlin', typ: 'Stadt' }] });
  assert.ok(!ohne.includes('Schauplatzkonsistenz-Regeln'), 'darf ohne Orte nicht eingebunden sein');
  assert.match(mit, /Schauplatzkonsistenz-Regeln/);
});

test('buildLektoratPrompt (ollama): nur 6 Local-Typen, keine neuen Spezial-Blöcke', async () => {
  const m = await freshPrompts('ollama');
  const out = m.buildLektoratPrompt('Text.', { figuren: [{ name: 'Anna' }], orte: [{ name: 'Berlin' }] });
  // Local-Enum darf neue Typen NICHT enthalten
  for (const t of ['filterwort', 'klischee', 'pleonasmus', 'namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal']) {
    assert.ok(!out.includes(t), `Local-Modus darf «${t}» nicht referenzieren`);
  }
  assert.ok(!out.includes('Filterwort-Regeln'));
  assert.ok(!out.includes('Figurenkonsistenz-Regeln'));
});

test('SCHEMA_LEKTORAT (claude): enum umfasst alle 19 Cloud-Typen', async () => {
  const m = await freshPrompts('claude');
  const e = m.SCHEMA_LEKTORAT?.properties?.fehler?.items?.properties?.typ?.enum;
  assert.ok(Array.isArray(e), 'enum-Array fehlt im Schema');
  assert.equal(e.length, 19);
  for (const t of ['filterwort', 'klischee', 'pleonasmus', 'ki_geruch', 'dialogformat', 'namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal']) {
    assert.ok(e.includes(t), `Schema-enum fehlt «${t}»`);
  }
});

// ── Multi-Block Cache-Schichten ──────────────────────────────────────────────
// Job-Sites holen SYSTEM_*_BLOCKS statt SYSTEM_* — wenn buchtyp/freitext/isFinished
// gesetzt, splittet getLocalePromptsForBook in zwei Cache-Blöcke: stabiler Core
// (1h-TTL) + buchspezifischer Kontext (ephemeral). Sonst fallback auf String.

test('SYSTEM_LEKTORAT_BLOCKS: ohne Buchkontext → String (Backward-Compat)', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', null, '', false);
  assert.equal(typeof out.SYSTEM_LEKTORAT_BLOCKS, 'string',
    'Ohne Buchkontext muss _BLOCKS ein String sein, kein Array');
  assert.equal(out.SYSTEM_LEKTORAT_BLOCKS, out.SYSTEM_LEKTORAT,
    'String-Form muss identisch zum SYSTEM_LEKTORAT-String sein');
});

test('SYSTEM_LEKTORAT_BLOCKS: mit Buchtyp → 2-Block-Array mit 1h-TTL-Hint', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'krimi', '', false);
  assert.ok(Array.isArray(out.SYSTEM_LEKTORAT_BLOCKS),
    'Mit Buchtyp muss _BLOCKS ein Array sein');
  assert.equal(out.SYSTEM_LEKTORAT_BLOCKS.length, 2,
    'Genau zwei Cache-Blöcke: stabiler Core + buchspezifischer Kontext');
  assert.equal(out.SYSTEM_LEKTORAT_BLOCKS[0].ttl, '1h',
    'Erster Block (Core) muss 1h-TTL haben — buchübergreifender Cache');
  assert.equal(out.SYSTEM_LEKTORAT_BLOCKS[1].ttl, undefined,
    'Zweiter Block (BookContext) bleibt ephemeral (5min Default)');
});

test('SYSTEM_LEKTORAT_BLOCKS: Core enthält KEINEN BUCHTYP-KONTEXT, BookContext schon', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'krimi', '', false);
  assert.doesNotMatch(out.SYSTEM_LEKTORAT_BLOCKS[0].text, /BUCHTYP-KONTEXT/,
    'Core muss buchunabhängig sein — Cache-Hit über Bücher hinweg');
  assert.match(out.SYSTEM_LEKTORAT_BLOCKS[1].text, /BUCHTYP-KONTEXT/,
    'BookContext-Block enthält den Buchtyp-Zusatz');
});

test('SYSTEM_*_BLOCKS: alle Job-relevanten Prompts haben _BLOCKS-Variante', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'krimi', 'Mars 2189.', true);
  for (const key of [
    'SYSTEM_LEKTORAT_BLOCKS', 'SYSTEM_BUCHBEWERTUNG_BLOCKS',
    'SYSTEM_KAPITELANALYSE_BLOCKS', 'SYSTEM_KAPITELREVIEW_BLOCKS',
    'SYSTEM_FIGUREN_BLOCKS', 'SYSTEM_STILKORREKTUR_BLOCKS',
    'SYSTEM_ORTE_BLOCKS', 'SYSTEM_KONTINUITAET_BLOCKS', 'SYSTEM_ZEITSTRAHL_BLOCKS',
    'SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS',
    'SYSTEM_KOMPLETT_FIGUREN_PASS_BLOCKS', 'SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS',
  ]) {
    assert.ok(Array.isArray(out[key]), `${key} muss Array sein bei nicht-leerem Buchkontext`);
    assert.equal(out[key].length, 2, `${key} muss 2 Blöcke haben`);
    assert.equal(out[key][0].ttl, '1h', `${key}[0] muss 1h-TTL haben`);
  }
});

test('SYSTEM_*_BLOCKS: BookContext-Block enthält alle aktivierten Sektionen', async () => {
  const m = await freshPrompts('claude');
  const out = m.getLocalePromptsForBook('de-CH', 'krimi', 'Spielt 1893 in Zürich.', true);
  const ctxBlock = out.SYSTEM_LEKTORAT_BLOCKS[1].text;
  assert.match(ctxBlock, /BUCHTYP-KONTEXT/);
  assert.match(ctxBlock, /VORRANGIGE ANGABEN DES AUTORS/);
  assert.match(ctxBlock, /Spielt 1893 in Zürich/);
  assert.match(ctxBlock, /WERK ABGESCHLOSSEN/);
});

test('SCHEMA_LEKTORAT (ollama): enum bleibt auf 6 Local-Typen beschränkt', async () => {
  const m = await freshPrompts('ollama');
  const e = m.SCHEMA_LEKTORAT?.properties?.fehler?.items?.properties?.typ?.enum;
  assert.ok(Array.isArray(e));
  assert.equal(e.length, 6);
  for (const t of ['filterwort', 'klischee', 'pleonasmus', 'namenskonsistenz']) {
    assert.ok(!e.includes(t), `Local-Schema darf «${t}» nicht enthalten`);
  }
});
