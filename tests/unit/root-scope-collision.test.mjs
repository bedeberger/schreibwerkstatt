// Gate: die Root-Komponente `Alpine.data('lektorat')` (public/js/app.js) entsteht
// aus rund 37 gespreadeten Methoden-Modulen plus Inline-Membern und den
// Root-Getter-Deskriptoren (app/app-root-getters.js). Beim Object-Spread gewinnt
// bei gleichem Namen STILL das spätere Modul — die frühere Methode ist dann
// toter Code, und wer sie aufruft, landet in einer fremden Implementierung.
// Kein Laufzeitfehler, kein Import-Gate-Treffer; sichtbar wird es erst als
// falsches Verhalten an einer Stelle, die niemand mit dem Spread verbindet.
//
// Der Test liest die Spread-Liste aus app.js selbst (keine zweite Liste, die
// driften kann), importiert jedes Modul unter minimalen Browser-Stubs und
// verlangt: jeder Member-Name hat genau EINEN Besitzer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP = path.join(ROOT, 'public/js/app.js');
const SRC = fs.readFileSync(APP, 'utf8');

// ── Browser-Stubs: die Module registrieren beim Import höchstens Listener oder
// lesen Medien-Queries; ausgeführt wird hier keine Methode. ────────────────────
const noop = () => {};
const storeProxy = new Proxy({}, { get: () => ({}) });
globalThis.window = globalThis;
globalThis.document = {
  addEventListener: noop, removeEventListener: noop,
  documentElement: { setAttribute: noop },
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 };
globalThis.sessionStorage = globalThis.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'node', onLine: true }, configurable: true });
globalThis.location = { origin: 'http://localhost', pathname: '/', search: '', hash: '' };
globalThis.Alpine = { store: () => storeProxy, data: noop, magic: noop, directive: noop };
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop });

function namedImports(src) {
  const map = new Map();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    for (const part of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      const [orig, alias] = part.split(/\s+as\s+/).map(s => s.trim());
      map.set(alias || orig, { orig, file: m[2] });
    }
  }
  return map;
}

// Objekt-Literal der Root-Komponente: von `const obj = ({` bis `});` davor
// `Object.defineProperties(obj, …)`.
function rootLiteral(src) {
  const start = src.indexOf('const obj = ({');
  const end = src.indexOf('Object.defineProperties(obj');
  assert.ok(start > 0 && end > start, 'Root-Objekt-Literal in app.js nicht gefunden — Test an die Komposition anpassen.');
  return src.slice(start, end);
}

test('Root-Komponente: jeder Member-Name hat genau einen Besitzer', async () => {
  const imports = namedImports(SRC);
  const literal = rootLiteral(SRC);
  const owners = new Map();
  const own = (name, owner) => {
    if (!owners.has(name)) owners.set(name, []);
    owners.get(name).push(owner);
  };

  // 1) Gespreadete Module (`...xMethods,` bzw. `...initialLektoratState(),`).
  const spreads = [...literal.matchAll(/^\s*\.\.\.(\w+)(\(\))?,/gm)].map(m => ({ name: m[1], call: !!m[2] }));
  assert.ok(spreads.length >= 30, `nur ${spreads.length} Spreads gefunden — Regex kaputt?`);
  for (const s of spreads) {
    const imp = imports.get(s.name);
    assert.ok(imp, `Spread ${s.name} ohne Import in app.js`);
    const mod = await import(pathToFileURL(path.resolve(path.dirname(APP), imp.file)).href);
    let obj = mod[imp.orig];
    if (s.call) obj = obj();
    assert.ok(obj && typeof obj === 'object', `${s.name} ist kein Objekt`);
    for (const k of Object.getOwnPropertyNames(obj)) own(k, s.name);
  }

  // 2) Inline-Member des Literals (4er-Einzug: `get x() {`, `x() {`, `x,`).
  const inline = [...literal.matchAll(/^ {4}(?:get |async )?([A-Za-z_$][\w$]*)\s*(?:\(|,)/gm)].map(m => m[1]);
  assert.ok(inline.length > 5, 'Inline-Member nicht gefunden — Regex kaputt?');
  for (const k of inline) own(k, 'app.js (inline)');

  // 3) Root-Getter-Deskriptoren (Object.defineProperties nach dem Spread).
  const { rootGetterDescriptors } = await import(pathToFileURL(path.join(ROOT, 'public/js/app/app-root-getters.js')).href);
  for (const k of Object.keys(rootGetterDescriptors)) own(k, 'rootGetterDescriptors');

  const dups = [...owners].filter(([, o]) => o.length > 1).map(([k, o]) => `${k}: ${o.join(' + ')}`);
  assert.deepEqual(dups, [], `Namenskollision in der Root-Komponente — das spätere Modul überschreibt still:\n  ${dups.join('\n  ')}`);
});
