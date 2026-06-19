// Chat-Markdown → HTML + Mention/Channel-Dekoration. `renderChatMarkdown`
// escaped als Allererstes (XSS-Invariante, siehe CLAUDE.md).
import { escHtml } from './escape.js';

/**
 * Display-Pass: Markiert Slack-Style `@mentions` (User-Handles) und `#channels`
 * im View-Modus als Chips. Pure HTML-String-Transform, nicht persistent —
 * läuft auf `renderedPageHtml`, niemals auf `originalHtml`. Überspringt Text
 * in `<a>`, `<pre>`, `<code>` und bereits dekorierten Spans (idempotent).
 *
 * `@name`: 2+ Wortzeichen, beginnt mit Buchstabe.
 * `#tag`:  2+ Wortzeichen, beginnt mit Buchstabe oder Ziffer; Bindestrich erlaubt
 *           (matcht `#1-vbs`, `#dot-sync`).
 * Boundary: vorheriges Zeichen darf kein Wortzeichen oder `/` sein.
 */
const _MENTION_SKIP_ANCESTOR = new Set(['A', 'PRE', 'CODE']);
const _CHIP_RE = /(^|[^\w/&])([@#])([A-Za-z0-9][\w-]{1,})/g;

export function decorateMentions(html) {
  if (!html || (!html.includes('@') && !html.includes('#'))) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  let n = walker.nextNode();
  while (n) {
    if (!_mentionAncestorSkip(n) && /[@#]/.test(n.textContent)) texts.push(n);
    n = walker.nextNode();
  }
  for (const textNode of texts) {
    const text = textNode.textContent;
    const matches = [...text.matchAll(_CHIP_RE)];
    if (matches.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      const pre = m[1];
      const sigil = m[2];
      const word = m[3];
      const start = m.index + pre.length;
      const end = start + 1 + word.length;
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const span = doc.createElement('span');
      span.className = sigil === '@' ? 'mention' : 'channel';
      span.textContent = sigil + word;
      frag.appendChild(span);
      last = end;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
  return root.innerHTML;
}

function _mentionAncestorSkip(node) {
  let p = node.parentNode;
  while (p && p.nodeType === 1) {
    if (_MENTION_SKIP_ANCESTOR.has(p.tagName)) return true;
    const cls = p.getAttribute && p.getAttribute('class');
    if (cls && /\b(mention|channel)\b/.test(cls)) return true;
    p = p.parentNode;
  }
  return false;
}

// Erkennt eine Listenzeile (geordnet «1. » oder ungeordnet «- »/«* ») inkl.
// führender Einrückung (Spaces/Tabs). Gruppe 1 = Indent, 2 = Marker, 3 = Text.
const _CHAT_LIST_RE = /^([ \t]*)([-*]|\d+\.)[ ]+(.*)$/;

// Baut aus aufeinanderfolgenden Listenzeilen verschachtelte <ul>/<ol> anhand
// der Einrückungstiefe. Tabs zählen als 4 Spaces. Pure Funktion (kein DOM).
function _buildNestedList(blockLines) {
  const items = [];
  for (const l of blockLines) {
    const m = l.match(_CHAT_LIST_RE);
    if (!m) continue;
    items.push({
      indent: m[1].replace(/\t/g, '    ').length,
      ordered: /\d/.test(m[2]),
      text: m[3],
    });
  }
  const open = (ord) => ord ? '<ol class="chat-list chat-list--ol">' : '<ul class="chat-list">';
  const close = (ord) => ord ? '</ol>' : '</ul>';
  const stack = [];
  let out = '';
  for (const it of items) {
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      stack.push(it);
      out += open(it.ordered) + '<li>' + it.text;
    } else if (it.indent === top.indent) {
      out += '</li><li>' + it.text;
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
        out += '</li>' + close(stack.pop().ordered);
      }
      out += '</li><li>' + it.text;
    }
  }
  while (stack.length) out += '</li>' + close(stack.pop().ordered);
  return out;
}

// Ersetzt zusammenhängende Listenblöcke im Text durch ihr verschachteltes
// HTML; alle übrigen Zeilen bleiben unangetastet. Eine einzelne Leerzeile
// zwischen Items hält die Liste zusammen.
function _renderChatLists(html) {
  const lines = html.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!_CHAT_LIST_RE.test(lines[i])) { out.push(lines[i]); i++; continue; }
    const block = [];
    while (i < lines.length) {
      if (_CHAT_LIST_RE.test(lines[i])) { block.push(lines[i]); i++; continue; }
      if (lines[i].trim() === '' && _CHAT_LIST_RE.test(lines[i + 1] || '')) { i++; continue; }
      break;
    }
    out.push(_buildNestedList(block));
  }
  return out.join('\n');
}

/**
 * Einfaches Markdown → HTML für Chat-Antworten.
 * Unterstützt: # Überschriften, **fett**, *kursiv*, `code`, ```Code-Blöcke```,
 * [Links](url), Blockquotes (>), Tabellen, Zeilenumbrüche, verschachtelte Listen (- und 1.).
 */
export function renderChatMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);

  // Fenced Code-Blöcke ```…``` vorab extrahieren und durch Platzhalter ersetzen,
  // damit weder Listen-/Inline-Regex noch \n→<br> ihren Inhalt anfassen. Inhalt
  // ist durch escHtml bereits sicher; \n bleiben für die <pre>-Anzeige erhalten.
  // Platzhalter-Delimiter ist U+E000 (Private-Use-Area): kommt in echtem
  // Chat-/Markdown-Text nicht vor (kollisionsfrei) und ist — anders als das
  // früher genutzte NUL — druckbares UTF-8, sodass die Datei text-/grep-bar
  // bleibt. Restore weiter unten muss denselben Delimiter matchen.
  const codeBlocks = [];
  html = html.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body) => {
    codeBlocks.push('<pre class="chat-pre"><code>' + body.replace(/\n+$/, '') + '</code></pre>');
    return 'CB' + (codeBlocks.length - 1) + '';
  });

  // Überschriften: ### ## #
  html = html.replace(/^### (.+)$/gm, '<h4 class="chat-heading chat-heading--3">$1</h4>');
  html = html.replace(/^## (.+)$/gm,  '<h3 class="chat-heading chat-heading--2">$1</h3>');
  html = html.replace(/^# (.+)$/gm,   '<h2 class="chat-heading chat-heading--1">$1</h2>');

  // Horizontale Linie
  html = html.replace(/^---$/gm, '<hr class="chat-hr">');

  // Markdown-Tabellen: Block aus Zeilen die mit | beginnen
  html = html.replace(/((?:\|[^\n]+\n)+)/g, (block) => {
    const lines = block.trimEnd().split('\n');
    if (lines.length < 3) return block;
    if (!/^\|[\s\-:|]+\|$/.test(lines[1])) return block;
    const headers = lines[0].split('|').slice(1, -1).map(h => h.trim());
    const rows = lines.slice(2).map(row => row.split('|').slice(1, -1).map(c => c.trim()));
    const thead = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
    const tbody = rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="table-scroll"><table class="chat-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
  });

  // Listen (geordnet + ungeordnet, mit Verschachtelung via Einrückung)
  html = _renderChatLists(html);

  // Blockquote: Zeilen mit «> » (nach escHtml «&gt; ») → temporäres <bq>-Tag,
  // aufeinanderfolgende Zeilen werden zu einem <blockquote> gruppiert.
  html = html.replace(/^&gt; ?(.*)$/gm, '<bq>$1</bq>');
  html = html.replace(/(?:<bq>[\s\S]*?<\/bq>\n?)+/g, m =>
    '<blockquote class="chat-quote">' +
    m.replace(/<bq>/g, '').replace(/<\/bq>\n?/g, '\n').trimEnd() +
    '</blockquote>');

  // Inline: [Text](url) — nur http(s)/mailto, sonst Klartext belassen (XSS-Schutz).
  // url ist durch escHtml bereits attribut-sicher (" → &quot; etc.).
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    /^(https?:|mailto:)/i.test(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${label}</a>`
      : m);

  // Inline: **fett**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline: *kursiv*
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline: `code`
  html = html.replace(/`([^`]+)`/g, '<code class="chat-code">$1</code>');

  // Leerzeile → <br><br> (direkt, ohne weitere \n die nochmals zu <br> werden)
  html = html.replace(/\n\n+/g, '<br><br>');
  // Einfacher Zeilenumbruch → <br>
  html = html.replace(/\n/g, '<br>');

  // Fenced Code-Blöcke zurückspielen (Inhalt war über Platzhalter geschützt)
  html = html.replace(/CB(\d+)/g, (_m, i) => codeBlocks[Number(i)] || '');

  // Überschüssige <br> direkt vor/nach Block-Elementen entfernen
  html = html.replace(/(<br>\s*)+(<(?:ol|ul|h[2-4]|hr|blockquote|pre)\b)/gi, '$2');
  html = html.replace(/(\/(?:ol|ul|h[2-4]|blockquote|pre)>|<hr[^>]*>)(\s*<br>)+/gi, '$1');

  return html;
}
