// Tripwire fuer drei prosa-Hartregeln aus CLAUDE.md, die sonst nur als Text
// existieren und unter Kontextdruck driften:
//   1. UI-Strings: de.json und en.json MUESSEN identische Key-Mengen haben.
//   2. Styles nur in public/css/ — kein statisches `style="`-Attribut in Partials
//      (dynamisches `:style="` ist erlaubt, z.B. das verpflichtende Progress-Bar-
//      Pattern `:style="{ '--progress': ... }"`).
//   3. Combobox statt <select> — kein natives <select> in Partials, ausser den
//      explizit erlaubten Admin-/technischen Settings (admin-*.html).
// Prosa-Regel = Vorschlag, Test = Gesetz. Neuer Verstoss → CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const I18N_DIR = join(REPO_ROOT, 'public', 'js', 'i18n');

// Generierter Snapshot + Legacy-Migrations-Chain + die NOW_ISO_SQL-Definition
// selbst sind von der datetime('now')-Regel ausgenommen (dort ist der Wert
// dokumentiert bzw. spiegelt absichtlich Alt-Defaults).
const DATETIME_SKIP = new Set([
  join(REPO_ROOT, 'db', 'squashed-schema.js'),
  join(REPO_ROOT, 'db', 'migrations.js'),
  join(REPO_ROOT, 'db', 'now.js'),
]);
const DATETIME_SCAN_DIRS = [
  join(REPO_ROOT, 'db'),
  join(REPO_ROOT, 'routes'),
  join(REPO_ROOT, 'lib'),
];

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkJs(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripJsComments(line) {
  const trim = line.trim();
  if (trim.startsWith('//') || trim.startsWith('*') || trim.startsWith('/*')) return '';
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

function partialFiles() {
  return readdirSync(PARTIALS_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => join(PARTIALS_DIR, f));
}

// HTML-Kommentare (<!-- ... -->) entfernen, damit Doku-Hinweise im Markup
// keine False-Positives erzeugen.
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

function flattenKeys(obj, prefix = '', out = {}) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, key, out);
    else out[key] = true;
  }
  return out;
}

test('i18n: de.json und en.json haben identische Key-Mengen', () => {
  const de = JSON.parse(readFileSync(join(I18N_DIR, 'de.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(I18N_DIR, 'en.json'), 'utf8'));
  const fd = flattenKeys(de);
  const fe = flattenKeys(en);
  const deOnly = Object.keys(fd).filter((k) => !fe[k]);
  const enOnly = Object.keys(fe).filter((k) => !fd[k]);
  assert.equal(
    deOnly.length + enOnly.length,
    0,
    'i18n-Key-Drift — jeder String gehoert in BEIDE Locales:\n' +
      (deOnly.length ? `  nur in de.json: ${deOnly.join(', ')}\n` : '') +
      (enOnly.length ? `  nur in en.json: ${enOnly.join(', ')}` : ''),
  );
});

test('no static style="" attribute in partials (dynamisches :style erlaubt)', () => {
  // `\sstyle=` matcht ` style="` aber nicht ` :style="` (Zeichen vor "style"
  // ist dort ":") und nicht `x-bind:style`/`data-style`.
  const STATIC_STYLE_RE = /\sstyle\s*=\s*["']/;
  const violations = [];
  for (const file of partialFiles()) {
    const rel = relative(REPO_ROOT, file);
    const lines = stripHtmlComments(readFileSync(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (STATIC_STYLE_RE.test(lines[i])) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  assert.equal(
    violations.length,
    0,
    'Statisches inline style="" gefunden — Styles gehoeren nach public/css/:\n  ' +
      violations.join('\n  '),
  );
});

test('no native <select> in partials (Combobox-Pflicht, ausser admin-*.html)', () => {
  const SELECT_RE = /<select\b/;
  const violations = [];
  for (const file of partialFiles()) {
    const rel = relative(REPO_ROOT, file);
    // Admin-/technische Settings sind die dokumentierte Ausnahme (Modell-IDs,
    // Flavours, native Picker).
    if (/\/admin-[^/]+\.html$/.test(rel.replace(/\\/g, '/'))) continue;
    const lines = stripHtmlComments(readFileSync(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (SELECT_RE.test(lines[i])) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  assert.equal(
    violations.length,
    0,
    'Natives <select> gefunden — Alpine.data("combobox") verwenden:\n  ' + violations.join('\n  '),
  );
});

test('no <details>/<summary> in partials (collapsible-toggle-Pflicht)', () => {
  const DETAILS_RE = /<\/?(details|summary)\b/i;
  const violations = [];
  for (const file of partialFiles()) {
    const rel = relative(REPO_ROOT, file);
    const lines = stripHtmlComments(readFileSync(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (DETAILS_RE.test(lines[i])) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  assert.equal(
    violations.length,
    0,
    'Natives <details>/<summary> gefunden — .collapsible-toggle + .history-chevron verwenden:\n  ' +
      violations.join('\n  '),
  );
});

test('no <style> block in partials (Styles nur in public/css/)', () => {
  const violations = [];
  for (const file of partialFiles()) {
    const rel = relative(REPO_ROOT, file);
    const lines = stripHtmlComments(readFileSync(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/<style\b/i.test(lines[i])) violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  assert.equal(
    violations.length,
    0,
    '<style>-Block gefunden — Styles gehoeren nach public/css/:\n  ' + violations.join('\n  '),
  );
});

test("no datetime('now') in code-paths (NOW_ISO_SQL-Pflicht, WHERE-Vergleich erlaubt)", () => {
  // Ban auf INSERT/UPDATE/DDL-Defaults. Reine Vergleichs-WHERE-Clauses duerfen
  // datetime('now') behalten — erkennbar an einem zweiten datetime(<spalte>)-Call
  // auf derselben Zeile (z.B. `WHERE datetime(expires_at) < datetime('now')`).
  const NOW_RE = /datetime\(\s*'now'\s*\)/;
  const COMPARISON_RE = /datetime\(\s*(?!'now'\s*\))[^)]+\)/; // datetime(...) mit non-'now'-Arg
  const violations = [];
  for (const dir of DATETIME_SCAN_DIRS) {
    for (const file of walkJs(dir)) {
      if (DATETIME_SKIP.has(file)) continue;
      const rel = relative(REPO_ROOT, file);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = stripJsComments(lines[i]);
        if (NOW_RE.test(line) && !COMPARISON_RE.test(line)) {
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }
  assert.equal(
    violations.length,
    0,
    "datetime('now') in Code-Pfad gefunden — ${NOW_ISO_SQL} aus db/now.js verwenden:\n  " +
      violations.join('\n  '),
  );
});
