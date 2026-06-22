// Icon-Sprite-Integrität (public/icons.svg):
//  1. Jede Symbol-ID kommt genau einmal vor (keine doppelte Definition — die
//     zweite würde die erste im Sprite still überschreiben).
//  2. Jede `<use href="/icons.svg...#NAME">`-Referenz im Frontend löst auf ein
//     existierendes Symbol auf (kein Tippfehler → unsichtbares Icon).
// Reine statische Analyse, kein Browser. Dynamisch zusammengebaute `#`-Refs
// (String-Konkat) deckt der Test bewusst nicht ab — die gibt es aktuell nicht.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SPRITE = join(ROOT, 'public', 'icons.svg');

function spriteIds() {
  const svg = readFileSync(SPRITE, 'utf8');
  const ids = [];
  for (const m of svg.matchAll(/<symbol\s+id="([^"]+)"/g)) ids.push(m[1]);
  return ids;
}

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue; // fremde Libs nicht prüfen
      walk(p, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

test('icons.svg: jede Symbol-ID ist unique', () => {
  const ids = spriteIds();
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.equal(dupes.length, 0, `Doppelte Symbol-IDs im Sprite: ${dupes.join(', ')}`);
  assert.ok(ids.length > 0, 'Sprite enthält keine Symbole?');
});

test('jede icons.svg-Referenz im Frontend existiert im Sprite', () => {
  const valid = new Set(spriteIds());
  const files = walk(join(ROOT, 'public'), ['.html', '.js']);
  const refRe = /icons\.svg[^"')\s]*#([a-z0-9-]+)/g;
  const broken = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(refRe)) {
      if (!valid.has(m[1])) {
        broken.push(`${file.slice(ROOT.length + 1)} → #${m[1]}`);
      }
    }
  }
  assert.equal(broken.length, 0, `Referenz auf nicht existierendes Icon:\n  ${broken.join('\n  ')}`);
});
