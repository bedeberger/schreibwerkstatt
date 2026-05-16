// Server-seitiger Tripwire: BookStack-API darf nur ueber lib/content-store.js
// erreichbar sein. Direkte `bs*`-Aufrufe in Routen/Jobs/Libs sind ein
// Architektur-Verstoss gegen die Repo-Indirektion — siehe Schritt 6 des
// Plans (docs/bookstack-exit.md).
//
// Allowlist enthält Dateien, die noch nicht migriert sind (Job-Handler
// rufen direkt bsGet/bsGetAll mit Token aus Job-Context — Migration folgt
// in Schritt 4b/5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const SCAN_DIRS = [
  join(REPO_ROOT, 'routes'),
  join(REPO_ROOT, 'lib'),
];

// Erlaubte Aufrufer von `bs*`-Wrappern: nach Schritt 4b nur noch:
//   - lib/bookstack.js: Definition der Wrapper.
//   - lib/content-store.js: Domain-SSoT, konsumiert bs* intern.
const ALLOW_BS_CALLERS = new Set([
  'lib/bookstack.js',
  'lib/content-store.js',
]);
const ALLOW_PREFIXES = [];

const BS_RE = /\bbs(Get|GetAll|Put|Post|Delete|Batch)\b/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripComments(line) {
  const trim = line.trim();
  if (trim.startsWith('//')) return '';
  if (trim.startsWith('*') || trim.startsWith('/*')) return '';
  const idx = line.indexOf('//');
  if (idx >= 0) line = line.slice(0, idx);
  return line;
}

function isAllowed(rel) {
  if (ALLOW_BS_CALLERS.has(rel)) return true;
  return ALLOW_PREFIXES.some(p => rel.startsWith(p));
}

test('no bs* calls in routes/lib outside content-store + allowed legacy callers', () => {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = relative(REPO_ROOT, file);
      if (isAllowed(rel)) continue;
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = stripComments(lines[i]);
        if (BS_RE.test(line)) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.equal(violations.length, 0,
    'Server-seitiger Direktaufruf von bs* ausserhalb der Allowlist:\n  ' + violations.join('\n  '));
});
