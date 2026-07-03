// editorToolbarCard: Bubble-Toolbar (Inline-Formate auf Selektion) + Link-Bar.
// `this` = Sub-Komponente (editorToolbarCard), Root-Zugriffe via window.__app.
// Im Fokus-Modus deaktiviert (Guards + `!$app.focusActive` im Template).

import { getEditEl, WORD_RE, _normalizeLinkUrl, _applyLinkAtRange, findBlock } from './_shared.js';

export const bubbleMethods = {
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
};
