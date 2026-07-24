// Motiv-Scan — Recall-Helfer: Trigger-Prefix (deutsche Flexion) + buchgrössen-
// abhängiges Fundstellen-Cap (TOP_K). Reine Funktionen, kein DB/AI nötig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _triggerQuery, _computeTopK } = require('../../routes/jobs/motif-scan.js');

test('_triggerQuery: Einzelwörter ab 5 Zeichen werden Präfix (Flexion), kurze bleiben exakt', () => {
  // Lange Einzelwörter → Präfix (fängt Wassers/Wasserns/Wasserfall).
  assert.equal(_triggerQuery('Wasser'), 'Wasser*');
  assert.equal(_triggerQuery('Spiegel'), 'Spiegel*');
  // Kurze Wörter bleiben exakt (Präfix überdehnte: See* → Seele).
  assert.equal(_triggerQuery('See'), 'See');
  assert.equal(_triggerQuery('Weg'), 'Weg');
  // Genau an der Schwelle (5) → Präfix.
  assert.equal(_triggerQuery('Blume'), 'Blume*');
});

test('_triggerQuery: vom Autor gesetztes * bleibt, Mehrwort geht unverändert durch', () => {
  assert.equal(_triggerQuery('Wass*'), 'Wass*');          // eigenes Präfix respektiert
  assert.equal(_triggerQuery('das Lied'), 'das Lied');    // Mehrwort: buildMatchQuery UND-verknüpft
  assert.equal(_triggerQuery('  '), '');                  // leer bleibt leer
  assert.equal(_triggerQuery(null), '');
});

test('_computeTopK: skaliert mit der Buchgrösse, unten/oben geklammert', () => {
  assert.equal(_computeTopK(0), 40);      // leeres/kleines Buch → Basis
  assert.equal(_computeTopK(50), 40);     // unter Basis-Schwelle → Basis
  assert.equal(_computeTopK(200), 100);   // 200 × 0.5
  assert.equal(_computeTopK(1000), 500);  // gedeckelt bei Max
  assert.equal(_computeTopK(5000), 500);  // bleibt gedeckelt
});
