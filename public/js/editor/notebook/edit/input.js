// Teil von notebookEditMethods (siehe Facade edit.js).
import { handleEditorCopy, handleEditorCut, handleEditorPaste } from './_shared.js';

export const inputMethods = {

  _onEditPaste(e) {
    if (handleEditorPaste(e)) this._markEditDirty();
  },


  _onEditCopy(e) { handleEditorCopy(e); },


  _onEditCut(e) {
    if (handleEditorCut(e)) this._markEditDirty();
  },


  _markEditDirty() {
    const app = window.__app;
    if (!app?.editMode) return;
    app.editDirty = true;
    this._scheduleDraftSave();
    this._scheduleAutosave();
    this._historyPushSoon?.();
    this._scrollEditCaretIntoView();
    // Steuerzeichen-Overlay neu vermessen: programmatische Mutationen (STT,
    // Paste, Cut, Toolbar) feuern KEIN `input`-Event, an dem die Marks-Schicht
    // sonst hängt — ohne diesen Aufruf bleibt die ↵/¶-Dekoration während des
    // Diktats stehen und entkoppelt sich vom Text. rAF-coalesced/idempotent,
    // daher für den Tipp-Pfad (feuert ohnehin `input`) ein No-op.
    this._scheduleFormatMarks?.();
  },


  // Hält den Caret im sichtbaren Bereich des Edit-Felds. Das contenteditable ist
  // sein eigener Scroll-Container (max-height + overflow-y:auto), darum nicht
  // scrollIntoView (das würde die ganze Seite scrollen), sondern den eigenen
  // scrollTop nachziehen. Nur ein Nudge, wenn der Caret über/unter den
  // sichtbaren Rand rutscht — scrollt der User bewusst weg (ohne zu tippen),
  // bleibt das unberührt (kein Input-Event). Aufrufer: `_markEditDirty`
  // (Tippen/Paste/Toolbar — Sicherheitsnetz) und STT (programmatischer Insert,
  // bei dem der Browser NICHT automatisch nachzieht). `rect` optional: STT
  // misst den eingefügten Knoten direkt, sonst wird der Live-Caret vermessen.
  _scrollEditCaretIntoView(rect) {
    const el = this._getEditEl();
    if (!el) return;
    let r = rect;
    if (!r) {
      const sel = document.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer) && el !== range.commonAncestorContainer) return;
      r = range.getBoundingClientRect();
      // Kollabierte Range in einem frisch erzeugten leeren `<p><br></p>` liefert
      // in Chromium {top:0, bottom:0, height:0}. Greift dann der Block-Fallback
      // nicht, bricht der Nudge beim Enter ab und der Editor zieht erst beim
      // ersten getippten Zeichen nach -> sichtbarer Scroll-Sprung. Stattdessen
      // den umschliessenden Block vermessen (wie der STT-Pfad mit explizitem
      // Knoten-Rect), damit der neue Absatz schon beim Enter mitscrollt.
      if (!r || (!r.height && !r.top && !r.bottom)) {
        let node = range.commonAncestorContainer;
        if (node && node.nodeType === 3) node = node.parentNode;
        while (node && node.parentNode && node.parentNode !== el) node = node.parentNode;
        if (node && node !== el && node.getBoundingClientRect) r = node.getBoundingClientRect();
      }
    }
    if (!r || (!r.height && !r.top && !r.bottom)) return; // kein verlässliches Rect
    const host = el.getBoundingClientRect();
    const margin = 28;
    if (r.bottom > host.bottom - margin) {
      el.scrollTop += r.bottom - (host.bottom - margin);
    } else if (r.top < host.top + margin) {
      el.scrollTop -= (host.top + margin) - r.top;
    }
  },
};
