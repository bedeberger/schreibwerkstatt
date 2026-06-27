// Guard gegen „roher i18n-Key leckt in die UI", weil ein x-data-Initializer der
// Shell `t()` EAGER auflöst, bevor i18n geladen ist.
//
// Ursache (generisch, nicht an eine Komponente gebunden):
//   `index.html` ist die App-Shell. Ihre `x-data`-Ausdrücke werden beim Alpine-
//   Boot ausgewertet — SYNCHRON, bevor `init()` die Locale-Daten nachlädt. Ein
//   als String übergebenes `t('key')` (bzw. `$app.t(...)`) wird genau dann
//   einmalig aufgelöst und liefert den ROHEN Key (z.B. „book.create.buchtypLabel"),
//   weil die Übersetzung noch nicht da ist. Reaktive Sinks (`x-text`) heilen sich
//   beim Nachladen selbst; ein eager Konstruktor-Argument NICHT.
//   → i18n-Argumente in Shell-`x-data` müssen LAZY sein: `() => t('key')`.
//     Der Combobox-`placeholder`/`emptyLabel`-Getter (public/js/combobox.js) löst
//     Funktionen reaktiv auf; gilt analog für jede Factory mit i18n-Argument.
//
// NICHT geprüft (bewusst): `public/partials/*.html`. Partials werden via
// `_ensurePartial` LAZY ins DOM injiziert — erst beim Öffnen der Karte, lange
// nach dem i18n-Load. Dort ist eager `$app.t(...)` korrekt und millionenfach
// üblich; ein Function-Zwang wäre Lärm. Der Bug kann nur in der Shell beissen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

// Alle `x-data="..."`-Attributwerte (auch mehrzeilig) aus dem Markup ziehen.
function xDataValues(html) {
  return [...html.matchAll(/x-data="([\s\S]*?)"/g)].map(m => m[1]);
}

// Eager i18n-Aufruf = `t(`/`$app.t(` als DIREKTER Argumentwert:
//  - positional direkt nach `(` oder `,`            → `combobox(t('x'))`, `combobox(a, t('y'))`
//  - als Objekt-Property placeholder/emptyLabel/label → `{ placeholder: t('x') }`
// Lazy-Form `() => t('x')` matcht NICHT (vor dem `t(` steht `>`, nicht `(`/`,`/`:`).
const EAGER_POSITIONAL = /[(,]\s*\$?(?:app\.)?t\(/;
const EAGER_PROPERTY = /\b(?:placeholder|emptyLabel|label)\s*:\s*\$?(?:app\.)?t\(/;

function eagerI18n(expr) {
  return EAGER_POSITIONAL.test(expr) || EAGER_PROPERTY.test(expr);
}

test('Detektor fängt die bekannte Eager-Form (Selbsttest)', () => {
  // Beide Schreibweisen, die den book.create-Bug auslösten:
  assert.ok(eagerI18n("combobox(t('book.create.buchtypLabel'))"), 'positional t() nicht erkannt');
  assert.ok(eagerI18n("combobox({ placeholder: $app.t('x') })"), 'placeholder:$app.t() nicht erkannt');
  assert.ok(eagerI18n("combobox(x, t('y'))"), 'zweites positionales t() (emptyLabel) nicht erkannt');
  // Lazy-Formen dürfen NICHT anschlagen (sonst false-positive-Lärm):
  assert.ok(!eagerI18n("combobox(() => t('x'))"), 'lazy positional fälschlich geflaggt');
  assert.ok(!eagerI18n("combobox({ placeholder: () => t('x') })"), 'lazy placeholder fälschlich geflaggt');
  assert.ok(!eagerI18n('combobox({ compact: false })'), 'i18n-freie Factory fälschlich geflaggt');
});

test('index.html (Shell): kein eager t()/$app.t() in x-data-Initializern', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const offenders = xDataValues(html)
    .filter(eagerI18n)
    .map(v => v.replace(/\s+/g, ' ').trim().slice(0, 120));
  assert.equal(
    offenders.length, 0,
    'Eager i18n in Shell-x-data — als Funktion übergeben (`() => t(\'key\')`), '
    + 'sonst leckt der rohe Key beim Boot vor dem i18n-Load:\n'
    + offenders.map(o => `  ${o}`).join('\n'),
  );
});
