// Alpine.data('bookEditorCard') — Bucheditor.
//
// Rendert alle Kapitel + Seiten eines Buchs in Lesereihenfolge als Sequenz
// separater contenteditable-Blöcke. Pro-Block-Save schreibt via savePage()
// aus editor/shared/page-api.js mit source='book', Stale-Schutz via
// _checkPageConflict. HTML-Quelle ist /content/* (server-cleant in
// routes/content.js via cleanPageHtml).
//
// Click-aktiviert-Block: Default contenteditable=false; Klick setzt aktive
// pageId, Caret aus Mousedown-Position. Verlassen flusht Save bei dirty.
//
// Save-Queue: pro-Block dirty/saving; Concurrency 1; Save-All seriell.
//
// Find/Replace: TreeWalker über alle Block-Container; CSS Custom Highlight API;
// Replace via Range.deleteContents + Text-Insert; Block wird dirty + queued.

import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync, toggleWrapFullscreen } from '../fullscreen.js';
import { fromPages } from '../manuscript-stream.js';
import { bookEditorCommentsMethods } from '../editor/book-editor-comments.js';
import { stripFocusArtefacts, htmlToText, fetchJson, escHtml } from '../utils.js';
import { handleEditorPaste, handleEditorCopy, handleEditorCut } from '../editor/shared/paste.js';
import { savePage } from '../editor/shared/page-api.js';

const AUTOSAVE_IDLE_MS = 60000;
const AUTOSAVE_MAX_MS = 120000;

const HIGHLIGHT_ALL = 'book-editor-find-match';
const HIGHLIGHT_CURRENT = 'book-editor-find-current';
let _hlAll = null, _hlCurrent = null;
function ensureHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return false;
  if (!_hlAll) { _hlAll = new Highlight(); CSS.highlights.set(HIGHLIGHT_ALL, _hlAll); }
  if (!_hlCurrent) { _hlCurrent = new Highlight(); CSS.highlights.set(HIGHLIGHT_CURRENT, _hlCurrent); }
  return true;
}
function clearHighlights() {
  if (_hlAll) _hlAll.clear();
  if (_hlCurrent) _hlCurrent.clear();
}

function isWordCharBE(ch) {
  if (!ch) return false;
  return /[\p{L}\p{N}_]/u.test(ch);
}

