// Server-seitiger Tripwire: BookStack-API darf nur ueber das BookStack-Backend
// der Content-Store-Facade erreichbar sein. Direkte `bs*`-Aufrufe in
// Routen/Jobs/Libs sind ein Architektur-Verstoss — siehe Phase 1 des Plans
// (docs/bookstack-exit.md).
//
// Erlaubt: lib/bookstack.js (Wrapper-Definition),
//          lib/content-store/backends/bookstack.js (Backend-Variante),
//          routes/sync.js (Per-User-Replica-Worker),
//          routes/jobs/shared/bookstack.js (Job-Helper mit Token-Context).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const SCAN_DIRS = [
  join(REPO_ROOT, 'routes'),
  join(REPO_ROOT, 'lib'),
];

// Erlaubte Aufrufer von `bs*`-Wrappern (Phase 1):
//   - lib/bookstack.js: Definition der Wrapper.
//   - lib/content-store/backends/bookstack.js: BookStack-Backend der Facade.
//   - routes/sync.js: Per-User-Replica-Worker (Cron + manueller Sync).
//   - routes/jobs/shared/bookstack.js: Job-Helper, der Token-Context fuer
//     Buch-Settings-Reads braucht.
const ALLOW_BS_CALLERS = new Set([
  'lib/bookstack.js',
  'lib/content-store/backends/bookstack.js',
  'routes/sync.js',
  'routes/jobs/shared/bookstack.js',
]);
const ALLOW_PREFIXES = [];

const BS_RE = /\bbs(Get|GetAll|Put|Post|Delete|Batch)\b/;
// Direkter BookStack-URL- oder /api/-Zugriff ohne content-store dazwischen.
// Routen, die `/api/...` rauspipen (OAuth, OpenThesaurus, Anthropic etc.),
// matchen das BS_RE nicht und werden hier sondergeprueft. Pfade ausserhalb
// von lib/bookstack.js + lib/content-store.js duerfen weder die BookStack-
// Origin direkt referenzieren noch `/api/`-Pfade dorthin bauen.
const BOOKSTACK_URL_RE = /\bBOOKSTACK_URL\b/;

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

// Routen/Libs duerfen BookStack-Origin nicht direkt referenzieren — alles geht
// ueber content-store. routes/proxies.js bleibt als Allowed: CSP-Origin-
// Berechnung + `/api/*`-Proxy-Mount fuer den BookStack-Pass-Through.
const ALLOW_BS_URL = new Set([
  'lib/bookstack.js',
  'lib/content-store/backends/bookstack.js',
  'routes/proxies.js',
  'lib/pdf-render/images.js', // Asset-Proxy: BookStack-Image-URLs aufloesen
]);

test('no direct BOOKSTACK_URL reference outside content-store / lib/bookstack / proxies-mount', () => {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOW_BS_URL.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = stripComments(lines[i]);
        if (BOOKSTACK_URL_RE.test(line)) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.equal(violations.length, 0,
    'Direkter BOOKSTACK_URL-Zugriff ausserhalb content-store:\n  ' + violations.join('\n  '));
});
