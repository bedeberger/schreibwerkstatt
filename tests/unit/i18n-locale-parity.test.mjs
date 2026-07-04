// Hartes Gate für die Locale-Dateien (public/js/i18n/{de,en}.json):
//   (a) beide JSON parsen — fängt den „straight " statt „…" → JSON-Parse-Crash
//       der ganzen SPA"-Fall, den sonst nur der i18n-check-Dev-Hook sah.
//   (b) beide Key-Sätze sind deckungsgleich (Regel: jeder String in DE UND EN).
//
// Bisher deckte das nur der PostToolUse-Hook scripts/hooks/i18n-check.js ab —
// der läuft aber nur lokal bei Edits, nicht in CI und nicht für andere
// Sessions/Contributoren. Fehlender EN-Key oder kaputtes JSON crasht die App
// beim Laden der Locale; das gehört in test:unit.
//
// Die Dateien sind FLACH (Keys wie "common.save", keine verschachtelten
// Objekte) — Key-Vergleich ist Object.keys, deckungsgleich mit dem Hook.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const FILES = {
  de: resolve(ROOT, 'public', 'js', 'i18n', 'de.json'),
  en: resolve(ROOT, 'public', 'js', 'i18n', 'en.json'),
};

function loadParsed() {
  const parsed = {};
  for (const [loc, file] of Object.entries(FILES)) {
    const raw = readFileSync(file, 'utf8');
    try {
      parsed[loc] = JSON.parse(raw);
    } catch (e) {
      assert.fail(
        `${loc}.json lässt sich nicht parsen: ${e.message}\n` +
          '  → die SPA crasht beim Laden dieser Locale. Häufig: straight " statt „…" in DE-Strings.'
      );
    }
  }
  return parsed;
}

test('i18n: beide Locale-Dateien sind valides JSON', () => {
  const parsed = loadParsed();
  // Selbsttest gegen vacuous-grün: die Dateien müssen nennenswert gefüllt sein.
  assert.ok(Object.keys(parsed.de).length > 100, 'de.json wirkt leer — Scan/Pfad prüfen.');
  assert.ok(Object.keys(parsed.en).length > 100, 'en.json wirkt leer — Scan/Pfad prüfen.');
});

test('i18n: de- und en-Keysets sind deckungsgleich', () => {
  const parsed = loadParsed();
  const de = new Set(Object.keys(parsed.de));
  const en = new Set(Object.keys(parsed.en));
  const onlyDe = [...de].filter((k) => !en.has(k)).sort();
  const onlyEn = [...en].filter((k) => !de.has(k)).sort();
  const fmt = (arr) => arr.slice(0, 20).join(', ') + (arr.length > 20 ? ` … (+${arr.length - 20})` : '');
  assert.deepEqual(onlyDe, [], `Keys nur in DE, fehlen in EN (${onlyDe.length}): ${fmt(onlyDe)}`);
  assert.deepEqual(onlyEn, [], `Keys nur in EN, fehlen in DE (${onlyEn.length}): ${fmt(onlyEn)}`);
});
