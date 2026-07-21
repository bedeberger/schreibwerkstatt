// Anführungszeichen-Normalisierer für Notebook- + Focus-Editor.
//
// Walk über Blöcke des Edit-Roots; ersetzt gerade `"` / `'` und alle
// typografischen Quote-Varianten (`„` `“` `”` `‚` `‘` `’` `«` `»` `‹` `›`)
// durch das Buch-Locale (book_settings.language + region). Bereits style-
// konforme Quotes bleiben unverändert. Apostroph zwischen Buchstaben/
// Ziffern → U+2019; ebenso ein einzelner `'` direkt nach Wort, wenn kein
// Single-Quote offen ist (Saxon-Genitiv/Elision `Chris'`, `auf geht's`) —
// sonst würde er fälschlich als schliessendes Single-Quote (de-CH `›`) gesetzt.
// Skip: <pre>, <code>, <script>, <style>.
//
// Klassifikation rein kontextbasiert — kein Open/Close-State. Jeder Quote wird
// anhand der Nachbarschaftszeichen (prev/next) eigenständig entschieden.
// Zwei Scopes: `normalizeQuotes(rootEl, style)` page-weit (Slash-Item Notebook +
// Focus-Topbar), `normalizeQuotesInRange(range, style)` für eine Selection-Range
// (Bubble-Toolbar Notebook). ASCII-Dot-Runs innerhalb offener Quote-Klammer →
// `…`; nur in Quote-Scope (`quoteStack.length > 0`), damit `z.B.`/`usw.` bleiben.

const STYLES = {
  // Schweiz / Liechtenstein: Guillemets aussen, Single-Guillemets innen
  'de-CH': { ldquo: '«', rdquo: '»', lsquo: '‹', rsquo: '›', apostrophe: '’' },
  'de-LI': { ldquo: '«', rdquo: '»', lsquo: '‹', rsquo: '›', apostrophe: '’' },
  // Deutschland / Österreich: „…" aussen, ‚…' innen
  'de-DE': { ldquo: '„', rdquo: '“', lsquo: '‚', rsquo: '‘', apostrophe: '’' },
  'de-AT': { ldquo: '„', rdquo: '“', lsquo: '‚', rsquo: '‘', apostrophe: '’' },
  // English modern (en-US: Chicago/AP/MLA; en-GB: Oxford 2014+/Cambridge/Guardian/
  // BBC): outer double curly, inner single curly. Apostroph U+2019.
  'en':    { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apostrophe: '’', lang: 'en' },
  'en-US': { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apostrophe: '’', lang: 'en' },
  'en-GB': { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apostrophe: '’', lang: 'en' },
  // Französisch: « … », ‹ … ›  (NBSP U+00A0 innen — schmal-fest, kein Umbruch)
  'fr':    { ldquo: '« ', rdquo: ' »', lsquo: '‹ ', rsquo: ' ›', apostrophe: '’' },
  // Italienisch (Italien): «…» aussen, "…" innen
  'it-IT': { ldquo: '«', rdquo: '»', lsquo: '“', rsquo: '”', apostrophe: '’' },
};

const DEFAULT_STYLE = STYLES['de-CH'];

export function resolveQuoteStyle(language, region) {
  const l = (language || '').toLowerCase();
  const r = (region || '').toUpperCase();
  if (l && r) {
    const tag = `${l}-${r}`;
    if (STYLES[tag]) return STYLES[tag];
  }
  if (l && STYLES[l]) return STYLES[l];
  if (l === 'it') return STYLES['it-IT'];
  return DEFAULT_STYLE;
}

const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, td, th, div.poem';
const SKIP_SEL  = 'pre, code, script, style';

