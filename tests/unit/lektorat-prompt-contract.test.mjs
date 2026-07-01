// Prompt-Contract-Test für das Lektorat: verankert die kritischen Invarianten-
// Instruktionen im gebauten Prompt, damit ein Refactor sie nicht STILL entfernt.
//
// Dies ist kein Output-Qualitäts-Eval (das läuft manuell gegen die echte KI via
// `npm run eval:lektorat`), sondern ein Drift-Schutz auf Prompt-STRUKTUR-Ebene:
// jeder Block, der empirisch messbaren Effekt hat (Korrektur-Purität, Zeichen-
// genauigkeit, Anti-Doppelung, Schwere-Schwelle, Selbstkontroll-Pass, das
// VERWORFENE Few-Shot-Beispiel, die XML-Sektionierung), muss im Cloud-Prompt
// vorhanden bleiben. Der lokale Prompt lässt bewusst einen Teil weg – auch das
// wird gegengeprüft, damit die _isLocal-Reduktion nicht versehentlich kippt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
const prompts = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts.js')).href);

const SAMPLE = 'Es war ein warmer Tag. Sie ging zum Fluss.';

function buildCloud() {
  prompts.configurePrompts(cfg, 'claude');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' });
}
function buildLocal() {
  prompts.configurePrompts(cfg, 'ollama');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' });
}

// Cloud-Prompt: alle wirkungsstarken Blöcke müssen vorhanden sein.
const CLOUD_INVARIANTS = [
  ['XML-Aufgabe',            '<aufgabe>'],
  ['Output-Format',          '<output_format>'],
  ['Originaltext-Wrapper',   '<originaltext'],
  ['Korrektur-Purität',      'KORREKTUR-PURITÄT'],
  ['Zeichengenauigkeit',     'ZEICHENGENAUIGKEIT von «original»'],
  ['Span-Typ-Konsistenz',    'SPAN-TYP-KONSISTENZ'],
  ['Anti-Doppelung',         'EIN-EINTRAG-PRO-STELLE'],
  ['Schwere-Schwelle',       'SCHWERE-SCHWELLE'],
  ['Selbstkontroll-Pass',    'SELBSTKONTROLL-PASS'],
  ['Verworfenes Few-Shot',   'Beispiel eines VERWORFENEN Eintrags'],
  ['Gutes Few-Shot',         'Beispiel eines GUTEN Eintrags'],
  ['Zusammenfassungs-Disjunktion', 'ZUSAMMENFASSUNGS-DISJUNKTION'],
  ['Mechanik-Ausnahme (nie streichen)', 'MECHANISCHE FEHLER'],
];

test('Cloud-Lektorat-Prompt enthält alle Invarianten-Blöcke', () => {
  const p = buildCloud();
  for (const [label, needle] of CLOUD_INVARIANTS) {
    assert.ok(p.includes(needle), `Cloud-Prompt fehlt Block: ${label} («${needle}»)`);
  }
});

test('Cloud-Lektorat-Prompt liefert das volle Typ-Enum + szenen/stilanalyse/fazit', () => {
  const p = buildCloud();
  for (const typ of ['show_vs_tell', 'ki_geruch', 'perspektivbruch', 'tempuswechsel', 'dialogformat', 'namenskonsistenz']) {
    assert.ok(p.includes(typ), `Cloud-Prompt fehlt Typ: ${typ}`);
  }
  assert.ok(p.includes('"szenen"'), 'Cloud-Schema muss szenen enthalten');
  assert.ok(p.includes('"stilanalyse"'), 'Cloud-Schema muss stilanalyse enthalten');
  assert.ok(p.includes('"fazit"'), 'Cloud-Schema muss fazit enthalten');
});

test('Lokaler Lektorat-Prompt ist bewusst reduziert (kein Schwere-/Selbstkontroll-Block, keine szenen)', () => {
  const local = buildLocal();
  assert.ok(!local.includes('SCHWERE-SCHWELLE'), 'Lokal: keine Schwere-Schwelle');
  assert.ok(!local.includes('SELBSTKONTROLL-PASS'), 'Lokal: kein Selbstkontroll-Pass');
  assert.ok(!local.includes('"szenen"'), 'Lokal: kein szenen-Schema');
  // Der spezialisierte Show-vs-Tell-REGELBLOCK ist cloud-only (der bloße Token
  // «show_vs_tell» taucht lokal noch im Anti-Doppelungs-Beispiel auf – daher am
  // Blockheader prüfen, nicht am Token).
  assert.ok(!local.includes('Show-vs-Tell-Regeln'), 'Lokal: kein Show-vs-Tell-Regelblock');
  assert.ok(!local.includes('KI-Geruch-Regeln'), 'Lokal: kein KI-Geruch-Regelblock');
  // ...aber die Kern-Puritäts-Invarianten bleiben auch lokal:
  assert.ok(local.includes('KORREKTUR-PURITÄT'), 'Lokal: Korrektur-Purität muss bleiben');
  assert.ok(local.includes('ZEICHENGENAUIGKEIT von «original»'), 'Lokal: Zeichengenauigkeit muss bleiben');
  assert.ok(local.includes('EIN-EINTRAG-PRO-STELLE'), 'Lokal: Anti-Doppelung muss bleiben');
  // Reconfigure zurück auf Cloud, damit nachfolgende Suites den Default-State sehen.
  prompts.configurePrompts(cfg, 'claude');
});

test('Systemprompt trägt Rolle + „leerer Output > falscher Output"-Haltung', () => {
  prompts.configurePrompts(cfg, 'claude');
  const sys = prompts.SYSTEM_LEKTORAT || '';
  assert.ok(/Lektor/i.test(sys), 'Systemprompt nennt die Lektor-Rolle');
  assert.ok(/Leerer Output ist besser/i.test(sys), 'Systemprompt trägt die Konservativ-Haltung');
});
