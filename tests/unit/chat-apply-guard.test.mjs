// Regression: Der Seiten-Chat darf einen `vorschlag` nur dann als „gespeichert"
// melden, wenn die Ersetzung tatsaechlich stattfindet — und nie blind die
// falsche Fundstelle treffen.
//
// Der Guard lebt in public/js/chat/chat.js#applyChatVorschlag (Alpine-Methode,
// in Node nicht importierbar wegen Browser-Deps). Getestet wird die Engine
// direkt (countInHtml/replaceInHtml aus utils.js) plus ein 1:1-Mirror des
// Pre-Check-Entscheidungsbaums:
//   countInHtml == 0  -> 'originalNotFound'
//   countInHtml  > 1  -> 'originalAmbiguous'   (kein Blind-Ersatz)
//   replaceInHtml No-Op + Link -> 'spansLink'  (Hyperlink umschlossen)
//   replaceInHtml No-Op        -> 'crossesBlockBoundary' (Absatzgrenze)
//   sonst              -> 'ok'

import test from 'node:test';
import assert from 'node:assert/strict';
import { countInHtml, replaceInHtml, matchSpansLink } from '../../public/js/utils.js';

// 1:1-Mirror der Pre-Check-Reihenfolge in applyChatVorschlag.
function guard(html, vorschlag) {
  const occurrences = countInHtml(html, vorschlag.original);
  if (occurrences === 0) return 'originalNotFound';
  if (occurrences > 1) return 'originalAmbiguous';
  if (replaceInHtml(html, vorschlag.original, vorschlag.ersatz) === html) {
    return matchSpansLink(html, vorschlag.original) ? 'spansLink' : 'crossesBlockBoundary';
  }
  return 'ok';
}

// ── countInHtml ──────────────────────────────────────────────────────────────

test('countInHtml: 0 wenn Text fehlt, 1 bei einmaligem Vorkommen', () => {
  const html = '<p>Der Hund bellt.</p>';
  assert.equal(countInHtml(html, 'gibt es nicht'), 0);
  assert.equal(countInHtml(html, 'Der Hund bellt.'), 1);
});

test('countInHtml: mehrfaches Vorkommen wird gezaehlt (nicht ueberlappend)', () => {
  const html = '<p>Hallo Welt.</p><p>Hallo Welt.</p><p>Hallo Welt.</p>';
  assert.equal(countInHtml(html, 'Hallo Welt.'), 3);
});

test('countInHtml: tolerant ueber Inline-Tags und kollabierbaren Whitespace hinweg', () => {
  // KI sieht Plaintext; im HTML steckt ein <em> + kollabierbarer Whitespace.
  // (Entity-Dekodierung braucht das DOM und wird darum hier nicht geprueft.)
  const html = '<p>Er sagte   <em>das magische</em>\n Wort.</p>';
  assert.equal(countInHtml(html, 'das magische Wort'), 1);
});

// ── Guard-Entscheidungsbaum ──────────────────────────────────────────────────

test('Guard: eindeutige, ersetzbare Stelle -> ok', () => {
  const html = '<p>Der Hund bellt laut.</p><p>Die Katze schläft.</p>';
  assert.equal(guard(html, { original: 'bellt laut', ersatz: 'bellt leise' }), 'ok');
});

test('Guard: fehlender Originaltext -> originalNotFound', () => {
  const html = '<p>Der Hund bellt.</p>';
  assert.equal(guard(html, { original: 'die Katze miaut', ersatz: 'x' }), 'originalNotFound');
});

test('Guard: mehrdeutige Stelle -> originalAmbiguous (kein Blind-Ersatz)', () => {
  const html = '<p>Hallo Welt.</p><p>Hallo Welt.</p>';
  assert.equal(guard(html, { original: 'Hallo Welt.', ersatz: 'Servus Welt.' }), 'originalAmbiguous');
});

test('Guard: Absatzgrenzen-Vorschlag -> crossesBlockBoundary statt still-falscher Erfolg', () => {
  // Kern-Bug: countInHtml/findInHtml finden den Text (Tag-agnostisch), aber
  // replaceInHtml laesst ihn zum Schutz der Absatzstruktur unangetastet.
  const html = '<p>Er ging nach Hause.</p><p>Dann schlief er ein.</p>';
  assert.equal(guard(html, { original: 'nach Hause. Dann', ersatz: 'heim. Sofort danach' }), 'crossesBlockBoundary');
});

test('Guard: Listen-Grenzen-Vorschlag -> crossesBlockBoundary', () => {
  const html = '<ul><li>Erstens.</li><li>Zweitens.</li></ul>';
  assert.equal(guard(html, { original: 'Erstens. Zweitens', ersatz: 'Eins. Zwei' }), 'crossesBlockBoundary');
});

test('Guard: Inline-<em>-Spanne bleibt ok (keine Block-Grenze)', () => {
  const html = '<p>Er sagte <em>das magische</em> Wort.</p>';
  assert.equal(guard(html, { original: 'das magische Wort', ersatz: 'das geheime Wort' }), 'ok');
});

// ── Link-Schutz ──────────────────────────────────────────────────────────────
// Kern-Bug dieser Session: ein Vorschlag, der einen vollständigen <a>…</a>
// umspannt, hätte beim Ersetzen das href ersatzlos verworfen (nur Linktext blieb).
// replaceInHtml lässt die Stelle jetzt unangetastet, der Guard meldet spansLink.

test('Guard: umspannter Hyperlink -> spansLink (Link nicht zerstört)', () => {
  const html = '<p>Besuche <a href="https://example.com">unsere Website</a> heute.</p>';
  const res = replaceInHtml(html, 'Besuche unsere Website heute', 'Schau heute auf unserer Website vorbei');
  assert.equal(res, html, 'replaceInHtml darf den Link-Bereich nicht verändern');
  assert.equal(guard(html, { original: 'Besuche unsere Website heute', ersatz: 'Schau heute auf unserer Website vorbei' }), 'spansLink');
});

test('Guard: Korrektur neben dem Link (Link nicht umspannt) -> ok, Link bleibt erhalten', () => {
  const html = '<p>Besuche <a href="https://example.com">unsere Website</a> heute unbedingt.</p>';
  const res = replaceInHtml(html, 'heute unbedingt', 'gleich morgen');
  assert.ok(res.includes('href="https://example.com"'), 'Link muss erhalten bleiben');
  assert.ok(res.includes('gleich morgen'), 'Korrektur muss angewandt sein');
  assert.equal(guard(html, { original: 'heute unbedingt', ersatz: 'gleich morgen' }), 'ok');
});

test('replaceInHtml: Waisen-</a> im Treffer (Open davor) wird wieder angeklebt', () => {
  // Treffer umspannt das schliessende </a>: Close liegt im Bereich, Open davor.
  // _containsBalancedAnchor greift NICHT (kein Paar im Slice); der Orphan-
  // Mechanismus klebt </a> wieder an — der Link überlebt die Ersetzung.
  const html = '<p><a href="https://example.com">unsere Website</a> lohnt sich.</p>';
  const res = replaceInHtml(html, 'Website lohnt', 'Seite lohnt');
  assert.ok(res.includes('href="https://example.com"'), 'Link muss erhalten bleiben');
  assert.ok(res.includes('</a>'), 'schliessendes Tag muss erhalten bleiben');
  assert.ok(res.includes('Seite lohnt'), 'Ersetzung muss greifen');
});