const LETTER_DIGIT = /[\p{L}\p{N}]/u;
// Öffnungs-Kontext: Whitespace, Klammer-auf, Gedankenstrich, bereits gesetzte
// öffnende Quote-Varianten (für nested „...'...'").
const OPEN_CTX  = /[\s({\[–—\-«‹„‚“‘]/;
// Schliess-Kontext: Whitespace, Klammer-zu, Satzzeichen, bereits gesetzte
// schliessende Quote-Varianten.
const CLOSE_CTX = /[\s)\]}.,;:!?»›"”’]/;

// Trigger-Set: alle Quote-Glyphen, die re-klassifiziert werden. Style-fremde
// (z.B. `„` in de-CH oder `«` in en) werden umgeschrieben; style-konforme
// klassifizieren sich auf sich selbst zurück (idempotent).
const DOUBLE_LEFT  = new Set(['„', '“', '«']);
const DOUBLE_RIGHT = new Set(['”', '»']);
const SINGLE_LEFT  = new Set(['‚', '‘', '‹']);
const SINGLE_RIGHT = new Set(['’', '›']);
const ASCII_DOUBLE = '"';
const ASCII_SINGLE = "'";

// English leading-apostrophe-Kontraktionen (Word/Pages/Google-Docs-Heuristik).
// Wenn `'<wort>` mit `wort` in dieser Liste → Apostroph statt öffnendes
// Single-Quote. Plus Year-Shorthand `'90s`, `'00`, `'76`.
const EN_LEADING_CONTRACTIONS = new Set([
  'tis', 'twas', 'em', 'cause', 'bout', 'n', 'til', 'round', 'nother',
  'gainst', 'pon', 'lectric', 'allo', 'ave', 'nuff', 'sup',
]);
const EN_YEAR_SHORTHAND = /^\d{2,4}s?$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function _isEnglish(style) {
  return !!(style && style.lang === 'en');
}

// Sammle bis zu 12 Word-Chars ab Position idx — durch nachfolgende Text-Nodes,
// falls Word an Node-Grenze überspannt (`'<em>tis</em>`). Bricht beim ersten
// Nicht-Word-Char ab.
function _peekWord(s, idx, textNodes, nodeIdx) {
  let w = '';
  for (let k = idx; k < s.length && w.length < 12; k++) {
    if (!WORD_CHAR.test(s[k])) return w;
    w += s[k];
  }
  for (let n = nodeIdx + 1; n < textNodes.length && w.length < 12; n++) {
    if (_isBr(textNodes[n])) return w;
    const ns = textNodes[n].nodeValue;
    if (!ns) continue;
    for (let k = 0; k < ns.length && w.length < 12; k++) {
      if (!WORD_CHAR.test(ns[k])) return w;
      w += ns[k];
    }
  }
  return w;
}

function _isLeadingContraction(word) {
  if (!word) return false;
  if (EN_LEADING_CONTRACTIONS.has(word.toLowerCase())) return true;
  if (EN_YEAR_SHORTHAND.test(word)) return true;
  return false;
}

const SPACES = new Set([' ', ' ']);

function _isLetterDigit(ch) {
  return !!ch && LETTER_DIGIT.test(ch);
}

// Letzter non-ws-Char ist Buchstabe/Ziffer/Satzzeichen/schliessendes Quote?
// → Schliess-Hinweis im Ambig-Fall (prev und next beide whitespace).
const CLOSE_HINT = /[\p{L}\p{N}.,;:!?»›"”’]/u;

// Klassifizierer geben `{ repl, role }` zurück. `role` steuert den block-lokalen
// Nesting-Stack (`open` pusht, `close` poppt, `apostrophe` ignoriert). Die
// finale Glyphe entsteht aus `_depthRepl` — Outer vs. Inner abhängig von der
// aktuellen Verschachtelungstiefe, sodass `"Er sagte "hallo""` in EN korrekt
// zu `"Er sagte 'hallo'"` wird, ohne dass der User Single-Glyphen tippen muss.
function _classifyDouble(c, prev, prevNonWs, next, style) {
  const prevOpen  = !prev || OPEN_CTX.test(prev);
  const nextClose = !next || CLOSE_CTX.test(next);
  if (prevOpen && !nextClose) return { repl: style.ldquo, role: 'open' };
  if (!prevOpen && nextClose) return { repl: style.rdquo, role: 'close' };
  // Ambig (z.B. FR mit NBSP beidseitig): inhärent gerichtete Glyphen
  // entscheiden, sonst prev-non-ws-Hinweis, sonst Default open.
  if (DOUBLE_LEFT.has(c))  return { repl: style.ldquo, role: 'open' };
  if (DOUBLE_RIGHT.has(c)) return { repl: style.rdquo, role: 'close' };
  if (prevNonWs && CLOSE_HINT.test(prevNonWs)) return { repl: style.rdquo, role: 'close' };
  if (prevOpen) return { repl: style.ldquo, role: 'open' };
  return { repl: style.rdquo, role: 'close' };
}

function _classifySingle(c, prev, prevNonWs, next, style, wordAfter, singleOpen) {
  const prevLD = _isLetterDigit(prev);
  const nextLD = _isLetterDigit(next);
  if (prevLD && nextLD) return { repl: style.apostrophe, role: 'apostrophe' };
  const prevOpen  = !prev || OPEN_CTX.test(prev);
  const nextClose = !next || CLOSE_CTX.test(next);
  // Englisch: Leading-Apostroph-Kontraktionen (`'tis`, `'em`, `'90s`,
  // `rock 'n' roll`) — Default-Heuristik klassifizierte fälschlich als lsquo.
  if (_isEnglish(style) && prevOpen && nextLD && _isLeadingContraction(wordAfter)) {
    return { repl: style.apostrophe, role: 'apostrophe' };
  }
  if (prevOpen && !nextClose) return { repl: style.lsquo, role: 'open' };
  if (!prevOpen && nextClose) {
    // Buchstabe/Ziffer davor + Schliess-Kontext danach ist mehrdeutig:
    // echtes schliessendes Single-Quote (`‹Hallo Chris›`) vs. Saxon-Genitiv-/
    // Elisions-Apostroph (`Chris'`, `kids'`, `auf geht's`). Nur ein aktuell
    // offenes Single-Quote macht es zum Schliesser; sonst ist es ein Apostroph
    // — man kann nicht schliessen, was nicht offen ist. (In en fällt rsquo mit
    // apostrophe (’) zusammen, der Unterschied wird erst bei de-CH/de-DE/fr/it
    // mit eigenständiger ›/‘-Glyphe sichtbar.)
    if (prevLD && !singleOpen) return { repl: style.apostrophe, role: 'apostrophe' };
    return { repl: style.rsquo, role: 'close' };
  }
  // Ambig
  if (SINGLE_LEFT.has(c))  return { repl: style.lsquo, role: 'open' };
  if (c === '›')           return { repl: style.rsquo, role: 'close' };
  if (c === '’') {
    return prevLD
      ? { repl: style.apostrophe, role: 'apostrophe' }
      : { repl: style.rsquo, role: 'close' };
  }
  if (prevLD) return { repl: style.apostrophe, role: 'apostrophe' };
  if (prevNonWs && CLOSE_HINT.test(prevNonWs)) return { repl: style.rsquo, role: 'close' };
  if (prevOpen) return { repl: style.lsquo, role: 'open' };
  return { repl: style.apostrophe, role: 'apostrophe' };
}

// Block-lokaler Stack alterniert Outer/Inner. Glyph-Override gilt NUR für
// Double-Quote-Inputs (`"`, `"`, `"`, `«`, `»`): wenn User durchgängig
// dieselbe Glyphe für mehrere Ebenen tippt (`"foo "bar" baz"`), demoten wir
// die innere zu Inner-Single. Explizit getippte Single-Quotes (`'`, `'`, `'`)
// behalten die Klassifizierer-Glyphe — sonst würde `He said 'hi'` zu Outer-
// Double promoviert. Stack-Push/Pop laufen auf beiden Kinds, damit gemischte
// Eingaben (`"outer 'inner' outer"`) korrekte Depth liefern.
function _depthRepl(role, depth, style, fallbackRepl, isDouble) {
  if (!isDouble) return fallbackRepl;
  if (role === 'open') {
    return (depth % 2 === 0) ? style.ldquo : style.lsquo;
  }
  if (role === 'close') {
    if (depth === 0) return fallbackRepl;
    return ((depth - 1) % 2 === 1) ? style.rsquo : style.rdquo;
  }
  return fallbackRepl;
}

function _isDoubleQuote(c) {
  return c === ASCII_DOUBLE || DOUBLE_LEFT.has(c) || DOUBLE_RIGHT.has(c);
}
function _isSingleQuote(c) {
  return c === ASCII_SINGLE || SINGLE_LEFT.has(c) || SINGLE_RIGHT.has(c);
}

// Eigene Walk-Logik statt TreeWalker — linkedom (Unit-Test-Umgebung)
// ignoriert den acceptNode-Filter und würde Text-Nodes in <pre>/<code>
// fälschlich mit-transformieren. `innerBlockSel` (optional) stoppt die Rekursion
// an Block-Elementen — die werden separat normalisiert, sonst leakt der
// prev/next/Stack-State zwischen geschwister-Paragraphen einer Blockquote/Liste.
// `<br>` wird als Marker mitgesammelt — eine weiche Zeilengrenze innerhalb eines
// Blocks (Dialog je Zeile). Konsumenten resetten dort prev/next/Stack, sonst
// vergiftet das Satzende der Vorzeile (`.`) das öffnende Quote der Folgezeile.
function _collectTextNodes(root, skipSel, out, innerBlockSel) {
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      const parent = n.parentElement;
      if (parent && parent.closest(skipSel)) continue;
      out.push(n);
    } else if (n.nodeType === 1) {
      if (n.nodeName === 'BR') { out.push(n); continue; }
      if (n.matches && n.matches(skipSel)) continue;
      if (innerBlockSel && n.matches && n.matches(innerBlockSel)) continue;
      _collectTextNodes(n, skipSel, out, innerBlockSel);
    }
  }
}

