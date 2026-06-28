// Teil von notebookEditMethods (siehe Facade edit.js).
import { EVT, runQuoteNormalize, writeEditorPrefs } from './_shared.js';

export const viewMethods = {

  togglePageEditorFullscreen() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorFullscreen = !app.pageEditorFullscreen;
    writeEditorPrefs({ fullscreen: app.pageEditorFullscreen, fitWidth: app.pageEditorFitWidth, showMarks: app.pageEditorShowMarks });
  },


  // Fit-Width ist Pure-CSS (Container-Query in page-view.css). Toggle ändert
  // nur die Klasse; Font-Scaling übernimmt cqi-Calc. Manueller Zoom (--editor-zoom)
  // multipliziert sich orthogonal — beim Toggle hier nicht angefasst.
  togglePageEditorFitWidth() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorFitWidth = !app.pageEditorFitWidth;
    writeEditorPrefs({ fullscreen: app.pageEditorFullscreen, fitWidth: app.pageEditorFitWidth, showMarks: app.pageEditorShowMarks });
  },


  // Steuerzeichen-Anzeige (Absatzmarken ¶ + Soft-Break ↵). Reiner Klassen-
  // Toggle auf dem contenteditable — die Marken sind CSS-Pseudo-Elemente
  // (page-view.css), kein Markup im gespeicherten HTML, kein Caret-Slot.
  togglePageEditorShowMarks() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorShowMarks = !app.pageEditorShowMarks;
    writeEditorPrefs({ fullscreen: app.pageEditorFullscreen, fitWidth: app.pageEditorFitWidth, showMarks: app.pageEditorShowMarks });
    if (app.pageEditorShowMarks) this._installFormatMarks();
    else this._uninstallFormatMarks();
  },


  pageEditorZoomIn() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = Math.min(2.5, Math.round((app.pageEditorZoom + 0.1) * 100) / 100);
    this._scheduleFormatMarks?.();
  },


  pageEditorZoomOut() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = Math.max(0.7, Math.round((app.pageEditorZoom - 0.1) * 100) / 100);
    this._scheduleFormatMarks?.();
  },


  pageEditorZoomReset() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = 1;
    this._scheduleFormatMarks?.();
  },


  async normalizeQuotes() {
    const app = window.__app;
    if (!Alpine.store('nav').selectedBookId) return;
    const editEl = this._getEditEl();
    if (!editEl) return;
    const { ok, count } = await runQuoteNormalize({
      bookId: Alpine.store('nav').selectedBookId,
      rootEl: editEl,
    });
    if (!ok) return;
    if (count > 0) {
      app._markEditDirty?.();
      editEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    app.quotesNormalizedFlash = { count };
    if (app._quotesFlashTimer) clearTimeout(app._quotesFlashTimer);
    app._quotesFlashTimer = setTimeout(() => {
      app.quotesNormalizedFlash = null;
      app._quotesFlashTimer = null;
    }, 1800);
    window.dispatchEvent(new CustomEvent(EVT.LANGUAGETOOL_RECHECK));
  },


  // Trennlinie (<hr>) am Caret einfügen + Folge-Absatz für Weiterschreiben.
  // Verhalten: leerer Block → ersetzen; sonst → nach Block einfügen.
  // Trigger: Toolbar-Button + Cmd/Ctrl+Shift+H (siehe editor/toolbar.js).
  insertHorizontalRule() {
    const editEl = this._getEditEl();
    if (!editEl) return;
    editEl.focus();
    const sel = document.getSelection();
    let block = null;
    if (sel && sel.rangeCount) {
      let cur = sel.getRangeAt(0).startContainer;
      if (cur && cur.nodeType === 3) cur = cur.parentNode;
      while (cur && cur !== editEl) {
        if (cur.nodeType === 1 && cur.matches?.('p, h1, h2, h3, h4, h5, h6, blockquote, pre, li, div.poem')) { block = cur; break; }
        cur = cur.parentNode;
      }
    }
    const hr = document.createElement('hr');
    const next = document.createElement('p');
    next.appendChild(document.createElement('br'));
    if (!block) {
      editEl.appendChild(hr);
      editEl.appendChild(next);
    } else if ((block.textContent || '').trim() === '') {
      block.parentNode.replaceChild(hr, block);
      hr.insertAdjacentElement('afterend', next);
    } else {
      block.insertAdjacentElement('afterend', hr);
      hr.insertAdjacentElement('afterend', next);
    }
    const range = document.createRange();
    range.setStart(next, 0);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    this._markEditDirty?.();
  },
};
