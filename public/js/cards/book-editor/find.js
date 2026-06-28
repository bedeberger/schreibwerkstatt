// Teil von bookEditorCard (Facade cards/book-editor-card.js): Find/Replace
// über den ganzen Manuskript-Stream via CSS Custom Highlights. Methoden in
// den Card-Scope gespreadet (gemeinsames `this`).

const HIGHLIGHT_ALL = 'book-editor-find-match';
const HIGHLIGHT_CURRENT = 'book-editor-find-current';
let _hlAll = null, _hlCurrent = null;
function ensureHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return false;
  if (!_hlAll) { _hlAll = new Highlight(); CSS.highlights.set(HIGHLIGHT_ALL, _hlAll); }
  if (!_hlCurrent) { _hlCurrent = new Highlight(); CSS.highlights.set(HIGHLIGHT_CURRENT, _hlCurrent); }
  return true;
}
export function clearHighlights() {
  if (_hlAll) _hlAll.clear();
  if (_hlCurrent) _hlCurrent.clear();
}

function isWordCharBE(ch) {
  if (!ch) return false;
  return /[\p{L}\p{N}_]/u.test(ch);
}

export const bookEditorFindMethods = {
    // ── Find / Replace ────────────────────────────────────────────────────
    openFind() {
      this.findOpen = true;
      this.$nextTick(() => {
        const inp = document.querySelector('.book-editor-find-input');
        if (inp) { inp.focus(); inp.select(); }
        this.recomputeFindMatches();
      });
    },

    closeFind() {
      this.findOpen = false;
      this.findMatches = [];
      this.findIndex = -1;
      clearHighlights();
      if (this._findRecomputeTimer) { clearTimeout(this._findRecomputeTimer); this._findRecomputeTimer = null; }
    },

    onFindInput() {
      if (this._findRecomputeTimer) clearTimeout(this._findRecomputeTimer);
      this._findRecomputeTimer = setTimeout(() => {
        this._findRecomputeTimer = null;
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) this._selectMatch(0);
      }, 120);
    },

    _allBlockEls() {
      return Array.from(document.querySelectorAll('[data-book-editor-page]'));
    },

    recomputeFindMatches() {
      if (!this.findTerm) {
        this.findMatches = [];
        this.findIndex = -1;
        this._refreshFindHighlights();
        return;
      }
      const els = this._allBlockEls();
      const matches = [];
      for (const el of els) {
        const pageId = parseInt(el.dataset.bookEditorPage, 10);
        const found = this._matchesIn(el, this.findTerm, this.findCaseSensitive, this.findWholeWord);
        for (const m of found) matches.push({ ...m, pageId, container: el });
      }
      this.findMatches = matches;
      this.findIndex = matches.length > 0 ? 0 : -1;
      this._refreshFindHighlights();
    },

    _matchesIn(root, term, caseSensitive, wholeWord) {
      const nodes = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) nodes.push(n);
      const full = nodes.map(x => x.nodeValue).join('');
      const hay = caseSensitive ? full : full.toLowerCase();
      const needle = caseSensitive ? term : term.toLowerCase();
      const isWord = (ch) => isWordCharBE(ch) || ch === '_';
      const starts = new Array(nodes.length);
      let acc = 0;
      for (let i = 0; i < nodes.length; i++) {
        starts[i] = acc;
        acc += nodes[i].nodeValue.length;
      }
      const out = [];
      let from = 0;
      while (from <= hay.length - needle.length) {
        const idx = hay.indexOf(needle, from);
        if (idx === -1) break;
        if (wholeWord) {
          const before = idx > 0 ? hay[idx - 1] : '';
          const after = hay[idx + needle.length] || '';
          if (isWord(before) || isWord(after)) { from = idx + 1; continue; }
        }
        out.push(this._mapOffset(nodes, starts, idx, needle.length));
        from = idx + Math.max(1, needle.length);
      }
      return out;
    },

    _mapOffset(nodes, starts, globalStart, length) {
      const globalEnd = globalStart + length;
      let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
      for (let i = 0; i < nodes.length; i++) {
        const s = starts[i];
        const e = s + nodes[i].nodeValue.length;
        if (startNode == null && globalStart >= s && globalStart <= e) {
          startNode = nodes[i];
          startOffset = globalStart - s;
        }
        if (globalEnd >= s && globalEnd <= e) {
          endNode = nodes[i];
          endOffset = globalEnd - s;
          break;
        }
      }
      return { startNode, startOffset, endNode, endOffset };
    },

    _rangeOf(m) {
      const r = document.createRange();
      r.setStart(m.startNode, m.startOffset);
      r.setEnd(m.endNode, m.endOffset);
      return r;
    },

    _refreshFindHighlights() {
      if (!ensureHighlights()) return;
      clearHighlights();
      if (!this.findMatches?.length) return;
      for (let i = 0; i < this.findMatches.length; i++) {
        const m = this.findMatches[i];
        if (!m.startNode || !m.endNode) continue;
        try {
          const r = this._rangeOf(m);
          if (i === this.findIndex) _hlCurrent.add(r);
          else _hlAll.add(r);
        } catch { /* noop */ }
      }
    },

    findNext() {
      if (this.findMatches.length === 0) this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      this._selectMatch((this.findIndex + 1) % this.findMatches.length);
    },

    findPrev() {
      if (this.findMatches.length === 0) this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      this._selectMatch((this.findIndex - 1 + this.findMatches.length) % this.findMatches.length);
    },

    _selectMatch(i) {
      this.findIndex = i;
      this._refreshFindHighlights();
      const m = this.findMatches[i];
      if (!m?.startNode) return;
      try {
        const range = this._rangeOf(m);
        const rect = range.getBoundingClientRect();
        if (rect && (rect.top < 120 || rect.bottom > window.innerHeight - 120)) {
          (m.startNode.parentElement || m.container)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        }
      } catch { /* noop */ }
    },

    replaceCurrent() {
      if (this.findMatches.length === 0) return;
      const m = this.findMatches[this.findIndex];
      if (!m?.startNode || !m?.endNode) return;
      this._doReplaceAt(m);
      this.$nextTick(() => {
        this.recomputeFindMatches();
        if (this.findMatches.length > 0) {
          this._selectMatch(Math.min(this.findIndex, this.findMatches.length - 1));
        }
      });
    },

    replaceAll() {
      if (!this.findTerm) return;
      this.recomputeFindMatches();
      if (this.findMatches.length === 0) return;
      const matches = this.findMatches.slice().reverse();
      let count = 0;
      for (const m of matches) {
        if (this._doReplaceAt(m)) count++;
      }
      const app = window.__app;
      app?.setStatus?.(app.t('bookEditor.find.replacedAll', { n: count }), false, 3000);
      this.$nextTick(() => this.recomputeFindMatches());
    },

    _doReplaceAt(m) {
      if (!m.startNode || !m.endNode) return false;
      const container = m.container || m.startNode.parentElement?.closest('[data-book-editor-page]');
      if (!container) return false;
      try {
        const range = this._rangeOf(m);
        range.deleteContents();
        const textNode = document.createTextNode(this.findReplace);
        range.insertNode(textNode);
        const pageId = parseInt(container.dataset.bookEditorPage, 10);
        const block = this.blocks.find(b => b.kind === 'page' && b.pageId === pageId);
        if (block) {
          block.html = container.innerHTML;
          if (!block.dirty) {
            block.dirty = true;
            this.dirtyCount++;
          }
          this._scheduleAutosave(block.pageId);
        }
        return true;
      } catch {
        return false;
      }
    },
};
