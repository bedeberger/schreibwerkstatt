'use strict';
// Page-Geometrie + Kapitel-Numerierung. Reine Funktionen, keine pdfkit-State-Mutation.

const MM_TO_PT = 72 / 25.4;
const PAGE_DIMS_PT = {
  A4:     [595.28, 841.89],
  A5:     [419.53, 595.28],
  A6:     [297.64, 419.53],
  Letter: [612, 792],
};

function _pageSize(layout) {
  if (layout.pageSize === 'custom') {
    return [layout.customWidthMm * MM_TO_PT, layout.customHeightMm * MM_TO_PT];
  }
  return PAGE_DIMS_PT[layout.pageSize] || PAGE_DIMS_PT.A4;
}

function _romanize(num) {
  if (num <= 0) return String(num);
  const map = [['M',1000],['CM',900],['D',500],['CD',400],['C',100],['XC',90],['L',50],['XL',40],['X',10],['IX',9],['V',5],['IV',4],['I',1]];
  let out = '';
  for (const [r, v] of map) while (num >= v) { out += r; num -= v; }
  return out;
}

const _WORD_NUMERALS = {
  de: ['', 'Eins', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs', 'Sieben', 'Acht', 'Neun',
       'Zehn', 'Elf', 'Zwölf', 'Dreizehn', 'Vierzehn', 'Fünfzehn', 'Sechzehn',
       'Siebzehn', 'Achtzehn', 'Neunzehn', 'Zwanzig'],
  en: ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
       'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
       'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'],
};

function _wordize(num, lang) {
  // Kapitel 1-20 als Wort; danach Fallback auf arabisch.
  const W = _WORD_NUMERALS[lang] || _WORD_NUMERALS.de;
  return W[num] || String(num);
}

function _chapterLabel(numbering, idx, lang) {
  switch (numbering) {
    case 'arabic': return String(idx);
    case 'roman':  return _romanize(idx);
    case 'word':   return _wordize(idx, lang);
    default:       return null;
  }
}

// Hierarchisches Label: counters = [topIdx, subIdx, subSubIdx], depth ∈ {1,2,3}.
// `mode`: 'flat' → nur counters[depth-1]; 'nested' → counters[0..depth-1].join('.').
// Roman/Word fallen ab Tiefe 2 immer auf arabisch zurueck (Sub-Kapitel als
// „Sub-Sub-1.II.b" wuerden unleserlich werden).
function _chapterLabelNested(numbering, counters, depth, mode, lang) {
  if (!numbering || numbering === 'none') return null;
  if (depth <= 1 || mode === 'flat') {
    return _chapterLabel(numbering, counters[depth - 1] || 0, lang);
  }
  // nested: top-Label im Original-Format, Sub-Ebenen arabisch.
  const top = _chapterLabel(numbering, counters[0] || 0, lang);
  const tail = counters.slice(1, depth).map(n => String(n || 0)).join('.');
  return `${top}.${tail}`;
}

module.exports = { MM_TO_PT, PAGE_DIMS_PT, _pageSize, _romanize, _chapterLabel, _chapterLabelNested };
