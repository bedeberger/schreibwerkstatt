// Satzspiegel-Geometrie, Seitenzahl-Schätzung, Trim-Preset-Spiegelung und
// Export-Befunde der PDF-Export-Karte (pure Module neben pdf-export-card.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultConfig } = require('../../lib/pdf-export-defaults');
const geo = await import('../../public/js/cards/pdf-export-geometry.js');
const presets = await import('../../public/js/cards/pdf-export-presets.js');
const { buildRenderWarnings } = await import('../../public/js/cards/pdf-export-warnings.js');

const t = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

test('viewBox der Vorschau ist im Partial als Literal gepinnt (PREVIEW_VB)', () => {
  const html = readFileSync(new URL('../../public/partials/pdf-export-satzspiegel.html', import.meta.url), 'utf8');
  const { w, h } = geo.PREVIEW_VB;
  assert.ok(html.includes(`viewBox="0 0 ${w} ${h}"`), 'viewBox im Partial weicht von PREVIEW_VB ab');
  assert.ok(!/:viewBox="/i.test(html), 'gebundenes :viewBox wirkt nicht (Parser schreibt klein)');
});

test('satzspiegelPreview: Doppelseite in der viewBox, Spiegelung tauscht Bund', () => {
  const cfg = defaultConfig();
  cfg.layout.mirrorMargins = true;
  cfg.layout.marginsMm = { top: 20, right: 30, bottom: 20, left: 15 };
  const g = geo.satzspiegelPreview(cfg);
  const [verso, recto] = g.pages;
  assert.ok(verso.x >= 0 && recto.x + recto.w <= geo.PREVIEW_VB.w + 0.01);
  // Recto: Bund (left 15) innen = links; Verso: Bund rechts.
  const rectoInner = recto.text.x - recto.x;
  const versoInner = (verso.x + verso.w) - (verso.text.x + verso.text.w);
  assert.ok(Math.abs(rectoInner - versoInner) < 0.05, 'Bund nicht gespiegelt');
  assert.equal(g.textWidthMm, 210 - 45);
  assert.equal(g.bleed, null);
  cfg.print.bleedMm = 3;
  assert.ok(geo.satzspiegelPreview(cfg).bleed);
});

test('geometryWarnings / headingChainViolations', () => {
  const cfg = defaultConfig();
  assert.deepEqual(geo.geometryWarnings(cfg, t), []);
  cfg.layout.pageSize = 'A6';
  cfg.layout.marginsMm = { top: 60, right: 40, bottom: 60, left: 40 };
  assert.equal(geo.geometryWarnings(cfg, t).length, 2);
  const h = defaultConfig();
  assert.deepEqual(geo.headingChainViolations(h), []);
  h.font.heading.sizes.h3 = 30;
  h.font.body.sizePt = 12;
  const v = geo.headingChainViolations(h);
  assert.ok(v.some(x => x.upper === 'h2' && x.lower === 'h3'));
  assert.ok(v.some(x => x.upper === 'h6' && x.lower === 'body'));
});

test('estimatePageCount: wächst mit Text und Schriftgrösse, gerade bei padToEvenPages', () => {
  const cfg = defaultConfig();
  assert.equal(geo.estimatePageCount(cfg, { chars: 0 }), 0);
  const a = geo.estimatePageCount(cfg, { chars: 500000, chapters: 20 });
  assert.ok(a > 100 && a < 400, `unplausibel: ${a}`);
  assert.equal(a % 2, 0);
  const big = defaultConfig();
  big.font.body.sizePt = 14;
  assert.ok(geo.estimatePageCount(big, { chars: 500000, chapters: 20 }) > a);
});

test('matchTrimPreset spiegelt den Zustand, bevorzugt den gewählten Dienst', () => {
  const cfg = defaultConfig();
  assert.equal(presets.matchTrimPreset(cfg), 'bod-210x297'); // A4 = BoD-A4
  cfg.layout.pageSize = 'custom';
  cfg.layout.customWidthMm = 120; cfg.layout.customHeightMm = 190;
  assert.equal(presets.matchTrimPreset(cfg), 'bod-120x190');
  assert.equal(presets.matchTrimPreset(cfg, 'tredition-120x190'), 'tredition-120x190');
  cfg.layout.customWidthMm = 111;
  assert.equal(presets.matchTrimPreset(cfg, 'tredition-120x190'), 'custom');
  // Dienst-Formate setzen passende Ränder.
  presets.applyTrimPreset(cfg, 'epubli-148x210');
  assert.equal(cfg.layout.customWidthMm, 148);
  assert.ok(cfg.layout.marginsMm.left >= 18);
  const opts = presets.trimPresetOptions(t);
  assert.ok(opts.every(o => o.group));
});

test('KDP: Aussenrand 9.53 mm mit Beschnitt, Schätzung gekennzeichnet', () => {
  const cfg = { coverSpec: { pageCount: 0 }, print: { bleedMm: 3 }, extras: {},
    layout: { mirrorMargins: true, marginsMm: { left: 20, right: 8, top: 10, bottom: 10 } } };
  const w = presets.kdpMarginWarnings(cfg, t, 240);
  assert.ok(w.some(x => x.ok === false && x.text.includes('kdpWarnOuter') && x.text.includes('9.53')));
  const okCfg = { ...cfg, layout: { mirrorMargins: true, marginsMm: { left: 20, right: 10, top: 10, bottom: 10 } } };
  assert.ok(presets.kdpMarginWarnings(okCfg, t, 240).some(x => x.ok === true && x.text.includes('pagesEstimated')));
  assert.ok(w.some(x => x.text === 'pdfExport.print.kdpEstimateHint'));
  presets.applyKdpPreset(cfg, 240);
  assert.equal(cfg.layout.marginsMm.right, 9.53);
});

test('buildRenderWarnings: alle Befunde, beide Feldformen', () => {
  const all = buildRenderWarnings({
    pdfa: { requested: true, validatorAvailable: false },
    pdfx: { requested: false },
    coverInInterior: true,
    hyphenationDisabled: ['Source Serif 4'],
    renderWarnings: {
      footnoteFallback: true, footnoteOverflowPages: 3, xrefUnresolved: 2,
      fontFallbacks: [{ role: 'body', requested: 'X', used: 'Lora' }],
      dpiWarnings: [{}, {}], hyphenationDisabled: true, oversizeImages: 1,
    },
  }, t);
  const ids = all.map(w => w.id);
  for (const id of ['pdfaNoValidator', 'hyphenation', 'fontFallback0', 'footnoteFallback', 'footnoteOverflow', 'xrefUnresolved', 'lowRes', 'oversizeImages', 'coverInInterior']) {
    assert.ok(ids.includes(id), `${id} fehlt`);
  }
  // Array-Form von xrefUnresolved, alte Form lowResImages, leeres Result.
  assert.ok(buildRenderWarnings({ renderWarnings: { xrefUnresolved: ['a'] } }, t)[0].text.includes('"count":1'));
  assert.equal(buildRenderWarnings({ lowResImages: 2 }, t)[0].id, 'lowRes');
  assert.deepEqual(buildRenderWarnings({}, t), []);
  assert.equal(buildRenderWarnings({ pdfa: { requested: true, validatorAvailable: true, passed: false } }, t)[0].id, 'pdfaFailed');
});