function _isBr(node) {
  return node.nodeType === 1 && node.nodeName === 'BR';
}

// Closest BLOCK_SEL-Ancestor eines Text-Nodes innerhalb des common-Walks.
// Wird nur in der Range-Variante gebraucht, wo wir alle Text-Nodes (über
// Block-Grenzen hinweg) sammeln müssen, aber den State an Block-Wechseln
// resetten wollen.
function _closestBlock(textNode, root) {
  let n = textNode.parentElement;
  while (n) {
    if (n === root) return root;
    if (n.matches && n.matches(BLOCK_SEL)) return n;
    n = n.parentElement;
  }
  return root;
}

// Liefert das erste Zeichen, das `nodeIdx+1..end` an Text-Nodes hat. Damit
// kann ein Quote am Ende eines Text-Nodes seinen next-Kontext aus dem
// nächsten Geschwister-Text-Node lesen (z.B. `"<strong>foo</strong>"`).
function _peekNext(textNodes, nodeIdx) {
  for (let k = nodeIdx + 1; k < textNodes.length; k++) {
    if (_isBr(textNodes[k])) return '';
    const s = textNodes[k].nodeValue;
    if (s && s.length) return s[0];
  }
  return '';
}

// Emittiert eine Quote-Glyphe mit style-korrektem Innen-Abstand und macht das
// Ergebnis idempotent — unabhängig davon, wie viele Spaces (regulär/NBSP) bereits
// dastehen. `repl` trägt die Style-Vorgabe inklusive optionalem Innen-Space
// (de-CH: `«`/`»` ohne, fr: `« `/` »` mit NBSP). Der Space wird in
// lead/core/trail zerlegt: open → core+trail plus `dropFollowing` (verwirft die
// direkt folgenden Source-Spaces, auch über Node-Grenzen, statt sie anzudocken →
// keine wachsenden Abstände bei Re-Läufen, egal ob macOS-Autokorrektur oder KI
// sie eingeschleust hat); close → Trailing-Spaces in `out` strippen, dann
// lead+core; apostrophe → nur core. Reiner Glyphen-Style (kein Innen-Space)
// räumt Fremd-Spaces so gleich mit weg.
function _splitRepl(repl) {
  let a = 0, b = repl.length;
  while (a < b && SPACES.has(repl[a])) a++;
  while (b > a && SPACES.has(repl[b - 1])) b--;
  return { lead: repl.slice(0, a), core: repl.slice(a, b) || repl, trail: repl.slice(b) };
}

