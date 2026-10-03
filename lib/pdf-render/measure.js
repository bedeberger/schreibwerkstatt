'use strict';
// Breitenmessung mit Cache pro Render-Lauf.
//
// Fliesstext-Layouter (justify.js), Fussnotenapparat (footnotes.js) und
// Tabellensatz (table.js) messen dieselben Woerter immer wieder in denselben
// Schriften — bei einem Buch mit 1,5 Mio. Zeichen sind das Millionen
// `widthOfString`-Aufrufe fuer wenige zehntausend verschiedene Woerter. Der
// Cache haengt am Dokument (WeakMap), lebt also genau einen Render-Lauf und
// faellt mit dem Dokument weg; kein Modul muss ihn durchreichen.
//
// Schluessel: Font-Key + Groesse + OpenType-Features + Text. Die Features
// gehoeren hinein, weil Kerning/Ligaturen die Breite aendern — die globale
// Liste (fonts.js#_patchOpenTypeFeatures) ist pro Lauf konstant, darum wird sie
// einmal zu einem String gefaltet.

const _caches = new WeakMap();

function _cacheOf(doc) {
  let c = _caches.get(doc);
  if (!c) {
    const features = doc._otFeatures;
    c = { map: new Map(), features, featKey: Array.isArray(features) ? features.join(',') : '' };
    _caches.set(doc, c);
  }
  return c;
}

/** Breite von `text` in `fontKey`/`sizePt` (pt), gecacht pro Dokument.
 *  Setzt Font und Groesse am Dokument nur bei einem Cache-Miss — Aufrufer
 *  duerfen sich also NICHT darauf verlassen, dass danach diese Schrift aktiv ist. */
function measureText(doc, text, fontKey, sizePt) {
  const c = _cacheOf(doc);
  const key = fontKey + '\u0000' + sizePt + '\u0000' + c.featKey + '\u0000' + text;
  let w = c.map.get(key);
  if (w === undefined) {
    doc.font(fontKey).fontSize(sizePt);
    w = doc.widthOfString(text, c.features ? { features: c.features } : undefined);
    c.map.set(key, w);
  }
  return w;
}

/** Zeilenvorschub einer Schrift: Font-eigene Zeilenhoehe + Zusatzabstand aus
 *  dem Zeilenabstands-Faktor. Dieselbe Formel wie der Layouter in justify.js. */
function lineAdvance(doc, fontKey, sizePt, lineHeight) {
  doc.font(fontKey).fontSize(sizePt);
  return doc.currentLineHeight(true) + ((lineHeight || 1) - 1) * sizePt;
}

/** Nur fuer Tests/Diagnose: Zahl der Cache-Eintraege. */
function measureCacheSize(doc) {
  const c = _caches.get(doc);
  return c ? c.map.size : 0;
}

module.exports = { measureText, lineAdvance, measureCacheSize };
