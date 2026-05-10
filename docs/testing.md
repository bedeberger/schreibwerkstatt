# Tests

Drei Suiten, sequenziell via `npm test`. Erstmaliges Setup: `npx playwright install chromium`.

| Suite | Runner | Pfad | Befehl | Charakter |
|-------|--------|------|--------|-----------|
| Unit | `node --test` | [tests/unit/](../tests/unit/) | `npm run test:unit` | Pure, parallelisiert (concurrency 4), kein Browser |
| Integration | `node --test` | [tests/integration/](../tests/integration/) | `npm run test:integration` | Sequenziell, Mock-AI, Mock-BookStack, echte SQLite |
| E2E | Playwright | [tests/e2e/](../tests/e2e/) | `npm run test:e2e` | Chromium gegen `tests/server.js` mit Fixture-Harness |

## Wann welche Suite?

**Unit:**
- Pure Funktionen, Validatoren, Renderer, Schema-Builder, Prompt-Builder.
- Single-Module-Logik ohne IO und ohne DB.
- Beispiele: [ai.test.js](../tests/unit/ai.test.js) (JSON-Parse-Fallback), [escape-xss.test.mjs](../tests/unit/escape-xss.test.mjs), [validate.test.js](../tests/unit/validate.test.js), [palette-fuzzy.test.mjs](../tests/unit/palette-fuzzy.test.mjs).

**Integration:**
- Komplette Job-Pipelines gegen Mock-Provider.
- DB-Interaktion (Migrations, Reads, Writes) mit echtem SQLite-File (in temp-Dir).
- Cross-Job-Regressionen.
- Beispiele: [komplett.test.js](../tests/integration/komplett.test.js), [review.test.js](../tests/integration/review.test.js).

**E2E:**
- DOM-Logik des Editors (Fokus-Modus, Selection, Pointer-Schonfrist, Cleanup).
- Lektorat-Flow mit Mock-Server.
- PDF-Export-Profile-CRUD inkl. Cover-Upload.
- Paste-Artefakt-Stripping (`cleanContentArtefacts`).

## Unit-Test-Konventionen

Endung: `.test.js` (CJS) oder `.test.mjs` (ESM, fuer Frontend-Module die `import` nutzen).

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('parseJSON repairs unescaped quotes', () => {
  const out = parseJSON('{"foo": "He said "hi""}');
  assert.equal(out.foo, 'He said "hi"');
});
```

Frontend-Module (Alpine, ESM): `.mjs` + `import`. Beispiel: [hash-router.test.mjs](../tests/unit/hash-router.test.mjs) baut DOM-Stub via `globalThis.document = …`.

## Integration: Mock-AI

[tests/integration/_helpers/mock-ai.js](../tests/integration/_helpers/mock-ai.js) stubt `lib/ai.callAI` via `require.cache`. **Pflicht: vor allen Modulen laden, die `lib/ai` requiren** (also vor `routes/jobs/...`).

```js
const mockAi = require('./_helpers/mock-ai');
mockAi.register({
  match: ({ system }) => system.includes('SYSTEM_REVIEW'),
  reply: { gesamtnote: 7, beanstandungen: [] },
});

// Erst danach:
const reviewModule = require('../../routes/jobs/review');
```

Handler-API:
- `match: ({ prompt, system, schema }) => bool` — first-match wins.
- `reply: object | string | function | { __raw: {...} }` — Object → JSON, `__raw` reicht volle `callAI`-Response durch (fuer truncated etc).

## Integration: Mock-BookStack

[tests/integration/_helpers/mock-bookstack.js](../tests/integration/_helpers/mock-bookstack.js) stubt `lib/bookstack.bsGet`/`bsGetAll`. Helper: register Books, Chapters, Pages, dann Jobs laufen lassen.

[tests/integration/_helpers/setup.js](../tests/integration/_helpers/setup.js) hebt eine frische SQLite-Test-DB hoch (Migrations laufen einmal pro Suite).

## E2E

`tests/server.js` startet Mini-Express auf Port 8765 und serviert `tests/fixtures/*-harness.html`. Playwright lädt Harness, importiert das echte Modul (z.B. `editor/focus.js`) und bindet es an Test-Harness-Objekt — kein BookStack, kein KI-Server.

`fullyParallel: false` (sequenziell), `retries: CI ? 2 : 0`, Timeout 60 s.

Harness-Fixtures müssen die **gleichen `<link rel=stylesheet>`-Tags in derselben Reihenfolge** wie [public/index.html](../public/index.html) haben, sonst weicht Cascade-Order ab und Layout-Tests sind unzuverlaessig. Neuer CSS-File → in beide Files.

## Häufige Fallen

- **Playwright fehlt Chromium**: `npx playwright install chromium`.
- **Mock-AI nach echtem `lib/ai`-Require geladen**: stubt nicht. Mock-AI muss als allerstes oben in der Test-Datei geladen werden.
- **DB-Lock zwischen Tests**: Integration-Suite ist `--test-concurrency=1` (Default fuer `node --test` ohne explizites Flag im script ist 1, aber bestaetigt durch `fullyParallel:false`-Aequivalent). Bei Race-Conditions: `node --test --test-concurrency=1`.
- **SHELL_CACHE nicht gebumpt**: E2E lädt Harness aus `public/` — falls du JS/CSS während eines Test-Runs änderst, hartes Reload nötig oder `SHELL_CACHE` bumpen ([public/sw.js](../public/sw.js)).
- **Tests anpassen statt Bug fixen**: bei UI-Änderungen am Editor/Fokus-Modus/Lektorat-Flow `npm test` laufen lassen. Schlägt etwas fehl, Ursache klären — nicht den Test entschärfen.

## Coverage-Schwerpunkte

Die folgenden Bereiche haben die kritischsten Tests; bei Aenderungen dort vor Commit:

- JSON-Fallback-Kette ([ai.test.js](../tests/unit/ai.test.js))
- Stale-Write-Schutz ([stale-write.test.mjs](../tests/unit/stale-write.test.mjs))
- Page-Stats-Normalisierung ([page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs))
- Card-Exklusivitaet ([card-exclusivity.test.mjs](../tests/unit/card-exclusivity.test.mjs))
- Hash-Router ([hash-router.test.mjs](../tests/unit/hash-router.test.mjs))
- XSS-Escape-Invariante ([escape-xss.test.mjs](../tests/unit/escape-xss.test.mjs))
- Komplettanalyse-Pipeline ([komplett.test.js](../tests/integration/komplett.test.js))
- PDF-Export ([pdf-export-defaults.test.js](../tests/unit/pdf-export-defaults.test.js), [pdf-render.test.mjs](../tests/unit/pdf-render.test.mjs), [pdf-export.spec.js](../tests/e2e/pdf-export.spec.js))
- Fokus-Editor ([focus-editor.spec.js](../tests/e2e/focus-editor.spec.js))
