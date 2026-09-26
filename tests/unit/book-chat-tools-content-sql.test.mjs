// Tripwire für CLAUDE.md „Content-Store-Facade als einziger Eintrittspunkt für
// Buchinhalte" im Buch-Chat: die Tool-Module unter routes/jobs/book-chat-tools/
// fassen `pages`/`chapters`/`books` nicht per SQL an — auch nicht für einen
// blossen Namens-JOIN. Solche Abfragen liegen in db/book-chat/<bereich>.js
// (bzw. db/content-names.js, db/books.js), das Tool ruft nur die Funktion auf.
//
// Geprüft wird der ganze Dateitext ohne Kommentarzeilen, damit auch ein über
// zwei Zeilen umbrochenes `FROM\n  pages` auffällt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const TOOLS_DIR = join(REPO_ROOT, 'routes', 'jobs', 'book-chat-tools');
const CONTENT_SQL = /\b(FROM|JOIN|UPDATE|INTO)\s+(pages|chapters|books)\b/gi;

function codeText(file) {
  return readFileSync(file, 'utf8').split('\n')
    .map(line => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

test('routes/jobs/book-chat-tools/*.js enthält kein SQL auf pages/chapters/books', () => {
  const files = readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 0, 'keine Tool-Module gefunden — Pfad geändert?');
  const hits = [];
  for (const f of files) {
    const text = codeText(join(TOOLS_DIR, f));
    for (const m of text.matchAll(CONTENT_SQL)) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`routes/jobs/book-chat-tools/${f}:${line}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(hits, [], `Abfrage nach db/book-chat/<bereich>.js verschieben:\n${hits.join('\n')}`);
});

test('Tripwire-Muster greift auch über Zeilenumbrüche', () => {
  const sample = 'db.prepare(`SELECT 1\n  FROM\n    pages p WHERE p.page_id = ?`)';
  assert.equal([...sample.matchAll(CONTENT_SQL)].length, 1);
  assert.equal([...'LEFT JOIN chapters c ON 1'.matchAll(CONTENT_SQL)].length, 1);
  assert.equal([...'FROM page_stats ps'.matchAll(CONTENT_SQL)].length, 0);
});
