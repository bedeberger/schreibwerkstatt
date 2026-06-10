'use strict';

function splitParagraphs(text) {
  return text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
}

// Abkürzungen, die mit einem Punkt enden, aber KEIN Satzende markieren. Ohne
// diese Liste schneidet der Splitter „z. B.", „Dr.", „S. 12", „d. h." mitten
// im Satz — und Prompt endet auf „z." während die Completion mit „B. …"
// beginnt. Single-Letter-Fall (Initialen, gesplittete Abk. wie „z. B.") wird
// generisch behandelt, Mehrbuchstaben-Abk. über das Set.
const ABBREVIATIONS = new Set([
  // Deutsch
  'dr', 'prof', 'nr', 'hr', 'fr', 'frl', 'hrsg', 'ggf', 'evtl', 'bzw', 'usw',
  'etc', 'ca', 'vgl', 'abb', 'kap', 'bd', 'aufl', 'sog', 'inkl', 'exkl', 'max',
  'min', 'mio', 'mrd', 'tel', 'str', 'geb', 'gest', 'jh', 'jhdt', 'jt', 'pos',
  'art', 'abs', 'zit', 'ebd', 'ders', 'dies', 'bspw', 'tsd', 'urspr', 'eigtl',
  // Englisch
  'mr', 'mrs', 'ms', 'sr', 'jr', 'st', 'vs', 'inc', 'ltd', 'co', 'corp',
  'dept', 'fig', 'vol', 'pp', 'ed', 'eds', 'al', 'approx', 'esp',
]);

// True, wenn der Punkt an `dotIdx` zu einer Abkürzung gehört (kein Satzende).
function isAbbreviationBefore(text, dotIdx) {
  let i = dotIdx - 1;
  let word = '';
  while (i >= 0 && /[A-Za-zÄÖÜäöüß]/.test(text[i])) { word = text[i] + word; i--; }
  if (!word) return false;
  if (word.length === 1) return true; // Initial / gesplittete Abk. („z. B.")
  return ABBREVIATIONS.has(word.toLowerCase());
}

// Zerlegt Fliesstext in Sätze. Heuristik: Satzende = [.!?…], optional gefolgt
// von schliessender Anführungszeichen, dann Whitespace oder EOT. Hängt den
// Schlussrest (ohne Satzzeichen-Ende) als eigenen Satz an. Für deutsche und
// englische Prosa ausreichend zuverlässig; einfacher Punkt nach einer
// Abkürzung (siehe `isAbbreviationBefore`) gilt nicht als Satzende.
function splitSentences(text) {
  const out = [];
  const re = /([.!?…]+["”«»„‹›']?)(\s+|$)/g;
  let lastEnd = 0, m;
  while ((m = re.exec(text)) !== null) {
    const dotCore = m[1].replace(/["”«»„‹›']$/, '');
    if (dotCore === '.' && isAbbreviationBefore(text, m.index)) continue;
    const sentence = text.slice(lastEnd, m.index + m[1].length).trim();
    if (sentence) out.push(sentence);
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail) out.push(tail);
  return out;
}

// Liefert die Start-Indizes aller Sätze nach einer Satzgrenze (= Index des
// ersten Zeichens des Folgesatzes). Überspringt Abkürzungs-Punkte und verlangt
// — wie die alte Heuristik — dass der Folgesatz mit Grossbuchstabe, Ziffer oder
// öffnendem Anführungszeichen beginnt.
function sentenceBoundaryIndices(text) {
  const re = /([.!?…]+["”«»„‹›']?)(\s+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const dotCore = m[1].replace(/["”«»„‹›']$/, '');
    if (dotCore === '.' && isAbbreviationBefore(text, m.index)) continue;
    const nextIdx = m.index + m[0].length;
    const nextChar = text[nextIdx];
    if (nextChar && !/[A-ZÄÖÜ"„«»0-9]/.test(nextChar)) continue;
    out.push(nextIdx);
  }
  return out;
}

// Splittet `text` an einer Satzgrenze nahe `ratio` (0–1). Bevorzugt die letzte
// Grenze bei/vor dem Zielindex (kein Überschiessen — wichtig fürs
// Verbatim-Chunking), sonst die erste danach. Gibt exakte Substrings zurück
// (nur an den Enden getrimmt) — der Verbatim-Sampler verlangt wörtliche Wiedergabe.
function splitAtSentence(text, ratio) {
  const target = Math.max(1, Math.min(text.length - 1, Math.floor(text.length * ratio)));
  const bounds = sentenceBoundaryIndices(text); // aufsteigend
  if (bounds.length) {
    let pick = -1;
    for (const b of bounds) { if (b <= target) pick = b; else break; }
    if (pick === -1) pick = bounds[0]; // alle Grenzen liegen hinter dem Ziel
    return [text.slice(0, pick).trim(), text.slice(pick).trim()];
  }
  return [text.slice(0, target).trim(), text.slice(target).trim()];
}

const splitHalfAtSentence = (text) => splitAtSentence(text, 0.5);

// Dialog-Zitate (DE + EN-Typografie + ASCII). Bewusst konservativ — matched nur
// Zitate innerhalb eines Absatzes (keine Zeilenumbrüche), damit keine
// mehrseitigen False-Positives entstehen.
function extractDialogs(text) {
  const results = [];
  const patterns = [
    /„([^"\n]{10,400})"/g,
    /"([^"\n]{10,400})"/g,     // U+201C/U+201D
    /«\s?([^»\n]{10,400})\s?»/g,
    /"([^"\n]{10,400})"/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      results.push({ quote: m[1].trim(), start: m.index, end: m.index + m[0].length });
    }
  }
  results.sort((a, b) => a.start - b.start);
  return results;
}

module.exports = {
  splitParagraphs,
  splitSentences,
  splitAtSentence,
  splitHalfAtSentence,
  extractDialogs,
};