// `minStrip` begrenzt den close-Strip rückwärts — die Range-Variante schützt so
// den Out-of-Range-Head (Spaces vor `startOff`). `core` = signifikante Glyphe.
function _emitQuote(out, role, repl, minStrip = 0) {
  const { lead, core, trail } = _splitRepl(repl);
  if (role === 'open') return { out: out + core + trail, dropFollowing: true, core };
  if (role === 'close') {
    let e = out.length;
    while (e > minStrip && SPACES.has(out[e - 1])) e--;
    return { out: out.slice(0, e) + lead + core, dropFollowing: false, core };
  }
  return { out: out + core, dropFollowing: false, core };
}

function _normalizeBlock(blockEl, style) {
  // Benachbarte Text-Nodes zusammenführen (Browser-Normalzustand: ein Node pro
  // Inline-Run; Editing/`&#160;`-Parse fragmentiert ihn). Sonst läge das Guillemet
  // im einen, sein NBSP im nächsten Node → einseitiger Strip, FR wüchse pro Lauf.
  blockEl.normalize?.();
  const textNodes = [];
  // Inner Blocks (z.B. <p> in <blockquote>, <li> in <ul>) werden NICHT
  // mitgesammelt — sie laufen als eigene _normalizeBlock-Aufrufe, damit ihr
  // prev/next/Stack-State nicht vom Geschwister geerbt wird.
  _collectTextNodes(blockEl, SKIP_SEL, textNodes, BLOCK_SEL);
  if (!textNodes.length) return 0;

  let count = 0;
  let prevChar = '';
  let prevNonWs = '';
  // Nach öffnendem Quote: direkt folgende Source-Spaces gehören zum (schon
  // emittierten) Innen-Abstand → verworfen, auch über Node-Grenzen.
  let dropFollowing = false;
  // Quote-Stack pro Block (Reset an Block-Grenze). `length` = Nesting-Depth
  // beim aktuellen Char. Inhalt ist irrelevant — wir brauchen nur die Tiefe.
  const quoteStack = [];

  for (let nodeIdx = 0; nodeIdx < textNodes.length; nodeIdx++) {
    const node = textNodes[nodeIdx];
    if (_isBr(node)) {
      // Weiche Zeilengrenze: frischer Kontext wie an einer Block-Grenze.
      prevChar = '';
      prevNonWs = '';
      dropFollowing = false;
      quoteStack.length = 0;
      continue;
    }
    const s = node.nodeValue;
    if (!s) continue;
    let out = '';
    let units = 0; // normalisierte Einheiten in diesem Node (Quotes + Ellipsen)
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (dropFollowing) {
        if (SPACES.has(c)) continue; // Innen-Space nach öffnendem Quote schlucken
        dropFollowing = false;
      }
      const isDouble = _isDoubleQuote(c);
      const isSingle = !isDouble && _isSingleQuote(c);
      if (!isDouble && !isSingle) {
        if (c === '.' && quoteStack.length > 0 && i + 1 < s.length && s[i + 1] === '.') {
          let runLen = 2;
          while (i + runLen < s.length && s[i + runLen] === '.') runLen++;
          out += '…';
          i += runLen - 1;
          prevChar = '…';
          prevNonWs = '…';
          units++;
          continue;
        }
        out += c;
        prevChar = c;
        if (!SPACES.has(c)) prevNonWs = c;
        continue;
      }
      const next = i + 1 < s.length ? s[i + 1] : _peekNext(textNodes, nodeIdx);
      const wordAfter = (isSingle && _isEnglish(style)) ? _peekWord(s, i + 1, textNodes, nodeIdx) : '';
      const singleOpen = isSingle && quoteStack.includes('s');
      const cls = isDouble
        ? _classifyDouble(c, prevChar, prevNonWs, next, style)
        : _classifySingle(c, prevChar, prevNonWs, next, style, wordAfter, singleOpen);
      const repl = _depthRepl(cls.role, quoteStack.length, style, cls.repl, isDouble);
      const em = _emitQuote(out, cls.role, repl);
      out = em.out;
      dropFollowing = em.dropFollowing;
      units++;
      prevChar = out[out.length - 1] || c;
      prevNonWs = em.core;
      if (cls.role === 'open') quoteStack.push(isDouble ? 'd' : 's');
      else if (cls.role === 'close' && quoteStack.length) quoteStack.pop();
    }
    // Geänderter Node zählt ≥1 (auch wenn nur ein Fremd-Space über die Grenze
    // geschluckt wurde → `units` hier 0), unveränderter 0 → no-op bleibt count 0.
    if (out !== s) { node.nodeValue = out; count += Math.max(1, units); }
  }
  return count;
}

