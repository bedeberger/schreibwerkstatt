'use strict';
// Gate fuer das Focus-Editor-OTA-Bundle (lib/editor-bundle.js), das der native
// macOS-Client (schreibwerkstatt-focuseditor) zur Laufzeit zieht. Stiller
// Bruch-Modus: ein neuer Import in der Editor-Closure, den der Crawler nicht
// aufloest, faellt lautlos aus dem Offline-Bundle → Client bricht beim naechsten
// Start, ohne dass im Hauptrepo etwas rot wird. Dieser Test macht genau das rot.
import test from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const eb = require('../../lib/editor-bundle.js');
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

test('specifiersOf erfasst statische, Re-Export- und dynamische Imports', () => {
  const code = `
    import { a } from './a.js';
    export { b } from '../shared/b.js';
    const m = await import('/js/utils.js');
    import('./lazy.js');
  `;
  const specs = eb.specifiersOf(code).sort();
  assert.deepEqual(specs, ['../shared/b.js', './a.js', './lazy.js', '/js/utils.js']);
});

test('resolveSpecifier: relativ wird gegen das importierende Modul aufgeloest', () => {
  assert.equal(eb.resolveSpecifier('./card.js', 'js/editor/focus/standalone.js'), 'js/editor/focus/card.js');
  assert.equal(eb.resolveSpecifier('../shared/block-merge.js', 'js/editor/focus/standalone.js'), 'js/editor/shared/block-merge.js');
  assert.equal(eb.resolveSpecifier('/js/utils.js', 'js/editor/focus/card.js'), 'js/utils.js');
});

test('resolveSpecifier: bare/externer Specifier → null (nicht gebuendelt)', () => {
  assert.equal(eb.resolveSpecifier('jszip', 'js/editor/focus/card.js'), null);
  assert.equal(eb.resolveSpecifier('@anthropic-ai/sdk', 'js/editor/focus/card.js'), null);
});

test('buildClosure(ENTRY_MODULES) ist vollstaendig und selbst-enthalten (keine Warnungen)', async () => {
  const { files, warnings } = await eb.buildClosure(eb.ENTRY_MODULES);
  // Die zentrale Client-Invariante: kein fehlendes Modul, kein ungeloester
  // (bare/externer) Import im Editor-Kern. Warnung = Datei fehlt offline.
  assert.deepEqual(warnings, [], `Closure-Warnungen — Bundle waere unvollstaendig: ${warnings.join('; ')}`);

  // Jeder Entry und die explizit fuer den Bridge-/409-Pfad gezogenen Kernmodule
  // muessen in der Closure liegen (CLAUDE.md: editor-host + block-merge explizit).
  for (const entry of eb.ENTRY_MODULES) assert.ok(files.includes(entry), `Entry fehlt: ${entry}`);
  for (const core of ['js/editor/shared/editor-host.js', 'js/editor/shared/block-merge.js', 'js/editor/shared/apply-replacement.js']) {
    assert.ok(files.includes(core), `Kernmodul fehlt in Closure: ${core}`);
  }

  // Jede aufgeloeste Datei existiert real auf der Platte.
  for (const rel of files) assert.ok(existsSync(join(PUBLIC_DIR, rel)), `aufgeloeste Datei fehlt auf Platte: ${rel}`);
});

test('CSS- und Extra-Assets der Bundle-Liste existieren auf der Platte', () => {
  for (const rel of [...eb.CSS_FILES, ...eb.EXTRA_ASSETS]) {
    assert.ok(existsSync(join(PUBLIC_DIR, rel)), `Bundle-Asset fehlt in Quelle: ${rel}`);
  }
});

test('getBundle: ETag deterministisch ueber Builds, Manifest deckt JS+CSS+Assets ab', async () => {
  eb._resetCache();
  const first = await eb.getBundle();
  eb._resetCache();
  const second = await eb.getBundle();

  assert.match(first.etag, /^"[0-9a-f]{64}"$/);
  assert.equal(first.etag, second.etag, 'ETag muss bei unveraenderten Quellen stabil sein (sonst dauernde 200 statt 304)');
  assert.ok(Buffer.isBuffer(first.buffer) && first.buffer.length > 0);

  const m = first.manifest;
  assert.equal(typeof m.sourceCommit, 'string');
  assert.ok(m.jsFiles.includes('js/editor/focus/standalone.js'));
  assert.deepEqual(m.cssFiles, eb.CSS_FILES.filter(f => existsSync(join(PUBLIC_DIR, f))));
  assert.deepEqual(m.extraAssets, eb.EXTRA_ASSETS.filter(f => existsSync(join(PUBLIC_DIR, f))));
});
