// Tripwire: kein Lesen von Store-Feldern ueber den Root.
//
// Geteilter State lebt in `Alpine.store(...)` (docs/state-modell.md, Ebene 3).
// Ein Root-Proxy, der Store-Felder unter ihrem alten Namen am Root spiegelt,
// existiert fuer keinen Store (architecture-tripwire.test.mjs). Ein
// `window.__app?.selectedBookId` oder `$app.uiLocale` liefert darum still
// `undefined` — kein Fehler, nur eine Karte, die nie laedt oder in der
// Default-Locale formatiert.
//
// Die Feldliste wird aus den Store-Definitionen (`cards/*-store.js`) gezogen,
// neue Store-Felder sind also automatisch abgedeckt. Ausgenommen sind Namen, die
// zugleich als Root-Feld in app-state.js deklariert sind (dort ist `$app.x` legitim).
//
// Richtig: `Alpine.store('<name>').<feld>` (JS), `$store.<name>.<feld>` (Template).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PUBLIC_DIR = join(REPO_ROOT, 'public');
const CARDS_DIR = join(PUBLIC_DIR, 'js', 'cards');
const APP_STATE = join(PUBLIC_DIR, 'js', 'app', 'app-state.js');

// Kommentare raus, Zeilenumbrueche bleiben (Zeilennummern der Treffer stimmen).
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

// Top-Level-Keys des Objekt-Literals in `Alpine.store('<name>', { … })`.
function storeFields(src) {
  const m = src.match(/Alpine\.store\(\s*'(\w+)'\s*,\s*\{/);
  if (!m) return null;
  const keys = [];
  let j = m.index + m[0].length, depth = 1, atKey = true;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (depth === 1 && atKey) {
      const mm = src.slice(j).match(/^\s*(?:get\s+|set\s+|async\s+)?([A-Za-z_$][\w$]*)\s*[:(]/);
      if (mm) {
        keys.push(mm[1]);
        atKey = false;
        j += mm[0].length;
        if (mm[0].endsWith('(')) depth++;
        continue;
      }
    }
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (depth === 1 && c === ',') atKey = true;
    else if (c === "'" || c === '"' || c === '`') {
      j++;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
    }
    j++;
  }
  return { name: m[1], keys };
}

const stores = new Map(); // feld → store
for (const entry of readdirSync(CARDS_DIR)) {
  if (!entry.endsWith('-store.js')) continue;
  const parsed = storeFields(stripJsComments(readFileSync(join(CARDS_DIR, entry), 'utf8')));
  if (!parsed) continue;
  for (const k of parsed.keys) if (!stores.has(k)) stores.set(k, parsed.name);
}

const rootKeys = new Set(
  [...readFileSync(APP_STATE, 'utf8').matchAll(/^\s+([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]),
);
const forbidden = [...stores.keys()].filter(k => !rootKeys.has(k));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|html)$/.test(entry)) out.push(full);
  }
  return out;
}

test('Store-Feldliste ist nicht leer (Parser greift)', () => {
  for (const k of ['selectedBookId', 'uiLocale', 'currentUser', 'figuren', 'appTimezone']) {
    assert.ok(forbidden.includes(k), `Store-Feld ${k} fehlt in der abgeleiteten Liste`);
  }
});

test('kein window.__app.<storeFeld> / $app.<storeFeld>', () => {
  const alt = forbidden.map(k => k.replace(/\$/g, '\\$')).join('|');
  const re = new RegExp(`(?:window\\.__app\\??\\.|\\$app\\.)(${alt})\\b`, 'g');
  const hits = [];
  for (const file of walk(PUBLIC_DIR)) {
    const raw = readFileSync(file, 'utf8');
    const src = file.endsWith('.html') ? raw.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')) : stripJsComments(raw);
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split('\n').length;
      hits.push(`${relative(REPO_ROOT, file)}:${line} ${m[0]} → Alpine.store('${stores.get(m[1])}').${m[1]}`);
    }
  }
  assert.deepEqual(hits, [], `Store-Felder ueber den Root gelesen (kein Root-Proxy):\n  ${hits.join('\n  ')}`);
});
