// Abbildungs-Markup: die drei Träger (alt / figcaption / .figure-credit) und
// ihre Zusagen über alle Schichten.
//
// Die teuerste Zusage steht am Schluss: das Nummern-Badge der Leseansicht darf
// NIE in die Persistenz laufen. Es lebt im bearbeitbaren Inhalt, und ohne die
// beiden Strip-Schichten trüge das Manuskript die Zählung vom Tag des
// Hinsehens — im Export stünde sie dann doppelt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  buildFigureHtml, figureModel, applyFigureMeta, isFigureEl, closestFigureEl,
  FIGURE_CREDIT_SEL,
} from '../../public/js/figure/figure-html.js';

const require_ = createRequire(import.meta.url);
const { parseHTML } = require_('linkedom');
const { cleanPageHtml } = require_('../../lib/html-clean.js');
const { parseHtmlToBlocks } = require_('../../lib/pdf-render/html-walker.js');

function dom(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById('r');
}

// ── Markup-SSoT ────────────────────────────────────────────────────────────

test('buildFigureHtml: img + leere figcaption, Nachweis nur wenn gefüllt', () => {
  const bare = buildFigureHtml({ src: '/content/page-image/7' });
  assert.match(bare, /^<figure><img src="\/content\/page-image\/7" alt=""><figcaption><br><\/figcaption><\/figure>$/);
  assert.ok(!bare.includes('figure-credit'), 'leerer Nachweis erzeugt kein Element');

  const full = buildFigureHtml({ src: '/x.png', alt: 'Ein Käfer', caption: 'Der Käfer', credit: 'Foto: Keystone' });
  assert.ok(full.includes('alt="Ein Käfer"'));
  assert.ok(full.includes('<figcaption>Der Käfer</figcaption>'));
  assert.ok(full.includes('<p class="figure-credit">Foto: Keystone</p>'));
});

test('buildFigureHtml: ohne src keine Abbildung', () => {
  assert.equal(buildFigureHtml({ src: '   ', caption: 'x' }), '');
  assert.equal(buildFigureHtml({}), '');
});

test('buildFigureHtml: escapt alle drei Felder', () => {
  const html = buildFigureHtml({
    src: '/a.png?a=1&b=2', alt: '<script>', caption: 'a & b', credit: '"Foto"',
  });
  assert.ok(!html.includes('<script>'), 'alt darf kein aktives Markup durchlassen');
  assert.ok(html.includes('&amp;'), 'kaufmännisches Und wird escapt');
});

test('figureModel liest die Felder zurück — ohne die Legende', () => {
  const root = dom(buildFigureHtml({ src: '/x.png', alt: 'A', caption: 'Legende', credit: 'Foto: K' }));
  const m = figureModel(root.querySelector('figure'));
  assert.deepEqual(m, { src: '/x.png', alt: 'A', credit: 'Foto: K' });
  assert.ok(!('caption' in m), 'die Legende wird im Manuskript getippt, nicht im Dialog');
});

test('applyFigureMeta: setzt, ändert und entfernt den Nachweis', () => {
  const root = dom(buildFigureHtml({ src: '/x.png', caption: 'L' }));
  const fig = root.querySelector('figure');

  assert.equal(applyFigureMeta(fig, { alt: 'Neu', credit: 'Foto: A' }), true);
  assert.equal(fig.querySelector('img').getAttribute('alt'), 'Neu');
  assert.equal(fig.querySelector(FIGURE_CREDIT_SEL).textContent, 'Foto: A');
  // Der Nachweis steht HINTER der Legende — sonst läse ihn jeder Renderer,
  // der die erste Zeile als Unterschrift nimmt, als Unterschrift.
  assert.equal(fig.lastElementChild.className, 'figure-credit');

  assert.equal(applyFigureMeta(fig, { alt: 'Neu', credit: 'Foto: B' }), true);
  assert.equal(fig.querySelector(FIGURE_CREDIT_SEL).textContent, 'Foto: B');

  assert.equal(applyFigureMeta(fig, { alt: 'Neu', credit: '' }), true);
  assert.equal(fig.querySelector(FIGURE_CREDIT_SEL), null, 'leerer Nachweis entfernt das Element');

  // Unveränderte Übernahme meldet false — sonst gälte die Seite allein vom
  // Öffnen des Dialogs als geändert.
  assert.equal(applyFigureMeta(fig, { alt: 'Neu', credit: '' }), false);
});

test('applyFigureMeta: normalisiert auf eine Zeile', () => {
  const root = dom(buildFigureHtml({ src: '/x.png' }));
  const fig = root.querySelector('figure');
  applyFigureMeta(fig, { alt: '  zwei   Wörter \n hier ', credit: ' Foto:\tK ' });
  assert.equal(fig.querySelector('img').getAttribute('alt'), 'zwei Wörter hier');
  assert.equal(fig.querySelector(FIGURE_CREDIT_SEL).textContent, 'Foto: K');
});

