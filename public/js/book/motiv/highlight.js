// Motiv-Werkstatt — Fundstelle im Seitentext hervorheben (reines Lesen, keine
// DOM-Mutation): nach dem Sprung auf die Seite wird der Occurrence-Snippet im
// gerenderten `.page-content-view` gesucht und via CSS Custom Highlight API
// (::highlight(motiv-hit), Muster wie Find/TTS) markiert + zentriert. Findet die
// Passage nicht (semantischer Chunk quer über Blockgrenzen), wird auf das längste
// distinktive Wort zurückgefallen; findet auch das nichts, passiert nichts (der
// Sprung auf die Seite bleibt bestehen).

const HL_NAME = 'motiv-hit';
const MAX_PHRASE_WORDS = 12;

function _clear() {
  try { window.CSS?.highlights?.delete(HL_NAME); } catch (_) { /* API evtl. nicht da */ }
}
function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// Range über die konkatenierten Text-Nodes bilden (whitespace-tolerant: die im
// Snippet enthaltenen Leerräume matchen \s+, weil der DOM-Text anders umbricht).
function _findRange(root, snippet) {
  const nodes = _textNodes(root);
  if (!nodes.length) return null;
  const starts = [];
  let acc = 0;
  const hay = nodes.map(n => { starts.push(acc); acc += n.nodeValue.length; return n.nodeValue; }).join('').toLowerCase();
  if (!hay.trim()) return null;

  const words = snippet.trim().toLowerCase().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!words.length) return null;

  const tryRe = (re) => { try { return re.exec(hay); } catch (_) { return null; } };
  // 1) Phrase (erste MAX_PHRASE_WORDS Wörter), Whitespace-tolerant.
  let m = tryRe(new RegExp(words.slice(0, MAX_PHRASE_WORDS).map(_escapeRe).join('\\s+')));
  // 2) Fallback: längstes distinktives Wort (>=4 Zeichen).
  if (!m) {
    const word = words.filter(w => w.length >= 4).sort((a, b) => b.length - a.length)[0];
    if (!word) return null;
    m = tryRe(new RegExp(_escapeRe(word)));
    if (!m) return null;
  }

  const gStart = m.index;
  const gEnd = m.index + m[0].length;
  const map = (g) => {
    for (let i = 0; i < nodes.length; i++) {
      const s = starts[i];
      const e = s + nodes[i].nodeValue.length;
      if (g >= s && g <= e) return { node: nodes[i], offset: g - s };
    }
    return null;
  };
  const a = map(gStart);
  const b = map(gEnd);
  if (!a || !b) return null;
  const r = document.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch (_) { return null; }
  return r;
}

// Öffentlicher Einstieg: nach der Navigation aufgerufen. Wartet per rAF, bis die
// Seite gerendert ist (bis ~40 Frames), markiert dann + scrollt zentriert. Räumt
// die Markierung nach einigen Sekunden wieder ab.
export function highlightOccurrenceOnPage(snippet) {
  _clear();
  if (!snippet || !window.CSS?.highlights || typeof window.Highlight === 'undefined') return;
  let tries = 0;
  const attempt = () => {
    const root = document.querySelector('.page-content-view');
    if (root && root.textContent && root.textContent.trim()) {
      const r = _findRange(root, snippet);
      if (r) {
        try {
          window.CSS.highlights.set(HL_NAME, new window.Highlight(r));
          (r.startContainer.parentElement || root).scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(_clear, 4500);
        } catch (_) { /* Range/Highlight abgelaufen — egal */ }
        return;
      }
    }
    if (tries++ < 40) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
