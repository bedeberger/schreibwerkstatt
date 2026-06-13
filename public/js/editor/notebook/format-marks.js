// Steuerzeichen-Overlay für den Notebook-Editor: zeichnet einen Soft-Break-
// Pfeil (↵) über jedes <br> im contenteditable. Reine Read-only-Dekoration in
// einer separaten Overlay-Schicht (.page-editor-marks-layer) — editierbarer DOM
// und gespeichertes HTML bleiben unberührt (gleiche Philosophie wie die
// Entity-Highlights). Absatzmarken (¶) macht CSS allein (page-view.css); ein
// <br> lässt sich aber von keinem Browser per CSS/Pseudo-Element dekorieren
// (kein Box-Modell), daher dieser JS-Pfad mit Positionsmessung.
//
// Aktiv nur wenn editMode && !focusActive && pageEditorShowMarks. Recompute via
// rAF-Coalesce bei: Tippen (input), internem Scroll und Grössenänderung
// (ResizeObserver deckt Resize/Fit-Width/Vollbild und Fokus-Ein-/Austritt ab,
// da der Notebook-Editor im Fokus per x-show ausgeblendet wird). Reiner
// Font-Size-Zoom (--editor-zoom) ändert die Editor-Box nicht → die
// pageEditorZoom*-Methoden rufen _scheduleFormatMarks explizit.

const NOTEBOOK_EDIT_SEL = '#editor-card .page-content-view--editing';

// Auto-Slot-<br> als einziges Kind eines leeren Text-Blocks ist strukturell
// (Caret-Slot, vgl. ensureTrailingParagraph) — kein echter Zeilenumbruch, keine
// Marke.
function isCaretFiller(br) {
  const p = br.parentElement;
  return !!p && p.childNodes.length === 1 && /^(P|H[1-6]|LI)$/.test(p.tagName);
}

export const formatMarksMethods = {
  _renderFormatMarks() {
    const app = window.__app;
    const editEl = document.querySelector(NOTEBOOK_EDIT_SEL);
    if (!editEl) return;
    const layer = editEl.parentElement?.querySelector('.page-editor-marks-layer');
    if (!layer) return;

    const active = !!(app?.pageEditorShowMarks && app?.editMode && !app?.focusActive);
    if (!active) { layer.replaceChildren(); layer.hidden = true; return; }

    const editRect = editEl.getBoundingClientRect();
    // Overlay exakt über die Border-Box des Editors legen (offsetParent =
    // .page-editor-wrap, position:relative). overflow:hidden clippt Pfeile, die
    // durch den internen Scroll aus dem Sichtfenster laufen.
    layer.style.left = editEl.offsetLeft + 'px';
    layer.style.top = editEl.offsetTop + 'px';
    layer.style.width = editEl.offsetWidth + 'px';
    layer.style.height = editEl.offsetHeight + 'px';
    layer.style.fontSize = getComputedStyle(editEl).fontSize;
    layer.hidden = false;

    const range = document.createRange();
    const frag = document.createDocumentFragment();
    // Marke an einer gemessenen Umbruch-Position platzieren. height = Zeilenhöhe,
    // damit die CSS-Mittelzentrierung (.format-mark) den Pfeil vertikal auf
    // Textmitte legt statt an den oberen Rand der Zeile.
    const place = (r) => {
      if (!r || !r.height) return; // degenerierte Messung überspringen
      const mark = document.createElement('span');
      mark.className = 'format-mark format-mark--br';
      mark.textContent = '↵';
      mark.style.left = (r.left - editRect.left) + 'px';
      mark.style.top = (r.top - editRect.top) + 'px';
      mark.style.height = r.height + 'px';
      frag.appendChild(mark);
    };

    // 1) Echte <br>-Elemente (Soft-Break via Shift+Enter).
    editEl.querySelectorAll('br').forEach((br) => {
      if (isCaretFiller(br)) return;
      range.selectNode(br);
      place(range.getBoundingClientRect());
    });

    // 2) \n-Zeilenumbrüche in Blöcken, die Newlines erhalten (white-space:
    //    pre-line/pre/pre-wrap) — Gedichte (div.poem) und <pre> haben kein
    //    <br>, der Umbruch steckt als Zeichen im Text.
    const walker = document.createTreeWalker(editEl, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue;
      if (!text || text.indexOf('\n') === -1 || !node.parentElement) continue;
      const ws = getComputedStyle(node.parentElement).whiteSpace;
      if (!/^(pre|pre-wrap|pre-line|break-spaces)$/.test(ws)) continue;
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        place(range.getClientRects()[0]);
      }
    }

    layer.replaceChildren(frag);
  },

  _scheduleFormatMarks() {
    if (this._formatMarksRaf) return;
    this._formatMarksRaf = requestAnimationFrame(() => {
      this._formatMarksRaf = null;
      this._renderFormatMarks();
    });
  },

  _installFormatMarks() {
    const editEl = document.querySelector(NOTEBOOK_EDIT_SEL);
    if (!editEl) return;
    this._uninstallFormatMarks();
    const abort = new AbortController();
    this._formatMarksAbort = abort;
    const onChange = () => this._scheduleFormatMarks();
    editEl.addEventListener('input', onChange, { signal: abort.signal });
    editEl.addEventListener('scroll', onChange, { signal: abort.signal, passive: true });
    try {
      this._formatMarksRO = new ResizeObserver(() => this._scheduleFormatMarks());
      this._formatMarksRO.observe(editEl);
    } catch { this._formatMarksRO = null; }
    this._scheduleFormatMarks();
  },

  _uninstallFormatMarks() {
    if (this._formatMarksRaf) { cancelAnimationFrame(this._formatMarksRaf); this._formatMarksRaf = null; }
    this._formatMarksRO?.disconnect?.();
    this._formatMarksRO = null;
    this._formatMarksAbort?.abort?.();
    this._formatMarksAbort = null;
    const layer = document.querySelector('.page-editor-marks-layer');
    if (layer) { layer.replaceChildren(); layer.hidden = true; }
  },
};
