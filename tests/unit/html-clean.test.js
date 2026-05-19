'use strict';
// Unit-Tests für lib/html-clean.js — Server-seitiger Page-HTML-Sanitizer.
// Lauf: `node --test tests/unit/html-clean.test.js`

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanPageHtml, wrapOrphanBlocks, collapseEmptyBlocks, stripTrailingEmptyBlocks, stripBlockEdgeNbsp } = require('../../lib/html-clean');

test('collapseEmptyBlocks: leere <p>-Runs auf einen kollabieren', () => {
  assert.equal(
    collapseEmptyBlocks('<p>Hallo</p><p></p><p></p><p>Welt</p>'),
    '<p>Hallo</p><p></p><p>Welt</p>'
  );
});

test('collapseEmptyBlocks: <p><br></p>-Runs kollabieren', () => {
  assert.equal(
    collapseEmptyBlocks('<p>Eins</p><p><br></p><p><br></p><p>Zwei</p>'),
    '<p>Eins</p><p><br></p><p>Zwei</p>'
  );
});

test('collapseEmptyBlocks: <br><br>-Runs auf ein <br>', () => {
  assert.equal(
    collapseEmptyBlocks('<p>foo<br><br><br>bar</p>'),
    '<p>foo<br>bar</p>'
  );
});

test('collapseEmptyBlocks: einzelner Leerblock bleibt (Absatz-Trennung)', () => {
  assert.equal(
    collapseEmptyBlocks('<p>Eins</p><p></p><p>Zwei</p>'),
    '<p>Eins</p><p></p><p>Zwei</p>'
  );
});

test('collapseEmptyBlocks: idempotent', () => {
  const input = '<p>Hallo</p><p></p><p></p><p><br></p><p>Welt</p>';
  const once = collapseEmptyBlocks(input);
  const twice = collapseEmptyBlocks(once);
  assert.equal(once, twice);
});

test('stripTrailingEmptyBlocks: trailing <p></p> raus', () => {
  assert.equal(
    stripTrailingEmptyBlocks('<p>End</p><p></p><p></p>'),
    '<p>End</p>'
  );
});

test('stripTrailingEmptyBlocks: behält Inhalt am Ende', () => {
  assert.equal(
    stripTrailingEmptyBlocks('<p>Mitte</p><p>End</p>'),
    '<p>Mitte</p><p>End</p>'
  );
});

test('cleanPageHtml: kombiniert beide Schritte', () => {
  assert.equal(
    cleanPageHtml('<p>A</p><p></p><p></p><p>B</p><p></p><p></p>'),
    '<p>A</p><p></p><p>B</p>'
  );
});

test('cleanPageHtml: Edge-Cases', () => {
  assert.equal(cleanPageHtml(''), '');
  assert.equal(cleanPageHtml(null), null);
  assert.equal(cleanPageHtml(undefined), undefined);
  assert.equal(cleanPageHtml(42), 42);
});

test('cleanPageHtml: einfacher Inhalt unverändert', () => {
  const html = '<p>Hallo Welt</p>';
  assert.equal(cleanPageHtml(html), html);
});

test('cleanPageHtml: idempotent auch über Trailing+Run-Mix', () => {
  const input = '<p>A</p><p><br></p><p><br></p><p>B</p><p>&nbsp;</p><p></p>';
  const once = cleanPageHtml(input);
  const twice = cleanPageHtml(once);
  assert.equal(once, twice);
});

test('cleanPageHtml: strukturelle Leafs (img/table) werden nicht entfernt', () => {
  const out = cleanPageHtml('<p><img src="x.jpg"></p><p></p><p>Text</p>');
  assert.match(out, /<img[^>]*src="x.jpg"/);
  assert.match(out, /<p>Text<\/p>/);
});

test('wrapOrphanBlocks: bare Text-Run → <p>', () => {
  assert.equal(
    wrapOrphanBlocks('Stefan fand problemlos eine Anstellung.'),
    '<p>Stefan fand problemlos eine Anstellung.</p>'
  );
});

test('wrapOrphanBlocks: bare Text + bestehendes <p> bleiben getrennt', () => {
  assert.equal(
    wrapOrphanBlocks('Vorlauf<p>Block</p>Nachlauf'),
    '<p>Vorlauf</p><p>Block</p><p>Nachlauf</p>'
  );
});

