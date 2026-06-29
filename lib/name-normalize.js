'use strict';
// Figuren-Namens-Normalisierung — geteilte SSoT für Cross-Run-Matching
// (db/figures.js) und Intra-Run-Dedup (routes/jobs/komplett/figuren-merge.js).
//
// Liegt in lib/, weil beide Konsumenten (db/ und routes/) darauf zugreifen, ohne
// eine Layering-Inversion (db/ → routes/) einzuführen.

// Titel/Anrede-Präfixe (Dr., Prof., Herr, Frau, …), die für den Namensvergleich
// abgeschnitten werden.
const TITLE_PREFIX_RE = /^(?:dr\.?|doktor|prof\.?|professor|herrn?|hr\.?|frau|fr\.?|fräulein)\s+/;

// Namensbestandteile, die als Token kein Diskriminator sind (Adelspartikel/Artikel).
const NAME_STOPWORDS = new Set(['von', 'zu', 'van', 'der', 'die', 'das', 'den', 'dem', 'de', 'la']);

// Lowercased, getrimmt, Whitespace kollabiert, Titel-Präfixe iterativ entfernt.
function normName(s) {
  let r = (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  while (TITLE_PREFIX_RE.test(r)) r = r.replace(TITLE_PREFIX_RE, '');
  return r;
}

// Bedeutungstragende Namens-Token (>1 Zeichen, keine Stopwords) für Token-Matching.
function nameTokens(name) {
  return normName(name)
    .split(/[\s\-.]+/)
    .filter(t => t.length > 1 && !NAME_STOPWORDS.has(t));
}

module.exports = { TITLE_PREFIX_RE, NAME_STOPWORDS, normName, nameTokens };
