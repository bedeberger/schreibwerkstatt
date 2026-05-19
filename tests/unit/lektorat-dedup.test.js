'use strict';
// Tests fuer dedupFehler aus routes/jobs/lektorat.js.
//
// AI-Output (insb. lokale Modelle) enthaelt gelegentlich byte-gleiche
// Duplikate desselben Findings — typisch bei mehrfachem Vorkommen eines
// fehlerhaften Tokens. Da `original` fuer Replace-Logik als Match-String
// dient, reicht ein Eintrag; Duplikate muellen die Findings-Liste zu.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

// Temp-DB, damit das Laden von lektorat.js (→ db/schema.js) keine Live-DB anfasst.
process.env.DB_PATH = path.join(os.tmpdir(), `schreibwerkstatt-lektorat-dedup-${process.pid}-${Date.now()}.db`);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
require('../../db/migrations');

const { dedupFehler } = require('../../routes/jobs/lektorat');

test('dedupFehler entfernt byte-gleiche Duplikate (gleicher typ+original+korrektur)', () => {
  const input = [
    { typ: 'rechtschreibung', original: 'warscheinlich', korrektur: 'wahrscheinlich', kontext: 'irgendwas', erklaerung: 'Tippfehler' },
    { typ: 'rechtschreibung', original: 'warscheinlich', korrektur: 'wahrscheinlich', kontext: 'irgendwas', erklaerung: 'Tippfehler' },
    { typ: 'grammatik', original: 'Plöztlich', korrektur: 'Plötzlich', kontext: 'Plöztlich fror ich', erklaerung: 'Tippfehler' },
  ];
  const out = dedupFehler(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].original, 'warscheinlich');
  assert.equal(out[1].original, 'Plöztlich');
});

test('dedupFehler behaelt unterschiedliche Korrekturen fuer gleiches Original', () => {
  const input = [
    { typ: 'stil', original: 'einfach', korrektur: 'simpel', kontext: 'a', erklaerung: 'x' },
    { typ: 'stil', original: 'einfach', korrektur: 'klar', kontext: 'b', erklaerung: 'y' },
  ];
  assert.equal(dedupFehler(input).length, 2);
});

test('dedupFehler unterscheidet typen', () => {
  const input = [
    { typ: 'rechtschreibung', original: 'foo', korrektur: 'bar' },
    { typ: 'grammatik',       original: 'foo', korrektur: 'bar' },
  ];
  assert.equal(dedupFehler(input).length, 2);
});

test('dedupFehler haelt leeres/null-Korrektur-Feld stabil', () => {
  const input = [
    { typ: 'stil', original: 'foo' },
    { typ: 'stil', original: 'foo' },
    { typ: 'stil', original: 'foo', korrektur: null },
  ];
  // null/undefined kollabieren beide auf '' im Key → alle drei sind Duplikate.
  assert.equal(dedupFehler(input).length, 1);
});

test('dedupFehler behaelt Reihenfolge des ersten Vorkommens', () => {
  const input = [
    { typ: 'stil', original: 'B' },
    { typ: 'stil', original: 'A' },
    { typ: 'stil', original: 'B' },
  ];
  const out = dedupFehler(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].original, 'B');
  assert.equal(out[1].original, 'A');
});
