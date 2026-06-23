// Kommentar-Leiste des Bucheditors: verankerte Share-Link-Leser-Kommentare des
// GANZEN Buchs als Margin-Rail rechts neben dem Manuskript-Stream. Pendant zur
// Notebook-Read-Modus-Leiste (public/js/editor/comments-rail.js), aber scope =
// ganzer Stream statt einzelner Seite. Owner springt aus der „Geteilte Links"-
// Karte für Buch-/Kapitel-Shares hierher (Event `book-editor:goto-comment`).
//
// Verhalten (Laden, Re-Anchoring, Diff, Reply/Resolve/Delete, Goto-by-bid) kommt
// aus dem geteilten Kern public/js/editor/comment-rail-core.js (SSoT mit der
// Notebook-Leiste). Hier bleibt nur die Bucheditor-Glue: Scope =
// .book-editor-stream, eigene Highlight-Namen, Stream-Ready-Check, Window-Scroll.
// Methoden werden in bookEditorCard gespreadet; State-Felder sind dort deklariert.

import { createCommentRail } from './comment-rail-core.js';

function streamEl() { return document.querySelector('.book-editor-stream'); }

const rail = createCommentRail({
  scopeEl: streamEl,
  hlAll: 'book-editor-comment-anchor',
  hlActive: 'book-editor-comment-anchor-active',
  keys: {
    comments: 'bookComments', threads: 'commentThreads', selectedRootId: 'commentSelectedRootId',
    railVisible: 'commentRailVisible', replyDrafts: 'commentReplyDrafts', savingReply: 'commentSavingReply',
    savingResolve: 'commentSavingResolve', loadingBookId: '_commentLoadingBookId',
    recomputeRaf: '_commentRecomputeRaf', pendingGotoBid: '_pendingGotoBid',
  },
  // Bucheditor ist immer „Stream-Modus" — kein Read/Edit-Guard.
  idle: () => false,
  // Recompute, sobald der Stream gerendert ist (Blocks via x-init/x-effect
  // imperativ gefüllt — kurz nach blocks-Set).
  shouldWait: (ctx) => !(streamEl() && ctx.blocks.length > 0),
  scrollToRange: (range) => {
    const r = range.getBoundingClientRect();
    if (r && r.height) window.scrollTo({ top: window.scrollY + r.top - 140, behavior: 'smooth' });
  },
});

export const bookEditorCommentsMethods = {
  ...rail,

  // Partial-/Card-erwartete Methodennamen → geteilter Kern.
  _loadBookComments(bookId) { return this._railLoad(bookId); },
  _scheduleCommentRecompute() { return this._railSchedule(); },
  _recomputeCommentThreads() { return this._railRecompute(); },
  selectCommentThread(rootId) { return this._railSelect(rootId); },
  replyToCommentRoot(thread) { return this._railReply(thread); },
  toggleCommentResolve(comment) { return this._railResolve(comment); },
  deleteBookComment(comment) { return this._railDelete(comment); },

  toggleCommentRail() {
    this.commentRailVisible = !this.commentRailVisible;
    // Highlights folgen der Sichtbarkeit: einblenden = neu lokalisieren+markieren,
    // ausblenden = Anker-Markierung im Stream entfernen.
    if (this.commentRailVisible) this._recomputeCommentThreads();
    else this._railClearHL();
  },

  // Alias für die Card-Lifecycle/destroy (historischer Name).
  _clearCommentHL() { return this._railClearHL(); },
};
