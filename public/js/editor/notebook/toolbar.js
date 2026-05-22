// Edit-Modus-Toolbar: Bubble (Inline-Formate auf Selektion) + Slash-Menü
// (Block-Transforms). Beides als teleportierte Templates in
// editor-toolbar.html; die Methoden hier werden in
// Alpine.data('editorToolbarCard') gespreadet (this = Sub-Komponente,
// Root-Zugriffe via window.__app).
//
// Tabu im Fokus-Modus: alle Aktionen und Trigger-Handler sind über
// `!$app.focusActive` gegated – die Partial-Instanz lebt weiter, reagiert
// aber nicht mehr.

import { getEditEl, placeCaretIn, WORD_RE } from '../utils.js';
import { tzOpts, localeTag } from '../../utils.js';
import { normalizeQuotes, resolveQuoteStyle } from './quote-normalize.js';

// Blocktyp-Definitionen für Slash-Transform. `tag` ist das Zielelement;
// `className` optional (aktuell für .poem + .todo). `list: true` wrappt den
// Inhalt in ein <li>. `todoList: true` erzeugt eine Checkbox-Liste.
// `insertText: 'date'|'time'|'datetime'` ersetzt den Block durch einen
// formatierten Datums-/Zeit-Stempel. `action: '<id>'` triggert eine
// page-scoped Aktion ohne Block-Transform.
const SLASH_ITEMS = [
  { key: 'paragraph',  tag: 'p' },
  { key: 'h2',         tag: 'h2' },
  { key: 'h3',         tag: 'h3' },
  { key: 'blockquote', tag: 'blockquote', wrapP: true },
  { key: 'poem',       tag: 'div', className: 'poem', wrapP: true },
  { key: 'list',       tag: 'ul', list: true },
  { key: 'todo',       tag: 'ul', className: 'todo', todoList: true },
  { key: 'hr',         tag: 'hr' },
  { key: 'heute',      insertText: 'date' },
  { key: 'jetzt',      insertText: 'datetime' },
  { key: 'zeit',       insertText: 'time' },
  { key: 'quotes',     action: 'normalize-quotes' },
];

// Datums-/Zeit-Stempel im uiLocale + appTimezone. Kein Locale-Param —
// liest live aus dem Root.
function _formatStamp(kind) {
  const app = window.__app;
  const tag = localeTag(app?.uiLocale);
  const d = new Date();
  if (kind === 'date') {
    return d.toLocaleDateString(tag, tzOpts({ day: '2-digit', month: '2-digit', year: 'numeric' }));
  }
  if (kind === 'time') {
    return d.toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
  }
  // 'datetime'
  const date = d.toLocaleDateString(tag, tzOpts({ day: '2-digit', month: '2-digit', year: 'numeric' }));
  const time = d.toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
  return `${date} ${time}`;
}

const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, li, div.poem';

