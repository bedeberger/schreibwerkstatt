// Regressionsschutz nach BookStack-Exit: keine `bs*`-Wrapper-Calls
// (bsGet/bsPut/bsPost/bsDelete/bsBatch/bsGetAll) und kein BOOKSTACK_URL mehr
// im Server-Code. Falls jemals wieder ein BookStack-Pfad eingefuehrt wird,
// scheitert CI sofort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const SCAN_DIRS = [
  join(REPO_ROOT, 'routes'),
  join(REPO_ROOT, 'lib'),
];

const BS_RE = /\bbs(Get|GetAll|Put|Post|Delete|Batch)\b/;
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

test('no bs* wrapper calls in server code', () => {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = relative(REPO_ROOT, file);
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = stripComments(lines[i]);
        if (BS_RE.test(line)) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.equal(violations.length, 0,
    'bs*-Wrapper-Calls gefunden — BookStack-Backend wurde entfernt:\n  ' + violations.join('\n  '));
});

test('no BOOKSTACK_URL reference in server code', () => {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = relative(REPO_ROOT, file);
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = stripComments(lines[i]);
        if (BOOKSTACK_URL_RE.test(line)) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.equal(violations.length, 0,
    'BOOKSTACK_URL-Referenz gefunden — BookStack-Backend wurde entfernt:\n  ' + violations.join('\n  '));
});
