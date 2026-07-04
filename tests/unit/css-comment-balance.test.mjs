// Tripwire fuer verwaiste CSS-Kommentar-Marker.
// Bug-Klasse: Beim Umformulieren eines Kommentars bleibt ein zweites `*/` stehen —
// der Kommentar ist bereits geschlossen, danach steht nackter Text plus ein
// erneutes `*/` auf Top-Level. Fuer den CSS-Parser ist das Muell; bei der
// Fehler-Recovery frisst er alles bis zum naechsten `{ … }`-Block — also genau
// die naechste Regel, die dadurch stillschweigend komplett verworfen wird.
// Der Scanner trackt den Kommentar-Status Zeichen fuer Zeichen und meldet jedes
// `*/` ausserhalb eines offenen Kommentars sowie am EOF offene Kommentare.
// Prosa-Regel = Vorschlag, Test = Gesetz. Neuer Verstoss → CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(REPO_ROOT, 'public', 'css');

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);

function findCommentImbalance(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  let inComment = false;
  let line = 1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') line++;
    const two = src.slice(i, i + 2);
    if (!inComment) {
      if (two === '/*') { inComment = true; i++; continue; }
      if (two === '*/') {
        out.push(`${rel(file)}:${line}: verwaistes "*/" ausserhalb eines Kommentars`);
        i++;
      }
    } else if (two === '*/') {
      inComment = false;
      i++;
    }
  }
  if (inComment) out.push(`${rel(file)}: am EOF nicht geschlossener Kommentar`);
  return out;
}

test('no orphan CSS comment close markers (Kommentar-Balance)', () => {
  const violations = walk(CSS_DIR, '.css').flatMap(findCommentImbalance);
  assert.equal(
    violations.length,
    0,
    'Verwaister CSS-Kommentar-Marker — Parser-Recovery frisst die naechste Regel:\n  ' +
      violations.join('\n  '),
  );
});
