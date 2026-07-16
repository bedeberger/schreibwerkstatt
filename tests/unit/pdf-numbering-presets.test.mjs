// Deckt die beiden Refactor-Extraktionen ab, die jetzt ohne Browser/Alpine
// testbar sind: die Kapitel-Label-SSoT (numbering.js, geteilt von TOC-Plan +
// Body-Loop) und die KDP-/Trim-Preset-Logik (pdf-export-presets.js).

import { test } from 'node:test';
import assert from 'node:assert';

const { computeChapterLabels } = await import('../../lib/pdf-render/numbering.js');
const presets = await import('../../public/js/cards/pdf-export-presets.js');

// ── Kapitel-Nummerierung ────────────────────────────────────────────────────
function cfg(chapter) { return { chapter: { numbering: 'arabic', numberingMode: 'nested', ...chapter } }; }

test('computeChapterLabels: nummeriert Top-Kapitel fortlaufend, überspringt unnummerierte', () => {
  const blocks = [
    { isChapter: true, depth: 1 },
    { isChapter: true, depth: 1, unnumbered: true },
    { isChapter: true, depth: 1 },
  ];
  const labels = computeChapterLabels(blocks, cfg(), 'de');
  assert.deepEqual(labels.map(l => l.label), ['1', null, '2']);
});

test('computeChapterLabels: nested-Modus verkettet Sub-Kapitel-Zähler + resettet tiefere', () => {
  const blocks = [
    { isChapter: true, depth: 1 }, // 1
    { isChapter: true, depth: 2 }, // 1.1
    { isChapter: true, depth: 2 }, // 1.2
    { isChapter: true, depth: 1 }, // 2  (resettet Sub-Counter)
    { isChapter: true, depth: 2 }, // 2.1
  ];
  const labels = computeChapterLabels(blocks, cfg(), 'de');
  assert.deepEqual(labels.map(l => l.label), ['1', '1.1', '1.2', '2', '2.1']);
});

test('computeChapterLabels: Nicht-Kapitel-Blöcke zählen nicht mit', () => {
  const blocks = [
    { isChapter: true, depth: 1 },
    { isChapter: false, depth: 1 },
    { isChapter: true, depth: 1 },
  ];
  const labels = computeChapterLabels(blocks, cfg(), 'de');
  assert.deepEqual(labels.map(l => l.label), ['1', null, '2']);
});

test('computeChapterLabels: numbering=none liefert überall null', () => {
  const blocks = [{ isChapter: true, depth: 1 }, { isChapter: true, depth: 1 }];
  const labels = computeChapterLabels(blocks, cfg({ numbering: 'none' }), 'de');
  assert.deepEqual(labels.map(l => l.label), [null, null]);
});

// ── KDP-Presets ─────────────────────────────────────────────────────────────
const t = (key, params) => JSON.stringify({ key, params }); // identifizierbarer Stub

test('kdpMinGutterMm: Schwellen der KDP-Tabelle', () => {
  assert.equal(presets.kdpMinGutterMm(150), 9.53);
  assert.equal(presets.kdpMinGutterMm(151), 12.7);
  assert.equal(presets.kdpMinGutterMm(300), 12.7);
  assert.equal(presets.kdpMinGutterMm(500), 15.88);
  assert.equal(presets.kdpMinGutterMm(600), 19.05);
  assert.equal(presets.kdpMinGutterMm(601), 22.23);
});

test('applyKdpPreset: hebt Bund-/Aussenränder auf die Minima + setzt Druck-Flags', () => {
  const config = {
    print: { cropMarks: true, padToEvenPages: false },
    extras: { barcode: true },
    layout: { mirrorMargins: false, marginsMm: { left: 5, right: 5, top: 5, bottom: 5 } },
    coverSpec: { pageCount: 400 },
  };
  presets.applyKdpPreset(config);
  assert.equal(config.print.cropMarks, false);
  assert.equal(config.print.padToEvenPages, true);
  assert.equal(config.extras.barcode, false);
  assert.equal(config.layout.mirrorMargins, true);
  assert.equal(config.layout.marginsMm.left, 15.88); // Bundsteg für 400 Seiten
  assert.equal(config.layout.marginsMm.right, 6.35); // Aussenrand-Minimum
});

