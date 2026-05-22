'use strict';
// Splittet Eingabe-Text fuer den LanguageTool-Proxy in <=CHUNK_MAX-Stuecke und
// haengt LT-Match-Offsets nach dem Call wieder auf absolute Positionen um.
//
// LT-Server cappt freie Anfragen typischerweise bei ~50-100 KB; wir splitten
// vorsichtig bei 50_000 UTF-16 Code-Units (= JS String.length = LT-Offset-
// Semantik).
//
// Strategie pro Split:
//   1. Paragraph-Boundary "\n\n" (LT respektiert das als Paragraph-Break, kein
//      Verlust an Kontext fuer cross-paragraph-Regeln, die es eh nicht gibt).
//   2. Falls Paragraph >CHUNK_MAX: Satz-Boundary (. ! ? \n).
//   3. Falls Satz immer noch >CHUNK_MAX: Hard-Split (Worst Case).
//
// `chunkText` liefert immer [{ text, offset }] -- offset ist absolute Position
// im Original-String. Bei kurzem Input ein Eintrag mit offset=0.

const CHUNK_MAX = 50_000;

function chunkText(input, max = CHUNK_MAX) {
  const text = typeof input === 'string' ? input : '';
  if (!text) return [];
  if (text.length <= max) return [{ text, offset: 0 }];

  const parts = [];
  const re = /\n{2,}/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    parts.push({ text: text.slice(lastIdx, m.index + m[0].length), offset: lastIdx });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx), offset: lastIdx });
  }

  const chunks = [];
  let buf = '';
  let bufOffset = -1;
  for (const p of parts) {
    if (p.text.length > max) {
      if (buf) { chunks.push({ text: buf, offset: bufOffset }); buf = ''; bufOffset = -1; }
      for (const sub of _splitSentences(p.text, max, p.offset)) {
        if (sub.text.length > max) {
          for (const hs of _hardSplit(sub.text, max, sub.offset)) chunks.push(hs);
        } else {
          chunks.push(sub);
        }
      }
      continue;
    }
    if (buf.length + p.text.length > max) {
      chunks.push({ text: buf, offset: bufOffset });
      buf = '';
      bufOffset = -1;
    }
    if (!buf) { buf = p.text; bufOffset = p.offset; }
    else { buf += p.text; }
  }
  if (buf) chunks.push({ text: buf, offset: bufOffset });
  return chunks;
}

function _splitSentences(text, max, baseOffset) {
  const re = /([.!?\n]+\s*)/g;
  const parts = [];
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    parts.push({ text: text.slice(lastIdx, end), offset: baseOffset + lastIdx });
    lastIdx = end;
  }
  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx), offset: baseOffset + lastIdx });
  }

  const out = [];
  let buf = '';
  let bufOffset = -1;
  for (const p of parts) {
    if (p.text.length > max) {
      if (buf) { out.push({ text: buf, offset: bufOffset }); buf = ''; bufOffset = -1; }
      out.push(p);
      continue;
    }
    if (buf.length + p.text.length > max) {
      out.push({ text: buf, offset: bufOffset });
      buf = '';
      bufOffset = -1;
    }
    if (!buf) { buf = p.text; bufOffset = p.offset; }
    else { buf += p.text; }
  }
  if (buf) out.push({ text: buf, offset: bufOffset });
  return out;
}

function _hardSplit(text, max, baseOffset) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const minEnd = i + Math.floor(max * 0.8);
      let cut = end;
      for (let j = end; j > minEnd; j--) {
        if (/\s/.test(text[j])) { cut = j + 1; break; }
      }
      end = cut;
    }
    out.push({ text: text.slice(i, end), offset: baseOffset + i });
    i = end;
  }
  return out;
}

function adjustMatches(chunkOffset, matches) {
  if (!Array.isArray(matches)) return [];
  if (!chunkOffset) return matches.slice();
  return matches.map((m) => {
    if (!m || typeof m !== 'object' || typeof m.offset !== 'number') return m;
    return { ...m, offset: m.offset + chunkOffset };
  });
}

module.exports = { chunkText, adjustMatches, CHUNK_MAX };