test('wrapOrphanBlocks: inline-Run (<strong>, <em>) wird in <p> verpackt', () => {
  assert.equal(
    wrapOrphanBlocks('Hallo <strong>Welt</strong>!'),
    '<p>Hallo <strong>Welt</strong>!</p>'
  );
});

test('wrapOrphanBlocks: bereits gewrappt → no-op (idempotent)', () => {
  const html = '<p>A</p><p>B</p>';
  assert.equal(wrapOrphanBlocks(html), html);
  assert.equal(wrapOrphanBlocks(wrapOrphanBlocks(html)), html);
});

test('wrapOrphanBlocks: rein leere Whitespace-Runs ergeben kein Phantom-<p>', () => {
  assert.equal(wrapOrphanBlocks('   \n\t  '), '   \n\t  ');
});

test('wrapOrphanBlocks: Heading bleibt eigenständiger Block', () => {
  assert.equal(
    wrapOrphanBlocks('Vorlauf<h2>Titel</h2>'),
    '<p>Vorlauf</p><h2>Titel</h2>'
  );
});

test('cleanPageHtml: heilt Bare-Text-Page wie page 146 (Focus-Editor-Bug)', () => {
  const broken = 'Stefan fand problemlos eine Anstellung bei den SBB-Werkstätten.&nbsp;';
  const out = cleanPageHtml(broken);
  // Trailing &nbsp; ist Phantom-Rev-Quelle (Editor-Cursor-Anker) und wird
  // via stripBlockEdgeNbsp entfernt; sichtbarer Text bleibt unveraendert.
  assert.equal(out, '<p>Stefan fand problemlos eine Anstellung bei den SBB-Werkstätten.</p>');
});

test('stripBlockEdgeNbsp: trailing &#160; im Block-Ende wird entfernt', () => {
  assert.equal(
    stripBlockEdgeNbsp('<p>Text&#160;</p>'),
    '<p>Text</p>'
  );
});

test('stripBlockEdgeNbsp: leading NBSP am Block-Anfang wird entfernt', () => {
  assert.equal(
    stripBlockEdgeNbsp('<p>&#160;Text</p>'),
    '<p>Text</p>'
  );
});

test('stripBlockEdgeNbsp: NBSP mitten im Block bleibt erhalten', () => {
  // Mid-Block-NBSP ist gewollt (Geviert-Trennung, Vorname&nbsp;Nachname).
  const out = stripBlockEdgeNbsp('<p>Vorname&#160;Nachname</p>');
  assert.match(out, /Vorname( |&nbsp;|&#160;)Nachname/);
});

test('stripBlockEdgeNbsp: trailing NBSP in <li> + <h2>', () => {
  assert.equal(stripBlockEdgeNbsp('<li>Eintrag&#160;</li>'), '<li>Eintrag</li>');
  assert.equal(stripBlockEdgeNbsp('<h2>Titel&#160;</h2>'), '<h2>Titel</h2>');
});

test('stripBlockEdgeNbsp: NBSP nur in einem Block, andere unberuehrt', () => {
  const out = stripBlockEdgeNbsp('<p>A</p><p>B&#160;</p><p>C</p>');
  assert.equal(out, '<p>A</p><p>B</p><p>C</p>');
});

test('cleanPageHtml: trailing NBSP in mehreren Absaetzen alle gestripped', () => {
  // Reproduziert konkreten Phantom-Rev-Case: rev 158 vs rev 159 in Prod
  // unterschieden sich nur durch trailing &#160; im letzten <p>.
  const a = '<p>Text 1.&#160;</p><p>Text 2.</p><p>Text 3.&#160;</p>';
  const b = '<p>Text 1.</p><p>Text 2.</p><p>Text 3.</p>';
  assert.equal(cleanPageHtml(a), cleanPageHtml(b));
});

test('stripBlockEdgeNbsp: idempotent', () => {
  const input = '<p>X&#160;</p>';
  const once = stripBlockEdgeNbsp(input);
  const twice = stripBlockEdgeNbsp(once);
  assert.equal(once, twice);
});
