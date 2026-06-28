// Tripwire fuer zwei strukturelle Architektur-Konzepte, die sonst nur als
// Konvention existieren und unter Kontextdruck driften:
//
//   1. Event-Bus-Registry (public/js/events.js): jeder app-interne CustomEvent-
//      Name lebt als EVT-Konstante. Kein String-Literal in `new CustomEvent`/
//      `addEventListener`/`removeEventListener` — weder ein bereits registrierter
//      Wert (muss EVT.X sein) noch ein neuer namespaced Custom-Event (`a:b`, muss
//      erst in events.js registriert werden). Native DOM-Events (click, input,
//      resize, online …) bleiben Literale. EVT-Werte sind eindeutig.
//
//   2. Nav-Store-SSoT (public/js/cards/nav-store.js): books/selectedBookId/pages/
//      tree leben ausschliesslich im Store, nicht in der Root-God-State
//      (app-state.js). Root spiegelt sie via Getter/Setter-Proxy (app.js).
//
// Prosa-Regel = Vorschlag, Test = Gesetz. Neuer Verstoss → CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const EVENTS_FILE = join(JS_DIR, 'events.js');
const NAV_STORE = join(JS_DIR, 'cards', 'nav-store.js');
const APP_STATE = join(JS_DIR, 'app', 'app-state.js');
const APP_JS = join(JS_DIR, 'app.js');

const rel = (p) => relative(REPO_ROOT, p);
function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

// ── Registry parsen ──────────────────────────────────────────────────────────
const eventsSrc = readFileSync(EVENTS_FILE, 'utf8');
const registry = new Map(); // value → KEY
for (const m of eventsSrc.matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)',/gm)) {
  registry.set(m[2], m[1]);
}
const registryValues = new Set(registry.keys());

// Framework-/DOM-Colon-Events, die KEINE App-Events sind und Literal bleiben.
const COLON_ALLOWLIST = [/^alpine:/];

// ───────────────────────────────────────────────────────────
// REGEL 1a: Registry ist nicht leer + Werte eindeutig + Keys SCREAMING_SNAKE
// ───────────────────────────────────────────────────────────
test('events.js: Registry vorhanden, Werte eindeutig, Keys SCREAMING_SNAKE', () => {
  assert.ok(registry.size >= 20, `events.js sollte die App-Events listen (gefunden: ${registry.size})`);
  const seen = new Map();
  for (const [value, key] of registry) {
    assert.match(key, /^[A-Z0-9_]+$/, `EVT-Key "${key}" muss SCREAMING_SNAKE sein`);
    assert.ok(!seen.has(value), `EVT-Wert '${value}' doppelt vergeben (${seen.get(value)} + ${key})`);
    seen.set(value, key);
  }
});

// ───────────────────────────────────────────────────────────
// REGEL 1b: Keine String-Literal-Events in Dispatch/Listen-Calls
// ───────────────────────────────────────────────────────────
test('Event-Bus: keine String-Literale in CustomEvent/addEventListener/removeEventListener', () => {
  const callRe = /(new CustomEvent|addEventListener|removeEventListener)\(\s*(['"])([^'"]+)\2/g;
  const violations = [];
  for (const file of walk(JS_DIR, '.js')) {
    if (file === EVENTS_FILE) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(callRe)) {
      const name = m[3];
      const isAllowlisted = COLON_ALLOWLIST.some((re) => re.test(name));
      if (isAllowlisted) continue;
      if (registryValues.has(name)) {
        violations.push(`${rel(file)}: '${name}' ist registriert → EVT.${registry.get(name)} verwenden, kein Literal`);
      } else if (/^[a-z][\w-]*:[\w:-]+$/.test(name)) {
        violations.push(`${rel(file)}: '${name}' sieht aus wie ein Custom-Event → in events.js registrieren + EVT.* verwenden`);
      }
      // colon-freie Namen (click/input/resize/online …) = DOM-Events, ok.
    }
  }
  assert.deepEqual(violations, [], `Event-Literal-Verstoesse:\n${violations.join('\n')}`);
});

// ───────────────────────────────────────────────────────────
// REGEL 2: Nav-State lebt im Store, nicht in der Root-God-State
// ───────────────────────────────────────────────────────────
const NAV_FIELDS = ['books', 'selectedBookId', 'pages', 'tree'];

test('Nav-Store: definiert books/selectedBookId/pages/tree', () => {
  const navSrc = readFileSync(NAV_STORE, 'utf8');
  assert.match(navSrc, /Alpine\.store\(\s*'nav'/, "nav-store.js muss Alpine.store('nav') registrieren");
  for (const f of NAV_FIELDS) {
    assert.match(navSrc, new RegExp(`\\b${f}\\s*:`), `nav-store.js muss '${f}' definieren`);
  }
});

test('Nav-State NICHT in app-state.js (sonst ueberschreibt der Spread den Proxy)', () => {
  const stateSrc = readFileSync(APP_STATE, 'utf8');
  const offenders = NAV_FIELDS.filter((f) => new RegExp(`^\\s{2,}${f}\\s*:`, 'm').test(stateSrc));
  assert.deepEqual(offenders, [],
    `Diese Nav-Felder gehoeren in cards/nav-store.js, nicht in app-state.js: ${offenders.join(', ')}`);
});

test('Root spiegelt Nav-Felder via Getter/Setter-Proxy auf den Store (app.js)', () => {
  const appSrc = readFileSync(APP_JS, 'utf8');
  for (const f of NAV_FIELDS) {
    assert.match(appSrc, new RegExp(`get ${f}\\(\\)\\s*\\{[^}]*store\\(\\s*'nav'\\s*\\)`),
      `app.js braucht get ${f}() → Alpine.store('nav')`);
    assert.match(appSrc, new RegExp(`set ${f}\\(`), `app.js braucht set ${f}() fuer den Nav-Proxy`);
  }
});