// Scannt einen String nur fürs Stack-Update (keine Mutation). Wird in der
// Range-Variante für Out-of-Range-Text benutzt, damit ein selektierter Inner-
// Quote die Depth-Information aus dem umgebenden Outer-Quote erbt.
function _consumeForStack(s, stack, style, prevCharIn, prevNonWsIn) {
  let prevChar = prevCharIn;
  let prevNonWs = prevNonWsIn;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const isDouble = _isDoubleQuote(c);
    const isSingle = !isDouble && _isSingleQuote(c);
    if (isDouble || isSingle) {
      const next = i + 1 < s.length ? s[i + 1] : '';
      const wordAfter = (isSingle && _isEnglish(style)) ? _peekWordInString(s, i + 1) : '';
      const singleOpen = isSingle && stack.includes('s');
      const cls = isDouble
        ? _classifyDouble(c, prevChar, prevNonWs, next, style)
        : _classifySingle(c, prevChar, prevNonWs, next, style, wordAfter, singleOpen);
      if (cls.role === 'open') stack.push(isDouble ? 'd' : 's');
      else if (cls.role === 'close' && stack.length) stack.pop();
    }
    prevChar = c;
    if (!SPACES.has(c)) prevNonWs = c;
  }
  return { prevChar, prevNonWs };
}

