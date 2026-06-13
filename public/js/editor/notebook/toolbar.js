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

// Blocktyp-Definitionen für Slash-Transform. `tag` ist das Zielelement;
// `className` optional (aktuell für .poem + .todo). `list: true` wrappt den
// Inhalt in ein <li>. `todoList: true` erzeugt eine Checkbox-Liste.
// `insertText: 'date'|'time'|'datetime'` ersetzt den Block durch einen
// formatierten Datums-/Zeit-Stempel.
const SLASH_ITEMS = [
  { key: 'paragraph',  tag: 'p',          group: 'block' },
  { key: 'h2',         tag: 'h2',         group: 'block' },
  { key: 'h3',         tag: 'h3',         group: 'block' },
  { key: 'blockquote', tag: 'blockquote', wrapP: true,                   group: 'block' },
  { key: 'poem',       tag: 'div', className: 'poem', wrapP: true,       group: 'block' },
  { key: 'list',       tag: 'ul', list: true,                           group: 'block' },
  { key: 'todo',       tag: 'ul', className: 'todo', todoList: true,     group: 'block' },
  { key: 'hr',         tag: 'hr',                          group: 'break' },
  { key: 'pagebreak',  tag: 'hr', className: 'pagebreak',  group: 'break' },
  { key: 'blankpage',  tag: 'hr', className: 'blankpage',  group: 'break' },
  { key: 'heute',      insertText: 'date',     group: 'insert' },
  { key: 'jetzt',      insertText: 'datetime', group: 'insert' },
  { key: 'zeit',       insertText: 'time',     group: 'insert' },
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

// Liefert das <p> innerhalb eines <div class="poem">, falls die Caret-Position
// in einem Gedicht liegt. Sonst null.
function findPoemP(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.tagName === 'P'
        && cur.parentNode?.tagName === 'DIV'
        && cur.parentNode.classList?.contains('poem')) {
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
  // Labels werden einmalig beim Öffnen aufgelöst (`_slashLabels`, gesetzt in
  // `_openSlashAt`) statt bei jedem Keystroke 14× `t()` aufzurufen.
  // `_buildSlashLabels` ist der Fallback, falls `slashItems` vor dem Öffnen
  // läuft (defensiv) – kein Getter im Data-Spread, sonst würde `this.t` zu
  // früh auf `toolbarCardMethods` selbst aufgerufen.
  _buildSlashLabels() {
    const app = window.__app;
    // Alles, was sich pro Eintrag nicht mit der Query ändert, wird hier einmal
    // beim Öffnen aufgelöst (Label, Gruppen-Label, Modifier-Klasse, Stempel).
    // Das Template liest dann nur noch Properties – keine `t()`-/Funktions-
    // Aufrufe pro Eintrag und Render, die beim Tippen reaktiv neu liefen.
    return SLASH_ITEMS.map(it => ({
      key: it.key,
      group: it.group,
      groupLabel: app?.t('editor.slash.group.' + it.group) || it.group,
      label: app?.t('editor.slash.' + it.key) || it.key,
      modClass: 'edit-slash-item--' + it.key,
      // Datums-/Zeit-Items zeigen den tatsächlich einzufügenden Wert als
      // Sekundär-Text (beim Öffnen aufgelöst; `_applySlashItem` rechnet beim
      // Einfügen ohnehin frisch).
      preview: it.insertText ? _formatStamp(it.insertText) : '',
    }));
  },
  // Filter: Substring-Match (case-insensitive) auf Label + Key, damit sowohl
  // DE-Labels („Über") als auch interne Keys („h2") tippbar sind. Ergebnis
  // wird pro Query gecacht – Template ruft `slashItems()` zweimal pro Render
  // (x-for + Leer-Check), der zweite Aufruf trifft den Cache statt neu zu
  // filtern.
  slashItems() {
    const q = (this.slashQuery || '').trim().toLowerCase();
    if (this._slashFilterCache && this._slashFilterCache.q === q) {
      return this._slashFilterCache.r;
    }
    const items = this._slashLabels || this._buildSlashLabels();
    const filtered = !q ? items : items.filter(it =>
      it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q));
    // `showGroup`: erstes Item seiner Gruppe in der gefilterten Liste → der
    // Gruppen-Header wird gerendert. Einmal pro Query berechnet, damit das
    // Template beim Tippen nicht pro Eintrag erneut `slashItems()` aufruft.
    let prevGroup = null;
    const r = filtered.map(it => {
      const showGroup = it.group !== prevGroup;
      prevGroup = it.group;
      return { ...it, showGroup };
    });
    this._slashFilterCache = { q, r };
    return r;
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

    // Doppel-Enter in einem Gedicht (<div class="poem"><p>…</p></div>): trifft
    // Enter ein leeres <p>, raus aus dem Gedicht in ein <p> dahinter. Der erste
    // Enter auf einer Textzeile erzeugt per Browser-Default die leere Zeile, der
    // zweite trifft sie und verlässt den Block. Spiegelt das Verhalten der
    // Checkbox-Liste (leeres todo-li → raus).
    if (e.key === 'Enter' && !e.shiftKey) {
      const editEl = getEditEl();
      const sel = editEl ? document.getSelection() : null;
      if (sel && sel.rangeCount > 0) {
        const p = findPoemP(sel.getRangeAt(0).startContainer, editEl);
        if (p && !(p.textContent || '').trim()) {
          e.preventDefault();
          const poem = p.parentNode;
          const out = document.createElement('p');
          out.appendChild(document.createElement('br'));
          poem.parentNode.insertBefore(out, poem.nextSibling);
          p.remove();
          if (!poem.querySelector('p')) poem.remove();
          placeCaretIn(out);
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
      // Per Klick markierte <hr> direkt entfernen (siehe editor-toolbar-card.js).
      const selectedHr = editEl?.querySelector('hr.hr-selected');
      if (selectedHr) {
        e.preventDefault();
        selectedHr.remove();
        app._markEditDirty?.();
        return;
      }
      const sel = editEl ? document.getSelection() : null;
      if (editEl && sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (range.collapsed && editEl.contains(range.startContainer)) {
          const block = findBlock(range.startContainer, editEl);
          if (block) {
            // Eine <hr> ist Direktkind von editEl; der Caret-Block kann tiefer
            // liegen (z.B. <li> in einer Liste). Nachbar daher auf der Ebene
            // des umschliessenden Top-Level-Childs suchen, nicht am Block selbst.
            let top = block;
            while (top.parentNode && top.parentNode !== editEl) top = top.parentNode;
            const neighbour = e.key === 'Backspace'
              ? (caretAtBlockStart(range, block) ? top.previousElementSibling : null)
              : (caretAtBlockEnd(range, block) ? top.nextElementSibling : null);
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
    // Labels einmalig in der aktuellen Sprache auflösen; Filter-Cache leeren.
    this._slashLabels = this._buildSlashLabels();
    this._slashFilterCache = null;
    const rect = block.getBoundingClientRect();
    this.slashX = rect.left;
    this.slashY = Math.max(4, window.innerHeight - rect.top + 4);
    this.slashShow = true;
  },

  _closeSlash() {
    this.slashShow = false;
    this.slashQuery = '';
    this._slashBlock = null;
    this._slashLabels = null;
    this._slashFilterCache = null;
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
      if (item.className) replacement.className = item.className;
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
};
