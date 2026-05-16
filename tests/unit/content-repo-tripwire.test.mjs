// Tripwire-Test: BookStack-API darf nur ueber den dafuer vorgesehenen Layer
// erreichbar sein. Caller, die direkt `/api/`-Pfade oder die `bs*`-Wrapper
// ausserhalb der Allowlist verwenden, sind ein Architektur-Verstoss gegen
// die Repo-Indirektion (docs/bookstack-exit.md, Schritt 6).
//
// Hier zaehlen NUR die Pfade, die schon migriert sind (Editor + Lektorat +
// Chat + History + Tree-Reads + Page-Writes). Strukturoperationen (Create/
// Rename/Reorder/Delete von Kapiteln+Seiten) sind bewusst noch nicht migriert
// und stehen separat in der Allowlist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const ROOT = join(REPO_ROOT, 'public/js');

// Dateien, in denen `bs*`/`/api/`-Aufrufe legitim sind:
//   - api-bookstack.js: Definition der bs*-Wrapper.
//   - repo/content.js: nutzt ausschliesslich /content/*, kein /api/.
//   - bookstack-search.js: Suche, separater Migrations-Step (Schritt 7 Phase).
// Strukturoperationen (deferred bis Strukturen-Sub-Step):
//   - tree.js (bsPost chapters), book-settings.js (bsDelete books),
//     cards/kapitel-review-card.js (bsPost pages), cards/book-organizer-card.js.
const ALLOW_API_OR_BS = new Set([
  'api-bookstack.js',
  'bookstack-search.js',
  'tree.js',
  'book-settings.js',
  'cards/kapitel-review-card.js',
  'cards/book-organizer-card.js',
]);

const BS_RE = /\bbs(Get|GetAll|Put|Post|Delete)\b/;
const API_RE = /['"`]\/api\//;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripCommentsAndStrings(line) {
  // Kommentare entfernen, damit `// bsPut`-Erwaehnungen in Doku nicht failen.
  const trim = line.trim();
  if (trim.startsWith('//')) return '';
  // JSDoc-/Block-Kommentar-Zeilen (`* text` / `/* text` / `*/`) ignorieren.
  if (trim.startsWith('*') || trim.startsWith('/*')) return '';
  const idx = line.indexOf('//');
  if (idx >= 0) line = line.slice(0, idx);
  return line;
}

test('no /api/ fetch or bs* call outside the explicit allow-list', () => {
  const files = walk(ROOT);
  const violations = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (ALLOW_API_OR_BS.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = stripCommentsAndStrings(lines[i]);
      if (BS_RE.test(line)) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      if (API_RE.test(line)) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  assert.equal(violations.length, 0,
    'Direkter /api/- oder bs*-Zugriff ausserhalb der Allowlist:\n  ' + violations.join('\n  '));
});
