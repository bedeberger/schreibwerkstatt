'use strict';
// Kanonische DE-Stoppwortliste. Single Source of Truth fuer
// Wiederholungs-Analyse (lib/page-index.js) und Figur-Alias-Filter
// (public/js/editor/notebook/entities.js).
// Spiegel-Datei: public/js/shared/stopwords-de.js (ESM, Client).
// Drift-Schutz: tests/unit/stopwords-de-drift.test.mjs vergleicht beide.

const STOPWORDS_DE_BASE = [
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einen', 'einem', 'eines',
  'und', 'oder', 'aber', 'sondern', 'denn', 'doch', 'weil', 'dass', 'daß', 'wenn', 'als', 'ob',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mich', 'dich', 'ihn', 'uns', 'euch', 'ihm',
  'mir', 'dir', 'mein', 'dein', 'sein', 'ihre', 'unser', 'euer',
  'in', 'im', 'an', 'am', 'auf', 'zu', 'zum', 'zur', 'bei', 'mit', 'nach', 'von', 'vom',
  'aus', 'über', 'unter', 'vor', 'hinter', 'neben', 'zwischen', 'durch', 'für', 'gegen', 'um',
  'ist', 'sind', 'war', 'waren', 'bin', 'bist', 'seid', 'gewesen', 'hat', 'habe', 'hast',
  'hatten', 'hatte', 'haben', 'werden', 'wird', 'wurde', 'wurden', 'worden', 'wirst',
  'nicht', 'kein', 'keine', 'keiner', 'keinen', 'nichts', 'auch', 'noch', 'nur', 'schon',
  'so', 'wie', 'was', 'wer', 'wo', 'warum', 'weshalb', 'wann', 'woher', 'wohin',
  'dann', 'dort', 'hier', 'da', 'nun', 'jetzt', 'immer', 'nie', 'oft', 'manchmal',
  'ja', 'nein', 'mal', 'halt', 'eben', 'zwar',
];

module.exports = { STOPWORDS_DE_BASE };