function _peekWordInString(s, idx) {
  let w = '';
  for (let k = idx; k < s.length && w.length < 12; k++) {
    if (!WORD_CHAR.test(s[k])) return w;
    w += s[k];
  }
  return w;
}

export function normalizeQuotes(rootEl, style) {
  if (!rootEl || !style) return 0;
  let blocks = Array.from(rootEl.querySelectorAll(BLOCK_SEL));
  if (!blocks.length) blocks = [rootEl];
  // Alle matchenden Blocks werden eigenständig normalisiert. Innere Blocks
  // werden von ihrem Container via `_collectTextNodes(..., BLOCK_SEL)` bewusst
  // ausgeklammert — kein Doppel-Processing, kein State-Leak.
  let total = 0;
  for (const b of blocks) total += _normalizeBlock(b, style);
  return total;
}

// Selection-Scope-Variante: nur Zeichen innerhalb von `range` werden
// transformiert. Zeichen ausserhalb der Range werden nicht mutiert, dienen
// aber als prev/next-Kontext für Klassifikation an den Range-Grenzen.
export function normalizeQuotesInRange(range, style) {
  if (!range || range.collapsed || !style) return 0;
  const anchor = range.commonAncestorContainer;
  const common = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  if (!common) return 0;

  const all = [];
  _collectTextNodes(common, SKIP_SEL, all);
  if (!all.length) return 0;

  let count = 0;
  let prevChar = '';
  let prevNonWs = '';
  // Range-Scope: Stack tracked auch Out-of-Range-Quotes, damit eine selektierte
  // Inner-Quote die Depth aus dem umgebenden Outer-Quote erbt. Reset NUR an
  // Block-Grenzen (zwei aufeinanderfolgende Text-Nodes in verschiedenen
  // BLOCK_SEL-Ancestors) — sonst leakt der State zwischen Geschwister-Paragraphen.
  const quoteStack = [];
  let lastBlock = null;

  for (let nodeIdx = 0; nodeIdx < all.length; nodeIdx++) {
    const node = all[nodeIdx];
    if (_isBr(node)) {
      // Weiche Zeilengrenze: frischer Kontext, auch innerhalb eines Blocks.
      prevChar = '';
      prevNonWs = '';
      quoteStack.length = 0;
      lastBlock = _closestBlock(node, common);
      continue;
    }
    const s = node.nodeValue;
    if (!s) continue;

    const blk = _closestBlock(node, common);
    if (blk !== lastBlock) {
      prevChar = '';
      prevNonWs = '';
      quoteStack.length = 0;
      lastBlock = blk;
    }

    if (!range.intersectsNode(node)) {
      // Ausserhalb der Range: nichts ändern, aber Stack + prev-Kontext aus dem
      // gesamten Node aktualisieren.
      const r = _consumeForStack(s, quoteStack, style, prevChar, prevNonWs);
      prevChar = r.prevChar;
      prevNonWs = r.prevNonWs;
      continue;
    }

    const startOff = node === range.startContainer ? range.startOffset : 0;
    const endOff   = node === range.endContainer   ? range.endOffset   : s.length;
    if (startOff >= endOff) {
      if (s.length) {
        const r = _consumeForStack(s, quoteStack, style, prevChar, prevNonWs);
        prevChar = r.prevChar;
        prevNonWs = r.prevNonWs;
      }
      continue;
    }

    let out = '';
    if (startOff > 0) {
      out = s.slice(0, startOff);
      const r = _consumeForStack(out, quoteStack, style, prevChar, prevNonWs);
      prevChar = r.prevChar;
      prevNonWs = r.prevNonWs;
    }
    // close-Strip nur bis hierher (schützt den Out-of-Range-Head); `dropFollowing`
    // gilt nur in der Range — ein Space direkt hinter der Selection bleibt.
    const outRangeStart = out.length;
    let dropFollowing = false;
    let units = 0;
    for (let i = startOff; i < endOff; i++) {
      const c = s[i];
      if (dropFollowing) {
        if (SPACES.has(c)) continue;
        dropFollowing = false;
      }
      const isDouble = _isDoubleQuote(c);
      const isSingle = !isDouble && _isSingleQuote(c);
      if (!isDouble && !isSingle) {
        if (c === '.' && quoteStack.length > 0 && (i + 1) < endOff && s[i + 1] === '.') {
          let runLen = 2;
          while ((i + runLen) < endOff && s[i + runLen] === '.') runLen++;
          out += '…';
          i += runLen - 1;
          prevChar = '…';
          prevNonWs = '…';
          units++;
          continue;
        }
        out += c;
        prevChar = c;
        if (!SPACES.has(c)) prevNonWs = c;
        continue;
      }
      const next = i + 1 < s.length ? s[i + 1] : _peekNext(all, nodeIdx);
      const wordAfter = (isSingle && _isEnglish(style)) ? _peekWord(s, i + 1, all, nodeIdx) : '';
      const singleOpen = isSingle && quoteStack.includes('s');
      const cls = isDouble
        ? _classifyDouble(c, prevChar, prevNonWs, next, style)
        : _classifySingle(c, prevChar, prevNonWs, next, style, wordAfter, singleOpen);
      const repl = _depthRepl(cls.role, quoteStack.length, style, cls.repl, isDouble);
      const em = _emitQuote(out, cls.role, repl, outRangeStart);
      out = em.out;
      dropFollowing = em.dropFollowing;
      units++;
      prevChar = out[out.length - 1] || c;
      prevNonWs = em.core;
      if (cls.role === 'open') quoteStack.push(isDouble ? 'd' : 's');
      else if (cls.role === 'close' && quoteStack.length) quoteStack.pop();
    }
    if (endOff < s.length) {
      const tail = s.slice(endOff);
      out += tail;
      const r = _consumeForStack(tail, quoteStack, style, prevChar, prevNonWs);
      prevChar = r.prevChar;
      prevNonWs = r.prevNonWs;
    }
    if (out !== s) {
      node.nodeValue = out;
      count += Math.max(1, units);
    }
  }
  return count;
}