test('kdpMarginWarnings: fehlende Seitenzahl → Hinweis (ok null)', () => {
  const config = { coverSpec: { pageCount: 0 }, layout: { marginsMm: { left: 20, right: 20, top: 20, bottom: 20 } }, print: {} };
  const out = presets.kdpMarginWarnings(config, t);
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, null);
});

test('kdpMarginWarnings: konforme Ränder → ok true', () => {
  const config = {
    coverSpec: { pageCount: 200 },
    layout: { mirrorMargins: true, marginsMm: { left: 15, right: 10, top: 10, bottom: 10 } },
    print: { cropMarks: false },
  };
  const out = presets.kdpMarginWarnings(config, t);
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true);
});

test('kdpMarginWarnings: zu schmaler Bundsteg + Schnittmarken → zwei Verstösse', () => {
  const config = {
    coverSpec: { pageCount: 200 }, // min gutter 12.7
    layout: { mirrorMargins: true, marginsMm: { left: 8, right: 10, top: 10, bottom: 10 } },
    print: { cropMarks: true },
  };
  const out = presets.kdpMarginWarnings(config, t);
  assert.ok(out.every(w => w.ok === false));
  assert.equal(out.length, 2);
});

test('applyTrimPreset: setzt custom + Masse; unbekannter Wert ist No-Op', () => {
  const config = { layout: { pageSize: 'A4', customWidthMm: 0, customHeightMm: 0 } };
  presets.applyTrimPreset(config, 'kdp-6x9');
  assert.equal(config.layout.pageSize, 'custom');
  assert.equal(config.layout.customWidthMm, 152.4);
  assert.equal(config.layout.customHeightMm, 228.6);
  presets.applyTrimPreset(config, 'does-not-exist');
  assert.equal(config.layout.customWidthMm, 152.4); // unverändert
});

test('trimPresetOptions: cm-Label mit .-Dezimal für Nicht-KDP, Override-Label für KDP', () => {
  const opts = presets.trimPresetOptions();
  assert.equal(opts.length, presets.TRIM_PRESETS.length);
  const byValue = Object.fromEntries(opts.map(o => [o.value, o.label]));
  // Nicht-KDP: berechnetes cm-Label mit '.'-Dezimal (Swiss-konform).
  assert.equal(byValue['125x200'], '12.5 × 20 cm');
  assert.equal(byValue['155x230'], '15.5 × 23 cm');
  // KDP: expliziter Override statt cm-Berechnung.
  assert.equal(byValue['kdp-6x9'], 'KDP 6 × 9″ (15.24 × 22.86 cm)');
  // Kein Label enthält ein Komma als Dezimaltrenner.
  assert.ok(opts.every(o => !/\d,\d/.test(o.label)));
});

test('applyPaperPreset: setzt Rückenbreite; unbekannter Wert ist No-Op', () => {
  const config = { coverSpec: { paperBulkMmPer1000: 0 } };
  presets.applyPaperPreset(config, 'kdp-cream');
  assert.equal(config.coverSpec.paperBulkMmPer1000, 63.5);
  presets.applyPaperPreset(config, 'does-not-exist');
  assert.equal(config.coverSpec.paperBulkMmPer1000, 63.5); // unverändert
});

test('paperPresetOptions: mappt labelKey durch t, Value passthrough', () => {
  const opts = presets.paperPresetOptions(t);
  assert.equal(opts.length, presets.PAPER_PRESETS.length);
  assert.deepEqual(opts.map(o => o.value), presets.PAPER_PRESETS.map(p => p.value));
  // Label ist die t()-Auflösung des labelKey (Stub gibt den Key als JSON zurück).
  const first = opts[0];
  assert.equal(first.label, t(presets.PAPER_PRESETS[0].labelKey));
});
