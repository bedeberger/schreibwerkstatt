// Spellcheck-Dispatcher — eine Instanz pro App. Beobachtet Editor-State auf
// dem Root (`editMode`, `focusActive`, `showBookEditorCard`) und attached
// einen Controller auf das jeweils aktive contenteditable-Element. Hält
// genau einen aktiven Controller (oder keinen).
//
// Wechselt der aktive Editor (z.B. Notebook -> Focus, oder Block-Switch im
// Bucheditor), detached der Dispatcher den alten und attached einen neuen.
//
// Sprache: aus aktuellem Buch (books[i] mit language+region) → `${l}-${r}`.

import { createSpellcheckController } from './controller.js';

const NOTEBOOK_SEL = '.page-content-view--editing';
const FOCUS_SEL = '.focus-editor__content';
const BOOK_SEL = '.book-editor-page-body[contenteditable="true"]';
const FOCUS_SCROLL_SEL = '.focus-editor';
const BOOK_SCROLL_SEL = '.book-editor-scroll, .book-editor-card__scroll, .book-editor-card';

export function setupSpellcheckDispatch(app) {
  if (!app || typeof app.$watch !== 'function') return;

  let current = null;        // { kind, root, ctl }
  let blockObserver = null;  // MutationObserver fuer Bucheditor (Block-Wechsel)

  function _currentBook() {
    const id = app.selectedBookId;
    if (!id) return null;
    return (app.books || []).find(b => String(b.id) === String(id)) || null;
  }
  function _locale() {
    const b = _currentBook();
    if (!b) return 'auto';
    const l = b.language || '';
    const r = b.region || '';
    if (l && r) return `${l}-${r}`;
    if (l) return l;
    return 'auto';
  }
  function _bookId() {
    const id = app.selectedBookId;
    return id ? Number(id) : null;
  }
  function _isEnabled() { return !!app.languagetoolEnabled; }

  function _onApply(kind, range, text) {
    if (!range) return;
    const startEl = range.startContainer?.parentElement || null;
    try {
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
    } catch { return; }
    // Selection hinter Insertion setzen, Input-Event dispatchen (Editor-Save).
    try {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      const r2 = document.createRange();
      r2.setStartAfter(range.endContainer);
      r2.collapse(true);
      sel?.addRange(r2);
    } catch {}
    const host = startEl?.closest(`${NOTEBOOK_SEL}, ${FOCUS_SEL}, ${BOOK_SEL}`);
    if (host) {
      host.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Bucheditor: Block-Activate triggert eigene dirty-Logik via input-Event.
  }

  function _detach() {
    if (current?.ctl) {
      try { current.ctl.detach(); } catch {}
    }
    current = null;
    if (blockObserver) { blockObserver.disconnect(); blockObserver = null; }
  }

  function _attachKind(kind) {
    _detach();
    if (!_isEnabled()) return;
    let root = null;
    let scrollContainer = null;
    if (kind === 'focus') {
      root = document.querySelector(FOCUS_SEL);
      scrollContainer = document.querySelector(FOCUS_SCROLL_SEL);
    } else if (kind === 'notebook') {
      root = document.querySelector(NOTEBOOK_SEL);
    } else if (kind === 'book') {
      root = document.querySelector(BOOK_SEL);
      scrollContainer = root?.closest(BOOK_SCROLL_SEL.split(',')[0].trim()) || null;
    }
    if (!root) return;
    const ctl = createSpellcheckController({
      root,
      scrollContainer,
      getHtml: () => root.innerHTML,
      onApplyReplacement: (range, text) => _onApply(kind, range, text),
      editorKind: kind,
      getBookLocale: _locale,
      getBookId: _bookId,
      isEnabled: _isEnabled,
      i18n: (k) => (typeof app.t === 'function' ? app.t(k) : k),
    });
    ctl.attach();
    current = { kind, root, ctl };

    if (kind === 'book') {
      // Bucheditor-Block-Wechsel: aktiver Block hat contenteditable="true";
      // Switch -> Controller neu attachen.
      const card = document.querySelector('.book-editor-card, .book-editor');
      if (card) {
        blockObserver = new MutationObserver(() => {
          const active = document.querySelector(BOOK_SEL);
          if (active && active !== current?.root) {
            _attachKind('book');
          } else if (!active && current?.kind === 'book') {
            _detach();
          }
        });
        blockObserver.observe(card, { attributes: true, subtree: true, attributeFilter: ['contenteditable'] });
      }
    }
  }

  function _evaluate() {
    if (!_isEnabled()) { _detach(); return; }
    // Prioritaet: Focus > Notebook > Bucheditor (kann nicht ko-existieren).
    if (app.focusActive) {
      _afterPaint(() => _attachKind('focus'));
    } else if (app.editMode) {
      _afterPaint(() => _attachKind('notebook'));
    } else if (app.showBookEditorCard) {
      _afterPaint(() => _attachKind('book'));
    } else {
      _detach();
    }
  }

  function _afterPaint(fn) {
    // Alpine rendert :spellcheck/contenteditable Toggles im naechsten Tick;
    // ein Frame Verzoegerung garantiert, dass das Root im DOM ist.
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }

  app.$watch('languagetoolEnabled', _evaluate);
  app.$watch('editMode',            _evaluate);
  app.$watch('focusActive',         _evaluate);
  app.$watch('showBookEditorCard',  _evaluate);
  // Buchwechsel im Bucheditor: gleiche Karte, anderes Buch -> Re-Attach mit
  // anderem Locale-Context.
  app.$watch('selectedBookId',      () => {
    if (current) _evaluate();
  });

  // Initial-Eval (falls bereits ein Editor offen ist beim Boot).
  _evaluate();

  // Cleanup-Hook (App-Destroy ist rare; best-effort).
  window.addEventListener('beforeunload', _detach);
}