// Findings-/Chat-Marks entfernen, falls aus History/Chat-Apply im rohen HTML
// vorhanden. Bucheditor selbst rendert keine Lektorats-Marks.
function cleanForSave(html) {
  if (!html) return '';
  if (html.indexOf('lektorat-mark') === -1 && html.indexOf('chat-mark') === -1 &&
      html.indexOf('lektorat-ins') === -1 && html.indexOf('chat-mark-ins') === -1) {
    return html;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('.lektorat-ins, .chat-mark-ins').forEach(n => n.remove());
  tmp.querySelectorAll('.lektorat-mark, .chat-mark').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  return tmp.innerHTML;
}

// Build-Funktion getrennt für Unit-Tests.
// Baut die Render-Blockliste über das geteilte Stream-Modell (fromPages) und
// wrappt jeden Page-Entry mit dem Editor-State (dirty/saving/_rev/originalHtml).
// stripFocusArtefacts bleibt hier (browser-only) statt im pure Modell.
// originalUpdatedAt kommt aus der Quell-Page (das Modell trägt kein updated_at).
export function buildBlocksFromPages(pages) {
  const byId = new Map();
  for (const p of (pages || [])) byId.set(p.pageId, p);
  return fromPages(pages).map((e) => {
    if (e.kind === 'chapter') return { kind: 'chapter', chapterId: e.chapterId, name: e.name };
    const src = byId.get(e.id) || {};
    const html = stripFocusArtefacts(e.html || '');
    return {
      kind: 'page',
      pageId: e.id,
      name: e.name,
      chapterId: e.chapterId,
      html,
      originalHtml: html,
      originalUpdatedAt: src.updated_at || null,
      dirty: false,
      saving: false,
      saveError: '',
      conflict: null,
      savedAt: null,
      _rev: 0,
    };
  });
}

export function registerBookEditorCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookEditorCard', () => ({
    blocks: [],
    loading: false,
    loadError: '',
    activePageId: null,
    saveQueue: [],
    saveProcessing: false,
    saveAllRunning: false,
    saveAllTotal: 0,
    saveAllDone: 0,
    dirtyCount: 0,
    savingCount: 0,
    _autosaveTimers: new Map(),
    _autosaveMaxTimers: new Map(),
    _pendingMousedown: null,

    findOpen: false,
    findTerm: '',
    findReplace: '',
    findCaseSensitive: false,
    findWholeWord: false,
    findMatches: [],
    findIndex: -1,
    _findRecomputeTimer: null,
    _beforeUnloadHandler: null,

    // Outline (Inhaltsverzeichnis): aktuell sichtbarer Page-Block via
    // IntersectionObserver. collapsedChapters: Set<chapterId> für eingeklappte
    // Kapitel-Gruppen. outlineOpen: Mobile-Toggle.
    visiblePageId: null,
    collapsedChapters: {},
    outlineOpen: true,
    _outlineObserver: null,

    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // Platz für den Manuskript-Stream. Toggle in toggleBookEditorFullscreen.
    bookEditorFullscreen: false,

    // Kommentar-Leiste (verankerte Leser-Kommentare des ganzen Buchs) —
    // Methoden in editor/book-editor-comments.js.
    bookComments: [],
    commentThreads: [],
    commentGeneralThreads: [],
    commentSelectedRootId: null,
    commentReplyDrafts: {},
    commentSavingReply: null,
    commentSavingResolve: null,
    commentRailVisible: false,
    _commentLoadingBookId: null,
    _commentRecomputeRaf: null,
    _pendingGotoBid: null,

    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'bookEditor',
        showFlag: 'showBookEditorCard',
        timerKeys: [],
        resetState: {
          blocks: [], loading: false, loadError: '',
          activePageId: null, saveQueue: [], saveProcessing: false,
          saveAllRunning: false, saveAllTotal: 0, saveAllDone: 0,
          dirtyCount: 0, savingCount: 0,
          findOpen: false, findTerm: '', findReplace: '',
          findMatches: [], findIndex: -1,
          visiblePageId: null, collapsedChapters: {},
          bookComments: [], commentThreads: [], commentGeneralThreads: [], commentSelectedRootId: null,
          commentReplyDrafts: {}, commentSavingReply: null, commentSavingResolve: null,
          commentRailVisible: false, _pendingGotoBid: null,
        },
        load: (root) => this._load(root.selectedBookId),
      });

      this._beforeUnloadHandler = (e) => {
        if (this.dirtyCount > 0 || this.savingCount > 0) {
          e.preventDefault();
          e.returnValue = '';
        }
      };
      window.addEventListener('beforeunload', this._beforeUnloadHandler, { signal: this._lifecycle.signal });

      // Cmd/Ctrl+F-Routing via editor-find-card: dispatcht hierher, wenn die
      // Karte sichtbar ist (statt BookStack-Search zu fokussieren).
      window.addEventListener('book-editor:open-find', () => {
        if (window.__app?.showBookEditorCard) this.openFind();
      }, { signal: this._lifecycle.signal });

      // Sprung aus der „Geteilte Links"-Karte (Buch-/Kapitel-Share): zur
      // kommentierten Stelle im Stream + Thread in der Leiste öffnen.
      window.addEventListener('book-editor:goto-comment', (e) => {
        this.commentRailVisible = true;
        this._pendingGotoBid = e.detail?.bid || null;
        if (this.blocks.length) this._scheduleCommentRecompute();
      }, { signal: this._lifecycle.signal });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      // $root = die Karten-Wurzel (.card--bookeditor), unabhängig vom Klick-Kontext.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.bookEditorFullscreen = active; },
      });
    },

    destroy() {
      for (const t of this._autosaveTimers.values()) clearTimeout(t);
      for (const t of this._autosaveMaxTimers.values()) clearTimeout(t);
      this._autosaveTimers.clear();
      this._autosaveMaxTimers.clear();
      this._teardownOutlineObserver();
      if (this._commentRecomputeRaf) { cancelAnimationFrame(this._commentRecomputeRaf); this._commentRecomputeRaf = null; }
      this._clearCommentHL();
      clearHighlights();
      this._lifecycle?.destroy();
    },

    // ── Laden ──────────────────────────────────────────────────────────────
    async _load(bookId) {
      if (!bookId) return;
      this.loading = true;
      this.loadError = '';
      this.blocks = [];
      this.activePageId = null;
      this.dirtyCount = 0;
      this.savingCount = 0;
      try {
        const data = await fetchJson('/book-editor/' + bookId + '/contents');
        this.blocks = buildBlocksFromPages(data.pages || []);
        this.loading = false;
        if (data.missing > 0) {
          const app = window.__app;
          app?.setStatus?.(app.t('bookEditor.missingPages', { n: data.missing }), false, 5000);
        }
        // Outline-IntersectionObserver nach Render bauen.
        this.$nextTick(() => this._initOutlineObserver());
        // Verankerte Leser-Kommentare des Buchs laden + über den Stream auflösen.
        this._loadBookComments();
      } catch (e) {
        this.loading = false;
        this.loadError = e.message || 'Load failed';
      }
    },

    ...bookEditorCommentsMethods,

    // ── Rendering-Sync ────────────────────────────────────────────────────
    // Initialer Mount-Hook (x-init). Setzt rev-Marker + Initial-Body imperativ.
    _mountBlockEl(el, block) {
      if (!el || block.kind !== 'page') return;
      el.innerHTML = block.html;
      el.dataset.rev = String(block._rev || 0);
    },

    // Schreibt block.html in DOM-Container; läuft NICHT auf dem aktiven Block
    // (DOM gehört dort dem User). Per-Block-_rev triggert Re-Hydrate bei
    // externen Mutationen (Find/Replace, Reload).
    _maybeRehydrate(el, block) {
      if (!el || block.kind !== 'page') return;
      if (this.activePageId === block.pageId) return;
      const seen = parseInt(el.dataset.rev || '-1', 10);
      if (seen === block._rev) return;
      // Trusted Source: HTML kommt vom BookStack-Proxy (server-cleant).
      el.innerHTML = block.html;
      el.dataset.rev = String(block._rev);
    },

    // ── Klick-aktiviert-Block ─────────────────────────────────────────────
    _onBlockMousedown(block, event) {
      if (block.kind !== 'page') return;
      if (this.activePageId === block.pageId) return;
      this._pendingMousedown = { x: event.clientX, y: event.clientY, pageId: block.pageId };
    },

    async activateBlock(block) {
      if (block.kind !== 'page') return;
      if (this.activePageId === block.pageId) return;
      if (this.activePageId != null) {
        const prev = this.blocks.find(b => b.kind === 'page' && b.pageId === this.activePageId);
        if (prev?.dirty) this._enqueueSave(prev.pageId);
      }
      this.activePageId = block.pageId;
      this.$nextTick(() => {
        const el = document.querySelector(`[data-book-editor-page="${block.pageId}"]`);
        if (!el) return;
        el.focus({ preventScroll: true });
        if (this._pendingMousedown && this._pendingMousedown.pageId === block.pageId) {
          const md = this._pendingMousedown;
          this._pendingMousedown = null;
          try {
            const range = document.caretRangeFromPoint
              ? document.caretRangeFromPoint(md.x, md.y)
              : null;
            if (range && el.contains(range.startContainer)) {
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }
          } catch { /* noop */ }
        }
      });
    },

    _onBlockInput(block, event) {
      if (block.kind !== 'page') return;
      const el = event.currentTarget;
      block.html = el.innerHTML;
      this._markBlockDirty(block);
    },

    _onBlockPaste(block, e) {
      if (block.kind !== 'page' || this.activePageId !== block.pageId) return;
      if (handleEditorPaste(e)) {
        // execCommand triggert kein input-Event in allen Browsern → manuell.
        block.html = e.currentTarget.innerHTML;
        this._markBlockDirty(block);
      }
    },

    _onBlockCopy(_block, e) { handleEditorCopy(e); },

    _onBlockCut(block, e) {
      if (block.kind !== 'page' || this.activePageId !== block.pageId) return;
      if (handleEditorCut(e)) {
        block.html = e.currentTarget.innerHTML;
        this._markBlockDirty(block);
      }
    },

    _markBlockDirty(block) {
      if (block.dirty) {
        this._scheduleAutosave(block.pageId);
        return;
      }
      block.dirty = true;
      this.dirtyCount++;
      this._scheduleAutosave(block.pageId);
    },

    _scheduleAutosave(pageId) {
      const idleTimer = this._autosaveTimers.get(pageId);
      if (idleTimer) clearTimeout(idleTimer);
      this._autosaveTimers.set(pageId, setTimeout(() => {
        this._autosaveTimers.delete(pageId);
        this._enqueueSave(pageId);
      }, AUTOSAVE_IDLE_MS));
      if (!this._autosaveMaxTimers.has(pageId)) {
        this._autosaveMaxTimers.set(pageId, setTimeout(() => {
          this._autosaveMaxTimers.delete(pageId);
          this._enqueueSave(pageId);
        }, AUTOSAVE_MAX_MS));
      }
    },

    // ── Save-Queue ────────────────────────────────────────────────────────
    _enqueueSave(pageId) {
      const block = this.blocks.find(b => b.kind === 'page' && b.pageId === pageId);
      if (!block || !block.dirty || block.saving) return;
      if (!this.saveQueue.includes(pageId)) this.saveQueue.push(pageId);
      this._processQueue();
    },

    async _processQueue() {
      if (this.saveProcessing) return;
      if (this.saveQueue.length === 0) return;
      this.saveProcessing = true;
      try {
        while (this.saveQueue.length > 0) {
          const pageId = this.saveQueue.shift();
          const block = this.blocks.find(b => b.kind === 'page' && b.pageId === pageId);
          if (!block || !block.dirty) continue;
          await this._saveBlock(block);
        }
      } finally {
        this.saveProcessing = false;
      }
    },

    async _saveBlock(block) {
      const app = window.__app;
      if (!app) return;
      const idle = this._autosaveTimers.get(block.pageId);
      if (idle) { clearTimeout(idle); this._autosaveTimers.delete(block.pageId); }
      const mx = this._autosaveMaxTimers.get(block.pageId);
      if (mx) { clearTimeout(mx); this._autosaveMaxTimers.delete(block.pageId); }

      const newHtml = cleanForSave(block.html);
      if (newHtml === block.originalHtml) {
        block.dirty = false;
        this.dirtyCount = Math.max(0, this.dirtyCount - 1);
        return;
      }
      const newText = htmlToText(newHtml).trim();
      if (!newText) {
        block.saveError = app.t('bookEditor.emptyAbort');
        return;
      }
      block.saving = true;
      block.saveError = '';
      this.savingCount++;
      try {
        const conflict = await app._checkPageConflict(block.pageId, block.originalUpdatedAt);
        if (conflict) {
          block.conflict = {
            remoteUserName: conflict.remoteUserName,
            remoteUpdatedAt: conflict.remoteUpdatedAt,
            remoteHtml: conflict.remoteHtml,
          };
          block.saveError = app.t('bookEditor.conflictHint', {
            user: conflict.remoteUserName || app.t('edit.conflict.unknownUser'),
          });
          return;
        }
        const saved = await savePage(block.pageId, {
          html: newHtml,
          pageName: block.name,
          source: 'book',
          expectedUpdatedAt: block.originalUpdatedAt || null,
        });
        block.originalHtml = newHtml;
        if (saved?.updated_at) block.originalUpdatedAt = saved.updated_at;
        block.dirty = false;
        block.savedAt = Date.now();
        block.conflict = null;
        this.dirtyCount = Math.max(0, this.dirtyCount - 1);
        app._syncPageStatsAfterSave?.({ id: block.pageId, updated_at: block.originalUpdatedAt }, newHtml);
      } catch (e) {
        if (e?.status === 409 && e?.code === 'PAGE_CONFLICT') {
          block.conflict = {
            remoteUserName: e.body?.server_editor_name || null,
            remoteUpdatedAt: e.body?.server_updated_at || null,
            remoteHtml: null,
          };
          block.saveError = app.t('bookEditor.conflictHint', {
            user: e.body?.server_editor_name || app.t('edit.conflict.unknownUser'),
          });
        } else {
          block.saveError = e.message || app.t('bookEditor.saveFailed');
        }
      } finally {
        block.saving = false;
        this.savingCount = Math.max(0, this.savingCount - 1);
      }
    },

    async saveAllDirty() {
      if (this.saveAllRunning) return;
      const dirty = this.blocks.filter(b => b.kind === 'page' && b.dirty);
      if (dirty.length === 0) return;
      this.saveAllRunning = true;
      this.saveAllTotal = dirty.length;
      this.saveAllDone = 0;
      for (const b of dirty) {
        if (!this.saveQueue.includes(b.pageId)) this.saveQueue.push(b.pageId);
      }
      const startLen = this.saveQueue.length;
      this._processQueue();
      while (this.saveProcessing || this.saveQueue.length > 0) {
        await new Promise(rs => setTimeout(rs, 200));
        this.saveAllDone = startLen - this.saveQueue.length;
      }
      this.saveAllRunning = false;
      this.saveAllDone = this.saveAllTotal;
    },

    async resolveConflictOverwrite(block) {
      if (!block.conflict) return;
      block.originalUpdatedAt = block.conflict.remoteUpdatedAt;
      block.conflict = null;
      block.saveError = '';
      if (!block.dirty) { block.dirty = true; this.dirtyCount++; }
      this._enqueueSave(block.pageId);
    },

    resolveConflictTakeRemote(block) {
      if (!block.conflict) return;
      block.html = block.conflict.remoteHtml || '';
      block.originalHtml = block.html;
      block.originalUpdatedAt = block.conflict.remoteUpdatedAt;
      if (block.dirty) { block.dirty = false; this.dirtyCount = Math.max(0, this.dirtyCount - 1); }
      block.conflict = null;
      block.saveError = '';
      block._rev++;
    },

    // ── Outline / TOC ─────────────────────────────────────────────────────
    // Liste der Outline-Items, abgeleitet aus blocks. Pro Page mit Mini-Status
    // (dirty/saving/saved). Pro Kapitel: Liste seiner Pages + collapsed-Flag.
    get outlineNodes() {
      const out = [];
      let currentChapter = null;
      let solos = [];
      for (const b of this.blocks) {
        if (b.kind === 'chapter') {
          if (solos.length) { out.push({ kind: 'solos', pages: solos }); solos = []; }
          currentChapter = { kind: 'chapter', chapterId: b.chapterId, name: b.name, pages: [] };
          out.push(currentChapter);
        } else if (b.kind === 'page') {
          const item = { kind: 'page', pageId: b.pageId, name: b.name, block: b };
          if (currentChapter) currentChapter.pages.push(item);
          else solos.push(item);
        }
      }
      if (solos.length) out.push({ kind: 'solos', pages: solos });
      return out;
    },

    _initOutlineObserver() {
      this._teardownOutlineObserver();
      if (typeof IntersectionObserver === 'undefined') return;
      const targets = document.querySelectorAll('.book-editor-page-card');
      if (targets.length === 0) return;
      const visible = new Map();
      let rafScheduled = false;
      const flush = () => {
        rafScheduled = false;
        // Topmost sichtbaren Block wählen: kleinster top-offset > 0.
        let bestId = null, bestTop = Infinity;
        for (const [id, top] of visible) {
          if (top < bestTop) { bestTop = top; bestId = id; }
        }
        if (bestId != null) {
          const next = parseInt(bestId, 10);
          if (next !== this.visiblePageId) this.visiblePageId = next;
        }
      };
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const id = entry.target.dataset.outlinePageId;
          if (!id) continue;
          if (entry.isIntersecting) {
            // Top-Position relativ zum Viewport — stabiler als intersectionRatio
            // bei langen Blöcken, die den ganzen Viewport füllen (Ratio nahe 1
            // für mehrere Pages → Wechsel zwischen ihnen wackelt).
            visible.set(id, entry.boundingClientRect.top);
          } else {
            visible.delete(id);
          }
        }
        // rAF-Throttle: viele IO-Entries pro Scroll-Tick zu EINEM Update bündeln.
        // Verhindert Reactivity-Sturm + Outline-Active-Glitches beim Fast-Scroll.
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flush);
        }
      }, {
        // Top-Margin schiebt den Schwellenwert unter den Sticky-Header.
        // Threshold [0] reicht — wir wählen nach boundingClientRect.top, nicht
        // nach Ratio; weniger Trigger-Events.
        rootMargin: '-100px 0px -60% 0px',
        threshold: 0,
      });
      for (const t of targets) io.observe(t);
      this._outlineObserver = io;
    },

    _teardownOutlineObserver() {
      if (this._outlineObserver) {
        this._outlineObserver.disconnect();
        this._outlineObserver = null;
      }
    },

    scrollToBlock(pageId) {
      const el = document.querySelector(`[data-outline-page-id="${pageId}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      this.visiblePageId = pageId;
    },

    toggleChapterCollapse(chapterId) {
      const next = { ...this.collapsedChapters };
      if (next[chapterId]) delete next[chapterId];
      else next[chapterId] = true;
      this.collapsedChapters = next;
    },

    outlinePageStatus(block) {
      if (!block) return '';
      if (block.saving) return 'saving';
      if (block.conflict || block.saveError) return 'error';
      if (block.dirty) return 'dirty';
      if (block.savedAt && (Date.now() - block.savedAt) < 4000) return 'saved';
      return '';
    },

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

    onFindKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); this.closeFind(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) this.findPrev();
        else this.findNext();
      }
    },

    // Cmd/Ctrl+F läuft global über editor-find-card → book-editor:open-find.
    // Hier nur Cmd/Ctrl+S für Save-All.
    onCardKeydown(event) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        this.saveAllDirty();
      }
    },

    // Ganze Bucheditor-Karte ins Native-Vollbild — mehr Platz für den Stream.
    // Status-Sync via fullscreenchange-Listener in init() (bookEditorFullscreen).
    async toggleBookEditorFullscreen() {
      try {
        await toggleWrapFullscreen(this.$root);
      } catch {
        const app = window.__app;
        app?.setStatus?.(app.t('bookEditor.error.fullscreen'), true, 4000);
      }
    },

    // Shift+Enter = weicher Zeilenumbruch (<br>). Safari/WebKit splittet sonst
    // den Absatz in zwei <p>. execCommand('insertLineBreak') setzt cross-browser
    // konsistent ein <br> — gleicher Pfad wie Notebook-Editor.
    onBlockKeydown(block, event) {
      if (event.key === 'Enter' && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        document.execCommand('insertLineBreak');
        this._markBlockDirty(block);
      }
    },

    blockStatusKey(block) {
      if (block.kind !== 'page') return '';
      if (block.saving) return 'saving';
      if (block.conflict) return 'conflict';
      if (block.saveError) return 'error';
      if (block.dirty) return 'dirty';
      if (block.savedAt && (Date.now() - block.savedAt) < 4000) return 'saved';
      return '';
    },

    blockStatusLine(block) {
      if (block.kind !== 'page') return '';
      const app = window.__app;
      if (!app) return '';
      if (block.saving) return escHtml(app.t('bookEditor.status.saving'));
      if (block.conflict) return escHtml(app.t('bookEditor.status.conflict', { user: block.conflict.remoteUserName || app.t('edit.conflict.unknownUser') }));
      if (block.saveError) return escHtml(block.saveError);
      if (block.dirty) return escHtml(app.t('bookEditor.status.dirty'));
      if (block.savedAt) return escHtml(app.t('bookEditor.status.saved'));
      return '';
    },
  }));
}