test('isFigureEl / closestFigureEl finden die Abbildung vom Bild aus', () => {
  const root = dom(buildFigureHtml({ src: '/x.png', caption: 'L', credit: 'F' }));
  const fig = root.querySelector('figure');
  assert.equal(isFigureEl(fig), true);
  assert.equal(isFigureEl(root.querySelector('img')), false);
  assert.equal(closestFigureEl(root.querySelector('img'), root), fig);
  assert.equal(closestFigureEl(root, root), null, 'die Wurzel selbst ist kein Treffer');
});

// ── Der Nachweis bleibt aus dem Verzeichnis heraus ─────────────────────────

test('figcaption.textContent trägt den Nachweis NICHT', () => {
  // Das ist der Grund für das Geschwister-Element statt eines Spans in der
  // Legende: die Anker-Lesung (xref-anchor.js) nimmt figcaption.textContent als
  // Verzeichnis-Titel. Läge der Nachweis darin, hiesse der Eintrag im
  // Abbildungsverzeichnis „Der Käfer Foto: Keystone".
  const root = dom(buildFigureHtml({ src: '/x.png', caption: 'Der Käfer', credit: 'Foto: Keystone' }));
  assert.equal(root.querySelector('figcaption').textContent, 'Der Käfer');
});

// ── PDF-/DOCX-Walker ───────────────────────────────────────────────────────

test('Walker: Anker-ID am Bild, Nachweis als eigener Absatz', () => {
  const blocks = parseHtmlToBlocks(
    '<figure data-bid="a1b2c3d4"><img src="/x.png" alt="A"><figcaption>Legende</figcaption>'
    + '<p class="figure-credit">Foto: K</p></figure>',
  );
  const kinds = blocks.map(b => b.kind);
  assert.deepEqual(kinds, ['image', 'paragraph', 'paragraph'],
    'Bild, Legende, Nachweis — der Nachweis darf nicht unter den Tisch fallen');
  assert.equal(blocks[0].bid, 'a1b2c3d4');
  assert.equal(blocks[2].runs.map(r => r.text).join(''), 'Foto: K');
});

test('Walker: nur das ERSTE Bild einer Abbildung trägt die Anker-ID', () => {
  const blocks = parseHtmlToBlocks(
    '<figure data-bid="a1b2c3d4"><img src="/a.png"><img src="/b.png"><figcaption>L</figcaption></figure>',
  );
  const imgs = blocks.filter(b => b.kind === 'image');
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].bid, 'a1b2c3d4');
  assert.equal(imgs[1].bid, undefined, 'sonst stünde die Abbildung zweimal im Verzeichnis');
});

test('Walker: Tabelle trägt ihre Anker-ID, ungültige fallen weg', () => {
  const ok = parseHtmlToBlocks('<table data-bid="beefcafe"><tbody><tr><td>1</td></tr></tbody></table>');
  assert.equal(ok[0].bid, 'beefcafe');
  const bad = parseHtmlToBlocks('<table data-bid="nope!"><tbody><tr><td>1</td></tr></tbody></table>');
  assert.equal(bad[0].bid, null);
});

// ── Das Nummern-Badge erreicht die Persistenz nicht ────────────────────────

test('cleanPageHtml entfernt das Nummern-Badge, behält Legende und Nachweis', () => {
  const stored = cleanPageHtml(
    '<figure data-bid="a1b2c3d4"><img src="/x.png" alt="A">'
    + '<figcaption><span class="xref-num" contenteditable="false">Abb. 3.2: </span>Der Käfer</figcaption>'
    + '<p class="figure-credit">Foto: Keystone</p></figure>',
  );
  assert.ok(!stored.includes('xref-num'), 'das Badge ist ein Render-Artefakt');
  assert.ok(!stored.includes('Abb. 3.2'), 'die Nummer gehört dem Ausgabeweg, nicht dem Manuskript');
  assert.ok(stored.includes('<figcaption>Der Käfer</figcaption>'));
  assert.ok(stored.includes('<p class="figure-credit">Foto: Keystone</p>'));
  assert.ok(!stored.includes('contenteditable'), 'Laufzeit-Attribut wird ebenfalls gestrippt');
});

test('cleanPageHtml entfernt das Badge auch in der Tabellenbeschriftung', () => {
  const stored = cleanPageHtml(
    '<table data-bid="beefcafe"><caption><span class="xref-num">Tab. 1.1: </span>Umsatz</caption>'
    + '<tbody><tr><td>1</td></tr></tbody></table>',
  );
  assert.ok(!stored.includes('xref-num'));
  assert.ok(stored.includes('Umsatz'));
});
