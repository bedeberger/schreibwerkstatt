// Drift guard: every i18n key referenced via a STATIC `t('bereich.feld')` /
// `tRaw('bereich.feld')` call in the SPA (public/js, public/partials) MUST be
// defined in public/js/i18n/de.json. A missing key is silent — `tRaw` returns
// the key string itself, so a typo'd `t('lektorat.savng')` renders the literal
// "lektorat.savng" in the UI instead of throwing. This test makes that class of
// typo fail loudly, and additionally enforces de↔en parity.
//
// Scope / known limits (mirrors css-tokens-defined.test.mjs):
//   - Only LITERAL single-quoted keys containing a dot are checked. Dynamically
//     built keys (`t('lektorat.section.' + name)`, `t(job.error || '…')`) cannot
//     be resolved statically and are skipped — same trade-off as the CSS-var test.
//   - share-reader*.js is excluded: the public SSR reader ships its own injected
//     I18N subset with short, dotless keys (`author_badge`, `send`), not de.json.
//   - i18n.js itself is excluded (defines `tRaw`, contains no UI keys).
//
// A new key stays green by being added to BOTH de.json and en.json (de = Fallback,
// en = Übersetzung) — see CLAUDE.md "UI-Strings nur in public/js/i18n/{de,en}.json".

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PUBLIC = join(ROOT, 'public');

const de = JSON.parse(readFileSync(join(PUBLIC, 'js/i18n/de.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(PUBLIC, 'js/i18n/en.json'), 'utf8'));

function walk(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

// Matches t('a.b') / tRaw('a.b') / $app.t('a.b') / app.t('a.b').
// Requires at least one dot — the project's key convention (no dotless keys
// exist in de.json), which also excludes the share-reader short keys by design.
const KEY_RE = /\bt(?:Raw)?\(\s*'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'/g;

function collectReferencedKeys() {
  const files = [
    ...walk(join(PUBLIC, 'js'), ['.js', '.mjs']),
    ...walk(join(PUBLIC, 'partials'), ['.html']),
  ].filter((f) => !/share-reader/.test(f) && !f.endsWith('i18n.js'));

  const refs = new Map(); // key -> Set(relative file paths)
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(KEY_RE)) {
      if (!refs.has(m[1])) refs.set(m[1], new Set());
      refs.get(m[1]).add(relative(ROOT, f));
    }
  }
  return refs;
}

test('every static t()/tRaw() key is defined in de.json', () => {
  const refs = collectReferencedKeys();
  const missing = [...refs.keys()].filter((k) => !(k in de)).sort();

  const detail = missing
    .map((k) => `  ${k}  →  ${[...refs.get(k)].join(', ')}`)
    .join('\n');

  assert.equal(
    missing.length,
    0,
    `i18n keys referenced via t()/tRaw() but not defined in public/js/i18n/de.json ` +
      `(add the key to both de.json and en.json, or fix the typo):\n${detail}`,
  );
});

test('de.json and en.json have identical key sets (parity)', () => {
  const deOnly = Object.keys(de).filter((k) => !(k in en)).sort();
  const enOnly = Object.keys(en).filter((k) => !(k in de)).sort();

  assert.equal(
    deOnly.length + enOnly.length,
    0,
    `Locale key sets drifted:\n` +
      (deOnly.length ? `  missing in en.json: ${deOnly.join(', ')}\n` : '') +
      (enOnly.length ? `  missing in de.json: ${enOnly.join(', ')}\n` : ''),
  );
});
