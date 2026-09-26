// Tripwire für die Buch-ACL-Regeln aus CLAUDE.md („Buch-ACL in Body-/Query-
// Routen nur über guardBook"):
//
//   1. Kein `!sendACLError(...)` ausserhalb von lib/acl.js — für einen
//      Nicht-ACL-Fehler liefert sendACLError `null`, `!null` ist `true`, und der
//      Handler läuft ohne Rechteprüfung weiter.
//   2. Kein handgeschriebener `try { requireBookAccess(` in routes/ — dafür gibt
//      es guardBook (antwortet selbst, wirft Nicht-ACL-Fehler weiter, setzt den
//      Log-Context).
//   3. Kein `req.session?.user?.email` / `req.session.user.email` in routes/ —
//      die Session-E-Mail kommt ausschliesslich aus sessionEmail(req).
//
// Kommentarzeilen zählen nicht: die Regeln dürfen in Prosa zitiert werden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function codeLines(file) {
  return readFileSync(file, 'utf8').split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
}

function scan(dirs, re, { skip = new Set() } = {}) {
  const hits = [];
  for (const d of dirs) {
    for (const file of walk(join(REPO_ROOT, d))) {
      const rel = relative(REPO_ROOT, file);
      for (const { text, line } of codeLines(file)) {
        if (!re.test(text)) continue;
        if (skip.has(`${rel}:${text.trim()}`) || skip.has(rel)) continue;
        hits.push(`${rel}:${line}: ${text.trim()}`);
      }
    }
  }
  return hits;
}

test('kein `!sendACLError` ausserhalb von lib/acl.js', () => {
  const hits = scan(['routes', 'lib'], /!\s*sendACLError\s*\(/, { skip: new Set(['lib/acl.js']) });
  assert.deepEqual(hits, [], `Nicht-ACL-Fehler würden als „erlaubt" gedeutet — guardBook verwenden:\n${hits.join('\n')}`);
});

// Einzige bewusste Ausnahme: der Batch-Filter von POST /history/page-stats/batch
// prüft MEHRERE Bücher, antwortet nicht pro Buch und protokolliert einen
// Nicht-ACL-Fehler als eigenen Grund (ACL_CHECK_FAILED) statt den ganzen Batch
// zu verwerfen. guardBook passt dort nicht — es antwortet selbst.
const TRY_REQUIRE_ALLOW = new Set([
  "routes/history/stats.js:try { requireBookAccess(req, ownerBook, 'editor'); allowedBooks.add(ownerBook); }",
]);

test('kein handgeschriebenes `try { requireBookAccess(` in routes/', () => {
  const hits = scan(['routes'], /try\s*\{\s*requireBookAccess\s*\(/, { skip: TRY_REQUIRE_ALLOW });
  assert.deepEqual(hits, [], `guardBook(req, res, bookId, role) verwenden:\n${hits.join('\n')}`);
});

test('keine Session-E-Mail an sessionEmail(req) vorbei in routes/', () => {
  const hits = scan(['routes'], /req\.session\??\.user\??\.email/);
  assert.deepEqual(hits, [], `sessionEmail(req) aus lib/acl.js verwenden:\n${hits.join('\n')}`);
});
