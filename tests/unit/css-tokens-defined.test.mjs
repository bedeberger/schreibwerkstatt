// Drift guard: every CSS custom property referenced via var(--x) in public/css
// MUST resolve to a definition — either declared in CSS itself, or injected at
// runtime from JS/HTML (setProperty / Alpine :style bindings). An undefined
// reference silently falls back to the property's initial value (e.g. a typo'd
// `gap: var(--space-4)` collapses to `gap: normal` = 0), which looks like a
// styling bug, not an error. This test makes that class of typo fail loudly.
//
// How a new var(--x) reference stays green:
//   - it names a token/property defined somewhere in public/css, OR
//   - it is a component-local var written at runtime (the literal `--x` then
//     appears in public/js, public/partials or public/index.html), OR
//   - it carries an intentional fallback AND the name is a runtime var (above).
// A typo like `--spcae-md` matches none of these → fails.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PUBLIC = join(ROOT, 'public');

// CSS custom-property names may contain letters, digits, hyphens AND underscores
// (e.g. --card-accent-event-extern_politisch). Underscore in the class is load-bearing.
const NAME = '--[a-zA-Z0-9_-]+';

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

// Tokens set at runtime live in JS/HTML, never in CSS — collect every literal
// `--x` token that appears there so component-local vars don't read as undefined.
function collectRuntimeNames() {
  const files = [
    ...walk(join(PUBLIC, 'js'), ['.js', '.mjs']),
    ...walk(join(PUBLIC, 'partials'), ['.html']),
    join(PUBLIC, 'index.html'),
  ];
  const names = new Set();
  const re = new RegExp(NAME, 'g');
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(re)) names.add(m[0]);
  }
  return names;
}

test('every var(--token) in public/css resolves to a definition', () => {
  const cssFiles = walk(join(PUBLIC, 'css'), ['.css']);
  const defined = new Set();
  const referenced = new Map(); // name -> Set(relative file paths)

  const defRe = new RegExp(`(${NAME})\\s*:`, 'g');
  const refRe = new RegExp(`var\\(\\s*(${NAME})`, 'g');

  for (const f of cssFiles) {
    const css = readFileSync(f, 'utf8');
    for (const m of css.matchAll(defRe)) defined.add(m[1]);
    for (const m of css.matchAll(refRe)) {
      if (!referenced.has(m[1])) referenced.set(m[1], new Set());
      referenced.get(m[1]).add(relative(ROOT, f));
    }
  }

  const runtime = collectRuntimeNames();

  const undefinedRefs = [...referenced.keys()]
    .filter((name) => !defined.has(name) && !runtime.has(name))
    .sort();

  const detail = undefinedRefs
    .map((n) => `  ${n}  →  ${[...referenced.get(n)].join(', ')}`)
    .join('\n');

  assert.equal(
    undefinedRefs.length,
    0,
    `Undefined CSS custom properties referenced via var() — define them in public/css/tokens/ ` +
      `(or fix the typo), or — if set at runtime — ensure the literal appears in JS/partials:\n${detail}`,
  );
});
