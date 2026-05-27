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
import { runQuoteNormalize } from '../shared/quote-normalize.js';

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

// Link-URL normalisieren: leerer/whitespace-only String → ''. Bekannte Schemes
// (http/https/mailto/tel) durchreichen. Plain `foo@bar.tld` → mailto:. Sonst
// `https://` voranstellen.
function _normalizeLinkUrl(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'mailto:' + s;
  return 'https://' + s;
}

// Range zu <a href> machen. Bei nicht-collapsed Range: execCommand('createLink')
// (behält Inline-Formate, splittet Tags sauber). Bei Caret (collapsed): URL als
// Linktext einfügen. Caller hat Selection bereits auf range gesetzt + Editor
// fokussiert.
function _applyLinkAtRange(range, url) {
  if (range.collapsed) {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    range.insertNode(a);
    const after = document.createRange();
    after.setStartAfter(a);
    after.collapse(true);
    const sel = document.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(after); }
  } else {
    document.execCommand('createLink', false, url);
  }
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

// Liegt der collapsed Caret am Block-Anfang bzw. -Ende? Genutzt, um eine
// direkt angrenzende <hr> per Backspace/Delete zu löschen — das void-Element
// lässt sich nicht selektieren, deshalb gibt es sonst keinen Lösch-Pfad.
function caretAtBlockStart(range, block) {
  if (!range.collapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(range.startContainer, range.startOffset);
  return r.toString().length === 0;
}
function caretAtBlockEnd(range, block) {
  if (!range.collapsed) return false;
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setStart(range.startContainer, range.startOffset);
  return r.toString().length === 0;
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

  // ── Link-Bar ─────────────────────────────────────────────────────────
  // Cmd/Ctrl+Shift+K oder Bubble-Link-Button öffnet teleportierten Input
  // an Selektion/Caret. Range wird beim Öffnen geclont, weil das Fokussieren
  // des Inputs die Editor-Selection verliert.
  openLinkInput() {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    if (!editEl) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!editEl.contains(range.commonAncestorContainer) && editEl !== range.commonAncestorContainer) return;

    this._linkRange = range.cloneRange();

    let rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      const block = findBlock(range.startContainer, editEl) || editEl;
      rect = block.getBoundingClientRect();
    }
    this.linkX = rect.left + rect.width / 2;
    this.linkY = rect.top;

    const selText = sel.toString().trim();
    this.linkUrl = /^(https?:|mailto:)/i.test(selText) ? selText : '';
    this.bubbleShow = false;
    this.linkShow = true;
    this.$nextTick(() => {
      const inp = this.$refs?.linkInput;
      if (inp) { inp.focus(); inp.select(); }
    });
  },

  _commitLink() {
    const editEl = getEditEl();
    const range = this._linkRange;
    const raw = (this.linkUrl || '').trim();
    if (!editEl || !range || !raw) { this._closeLink(); return; }
    const url = _normalizeLinkUrl(raw);
    if (!url) { this._closeLink(); return; }

    editEl.focus();
    const sel = document.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    _applyLinkAtRange(range, url);
    window.__app?._markEditDirty?.();
    this._closeLink();
  },

  _closeLink() {
    this.linkShow = false;
    this.linkUrl = '';
    this._linkRange = null;
    getEditEl()?.focus();
  },

  _onLinkKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); this._commitLink(); return; }
    if (e.key === 'Escape') { e.preventDefault(); this._closeLink(); return; }
  },

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

    // Ctrl/Cmd+Shift+K: Link-Input öffnen (Cmd+K alleine belegt mit Palette).
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      if (app.focusActive) return;
      e.preventDefault();
      this.openLinkInput();
      return;
    }

    // Undo/Redo — nur im Notebook (Focus übernimmt unten den early-return).
    // Cmd/Ctrl+Z → Undo, Cmd/Ctrl+Shift+Z + Ctrl+Y → Redo. Browser-Default
    // bewusst überschrieben — eigener Stack ist nach Slash/HR-Mutationen
    // konsistent, der Browser-Stack ist es nicht.
    if (!app.focusActive && (e.metaKey || e.ctrlKey) && !e.altKey) {
      if (!e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        app.notebookUndo?.();
        return;
      }
      if (e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        app.notebookRedo?.();
        return;
      }
      if (!e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        app.notebookRedo?.();
        return;
      }
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

    // Trennlinie (<hr>) löschen: das void-Element ist nicht selektierbar, also
    // gibt es sonst keinen Lösch-Pfad. Backspace am Block-Anfang entfernt eine
    // direkt davor liegende <hr>, Delete am Block-Ende eine direkt dahinter.
    // Caret bleibt im aktuellen Block.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const editEl = getEditEl();
      const sel = editEl ? document.getSelection() : null;
      if (editEl && sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (range.collapsed && editEl.contains(range.startContainer)) {
          const block = findBlock(range.startContainer, editEl);
          if (block) {
            const neighbour = e.key === 'Backspace'
              ? (caretAtBlockStart(range, block) ? block.previousElementSibling : null)
              : (caretAtBlockEnd(range, block) ? block.nextElementSibling : null);
            if (neighbour && neighbour.tagName === 'HR') {
              e.preventDefault();
              neighbour.remove();
              app._markEditDirty?.();
              return;
            }
          }
        }
      }
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
    const { ok, count } = await runQuoteNormalize({ bookId, rootEl: editEl });
    if (!ok) return;
    if (count > 0) {
      app._markEditDirty?.();
      editEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (block && block.isConnected) placeCaretIn(block);
    else editEl.focus();
  },
};
