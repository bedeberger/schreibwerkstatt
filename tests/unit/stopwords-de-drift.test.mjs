// Drift-Schutz: lib/stopwords-de.js (CJS, Server) und
// public/js/shared/stopwords-de.js (ESM, Client) muessen denselben Inhalt
// liefern. Bei Aenderung der Liste beide Files synchron anpassen.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const require_ = createRequire(import.meta.url);

test('stopwords-de: CJS und ESM Spiegel identisch', async () => {
  const cjs = require_(resolve(ROOT, 'lib/stopwords-de.js'));
  const esm = await import(resolve(ROOT, 'public/js/shared/stopwords-de.js'));
  const a = [...cjs.STOPWORDS_DE_BASE].sort();
  const b = [...esm.STOPWORDS_DE_BASE].sort();
  assert.deepEqual(a, b, 'STOPWORDS_DE_BASE driftet zwischen lib/ und public/js/shared/');
});

test('stopwords-de: keine Duplikate', () => {
  const { STOPWORDS_DE_BASE } = require_(resolve(ROOT, 'lib/stopwords-de.js'));
  const set = new Set(STOPWORDS_DE_BASE);
  assert.equal(set.size, STOPWORDS_DE_BASE.length, 'Duplikate in STOPWORDS_DE_BASE');
});