function findBlock(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.matches?.(BLOCK_SEL)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

// Liefert das umschliessende <li class="todo-item">, falls die Caret-Position
// in einer Checkbox-Liste liegt. Sonst null.
function findTodoLi(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.tagName === 'LI'
        && cur.parentNode?.tagName === 'UL'
        && cur.parentNode.classList?.contains('todo')) {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

export const toolbarCardMethods = {
  _updateSlashPosition() {
    if (!this.slashShow || !this._slashBlock || !this._slashBlock.isConnected) return;
    const rect = this._slashBlock.getBoundingClientRect();
    // Block komplett ausserhalb des Viewports → schliessen.
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      this._closeSlash();
      return;
    }
    // Menü oberhalb des Blocks (näher am Caret in langen Texten, springt nicht
    // unter Fold). Position als Distanz vom Viewport-Boden, damit das Menü
    // mit seiner Unterkante am Block-Top „klebt" und nach oben wächst —
    // unabhängig von eigener Höhe.
    this.slashX = rect.left;
    this.slashY = Math.max(4, window.innerHeight - rect.top + 4);
  },

  _updateBubble() {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) { this.bubbleShow = false; return; }
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.bubbleShow = false;
      return;
    }
    const editEl = getEditEl();
    if (!editEl) { this.bubbleShow = false; return; }
    const range = sel.getRangeAt(0);
    if (!editEl.contains(range.commonAncestorContainer)
        && editEl !== range.commonAncestorContainer) {
      this.bubbleShow = false;
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.bubbleShow = false;
      return;
    }
    this.bubbleX = rect.left + rect.width / 2;
    this.bubbleY = rect.top;
    this.bubbleShow = true;
    const text = sel.toString().trim();
    this.bubbleSingleWord = !!text && WORD_RE.test(text);
  },

  _applyInline(command) {
    const editEl = getEditEl();
    if (!editEl) return;
    editEl.focus();
    document.execCommand(command, false);
    window.__app?._markEditDirty?.();
    this.$nextTick(() => this._updateBubble());
  },

  toolbarBold()   { this._applyInline('bold'); },
  toolbarItalic() { this._applyInline('italic'); },

  // ── Slash-Menü ────────────────────────────────────────────────────────
  // Reaktive Labels: jedes Mal frisch aus i18n (günstig). Kein Getter –
  // der Spread in der Alpine-data-Fabrik würde sonst sofort `this.t`
  // aufrufen (auf toolbarCardMethods selbst), bevor die Komponente steht, und
  // die gesamte Initialisierung scheitern lassen.
  // Filter: Substring-Match (case-insensitive) auf Label + Key, damit
  // sowohl DE-Labels („Über") als auch interne Keys („h2") tippbar sind.
  slashItems() {
    const app = window.__app;
    const q = (this.slashQuery || '').trim().toLowerCase();
    const items = SLASH_ITEMS.map(it => ({
      key: it.key,
      label: app?.t('editor.slash.' + it.key) || it.key,
    }));
    if (!q) return items;
    return items.filter(it =>
      it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q));
  },

  _onEditKeydown(e) {
    const app = window.__app;
    if (!app?.editMode) return;

    // Shift+Enter = weicher Zeilenumbruch (<br>). In Safari/WebKit splittet
    // die Default-Aktion stattdessen den Absatz in zwei <p> – was in Gedichten
    // und Dialogen der falsche Umbruch ist. execCommand('insertLineBreak')
    // setzt das <br> cross-browser konsistent (WebKit + Chromium getestet).
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      app._markEditDirty?.();
      return;
    }

    // Enter in einer Checkbox-Liste: neues <li class="todo-item"> mit eigener
    // Checkbox einfügen. Leere todo-li → aus der Liste raus in <p>.
    if (e.key === 'Enter' && !e.shiftKey) {
      const editEl = getEditEl();
      const sel = editEl ? document.getSelection() : null;
      if (sel && sel.rangeCount > 0) {
        const li = findTodoLi(sel.getRangeAt(0).startContainer, editEl);
        if (li) {
          e.preventDefault();
          const text = (li.querySelector('.todo-text')?.textContent || '').trim();
          if (!text) {
            // Leere todo-li → in <p> hinter der Liste konvertieren, alte li raus.
            const ul = li.parentNode;
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            ul.parentNode.insertBefore(p, ul.nextSibling);
            li.remove();
            if (!ul.querySelector('li')) ul.remove();
            placeCaretIn(p);
          } else {
            const newLi = document.createElement('li');
            newLi.className = 'todo-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            const span = document.createElement('span');
            span.className = 'todo-text';
            span.appendChild(document.createElement('br'));
            newLi.appendChild(cb);
            newLi.appendChild(span);
            li.parentNode.insertBefore(newLi, li.nextSibling);
            placeCaretIn(span);
          }
          app._markEditDirty?.();
          return;
        }
      }
    }

    // Cmd/Ctrl+; → Datum, Cmd/Ctrl+Shift+; → Datum+Zeit. Bewährter Office-
    // Shortcut, im Browser noch frei.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === ';' || e.code === 'Semicolon')) {
      e.preventDefault();
      const stamp = _formatStamp(e.shiftKey ? 'datetime' : 'date');
      document.execCommand('insertText', false, stamp);
      app._markEditDirty?.();
      return;
    }

    // Ctrl/Cmd+B und Ctrl/Cmd+I: Bold/Italic auch im Fokus-Modus, in dem die
    // Bubble-Toolbar ausgeblendet ist. Explizit statt Browser-Default, damit
    // _markEditDirty + Bubble-Reposition konsistent laufen.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        this._applyInline('bold');
        return;
      }
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        this._applyInline('italic');
        return;
      }
    }

    // Ctrl/Cmd+Shift+H: Trennlinie (<hr>) am Caret einfügen.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      app.insertHorizontalRule?.();
      return;
    }

    // Im Focus-Mode hört die Toolbar auf — Slash-Menü und sonstige
    // Block-Transforms sind nicht erlaubt. B/I/U laufen weiter via Browser-
    // Default (Cmd/Ctrl+B/I/U).
    if (app.focusActive) return;

    // Slash-Menü-Navigation, wenn geöffnet
    if (this.slashShow) {
      if (e.key === 'Escape')    { e.preventDefault(); this._closeSlash(); return; }
      const filtered = this.slashItems();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filtered.length) this.slashIdx = (this.slashIdx + 1) % filtered.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filtered.length) this.slashIdx = (this.slashIdx - 1 + filtered.length) % filtered.length;
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const pick = filtered[this.slashIdx];
        if (pick) this._applySlashByKey(pick.key);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (!this.slashQuery) { this._closeSlash(); return; }
        this.slashQuery = this.slashQuery.slice(0, -1);
        this.slashIdx = 0;
        return;
      }
      // Druckbare Zeichen filtern die Liste, statt das Menü zu schliessen.
      // Modifier-Combos (Ctrl/Meta/Alt + Buchstabe) durchlassen.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.slashQuery += e.key;
        this.slashIdx = 0;
        return;
      }
      return;
    }

    // Slash-Trigger: nur in einem leeren Block
    if (e.key === '/') {
      const editEl = getEditEl();
      if (!editEl) return;
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!editEl.contains(range.startContainer)) return;
      const block = findBlock(range.startContainer, editEl);
      if (!block) return;
      if ((block.textContent || '').trim() !== '') return;
      e.preventDefault();
      this._openSlashAt(block);
    }
  },

  _openSlashAt(block) {
    this._slashBlock = block;
    this.slashIdx = 0;
    this.slashQuery = '';
    const rect = block.getBoundingClientRect();
    this.slashX = rect.left;
    this.slashY = Math.max(4, window.innerHeight - rect.top + 4);
    this.slashShow = true;
  },

  _closeSlash() {
    this.slashShow = false;
    this.slashQuery = '';
    this._slashBlock = null;
    getEditEl()?.focus();
  },

  _applySlashByKey(key) {
    const item = SLASH_ITEMS.find(i => i.key === key);
    if (item) this._applySlashItem(item);
  },

  _applySlashItem(item) {
    const editEl = getEditEl();
    const block = this._slashBlock;
    if (!editEl || !block || !block.parentNode) { this._closeSlash(); return; }

    // Page-scoped Aktion ohne Block-Transform (z.B. Anführungszeichen
    // normalisieren). Block bleibt leer, Caret kehrt nach der Aktion dorthin
    // zurück.
    if (item.action === 'normalize-quotes') {
      this._closeSlash();
      this._runNormalizeQuotes(editEl, block);
      return;
    }

    // Datums-/Zeit-Stempel: ersetzt den (per Trigger leeren) Block durch
    // einen <p> mit dem formatierten Stempel-String. Caret hinter den Text,
    // damit der User direkt weiterschreiben kann.
    if (item.insertText) {
      const stamp = _formatStamp(item.insertText);
      const p = document.createElement('p');
      p.textContent = stamp;
      block.parentNode.replaceChild(p, block);
      const sel = document.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      window.__app?._markEditDirty?.();
      this._closeSlash();
      return;
    }

    let replacement;
    let caretTarget;

    if (item.tag === 'hr') {
      replacement = document.createElement('hr');
      block.parentNode.replaceChild(replacement, block);
      const next = document.createElement('p');
      next.appendChild(document.createElement('br'));
      replacement.insertAdjacentElement('afterend', next);
      caretTarget = next;
    } else if (item.todoList) {
      // Checkbox-Liste: <ul class="todo"><li class="todo-item">
      //   <input type=checkbox><span class="todo-text"><br></span></li></ul>
      replacement = document.createElement('ul');
      replacement.className = 'todo';
      const li = document.createElement('li');
      li.className = 'todo-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const span = document.createElement('span');
      span.className = 'todo-text';
      span.appendChild(document.createElement('br'));
      li.appendChild(cb);
      li.appendChild(span);
      replacement.appendChild(li);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = span;
    } else if (item.list) {
      replacement = document.createElement(item.tag);
      const li = document.createElement('li');
      li.appendChild(document.createElement('br'));
      replacement.appendChild(li);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = li;
    } else if (item.wrapP) {
      // blockquote / .poem → enthält ein <p> als Schreibfläche.
      replacement = document.createElement(item.tag);
      if (item.className) replacement.className = item.className;
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      replacement.appendChild(p);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = p;
    } else {
      // Einfacher Tag-Swap (p, h2, h3).
      replacement = document.createElement(item.tag);
      replacement.innerHTML = '<br>';
      block.parentNode.replaceChild(replacement, block);
      caretTarget = replacement;
    }

    placeCaretIn(caretTarget);
    window.__app?._markEditDirty?.();
    this._closeSlash();
  },

  async _runNormalizeQuotes(editEl, block) {
    const app = window.__app;
    const bookId = app?.selectedBookId;
    if (!bookId) return;
    let style;
    try {
      const r = await fetch(`/booksettings/${bookId}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      style = resolveQuoteStyle(data.language, data.region);
    } catch (e) {
      console.error('[quote-normalize] booksettings fetch failed', e);
      return;
    }
    const count = normalizeQuotes(editEl, style);
    if (count > 0) {
      app._markEditDirty?.();
      editEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (block && block.isConnected) placeCaretIn(block);
    else editEl.focus();
  },
};