// String-Variante: normalisiert die Quotes in einem HTML-String off-DOM.
// Genutzt für KI-Vorschläge (Lektorat-Korrekturen, Seitenchat-Ersatz), bevor
// sie gespeichert werden — die KI liefert oft gerade `"`/`'`, die nicht zum
// Buch-Style passen. Round-Trip über ein detached `<div>`; `data-bid` bleibt
// erhalten (Browser-innerHTML bewahrt Attribute, ensureBlockIds ist idempotent).
export function normalizeQuotesInHtml(html, style) {
  if (!html || !style) return html;
  const div = document.createElement('div');
  div.innerHTML = html;
  normalizeQuotes(div, style);
  return div.innerHTML;
}

// Lädt Buch-Locale für die String-Variante. Eigene Funktion (kein Re-Use von
// runQuoteNormalize), weil hier ein String statt DOM/Range normalisiert wird.
export async function runQuoteNormalizeHtml({ bookId, html }) {
  if (!bookId || !html) return { ok: false, html };
  try {
    const r = await fetch(`/booksettings/${bookId}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const style = resolveQuoteStyle(data.language, data.region);
    return { ok: true, html: normalizeQuotesInHtml(html, style) };
  } catch (e) {
    console.error('[quote-normalize] booksettings fetch failed', e);
    return { ok: false, html };
  }
}

// Lädt Buch-Locale + ruft die passende Normalize-Variante auf. Gemeinsamer
// Aufrufer für Notebook-Slash, Bubble-Selection und Focus-Topbar.
export async function runQuoteNormalize({ bookId, rootEl, range = null }) {
  if (!bookId || !rootEl) return { ok: false, count: 0 };
  let style;
  try {
    const r = await fetch(`/booksettings/${bookId}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    style = resolveQuoteStyle(data.language, data.region);
  } catch (e) {
    console.error('[quote-normalize] booksettings fetch failed', e);
    return { ok: false, count: 0 };
  }
  const count = range
    ? normalizeQuotesInRange(range, style)
    : normalizeQuotes(rootEl, style);
  return { ok: true, count };
}

export const __test__ = { STYLES, _normalizeBlock, _classifyDouble, _classifySingle };
