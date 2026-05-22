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
// Focus-Editor: `.focus-editor__content` ist gleichzeitig contenteditable-root
// UND Scroll-Container (overflow-y:auto, siehe focus-mode.css). Scroll-Events
// bubblen nicht — Listener muss am scrollenden Element selbst sitzen, sonst
// feuert `_reposition` beim internen Scroll nicht und Squiggles kleben fest.
const FOCUS_SCROLL_SEL = '.focus-editor__content';
const BOOK_CARD_SEL = '.card--bookeditor';

export function setupSpellcheckDispatch(app) {
  if (!app || typeof app.$watch !== 'function') return;

  let current = null;        // { kind, root, ctl }
  let bookBlockObserver = null;  // MutationObserver fuer Bucheditor (Block-Wechsel) — lebt unabhaengig vom Controller

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
  function _pageId() {
    const pid = app.currentPage?.page_id ?? app.currentPage?.id ?? null;
    return pid ? Number(pid) : null;
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
  }

  function _setupBookObserver() {
    if (bookBlockObserver) return;
    const card = document.querySelector(BOOK_CARD_SEL);
    if (!card) return;
    bookBlockObserver = new MutationObserver(() => {
      if (!_isEnabled() || !app.showBookEditorCard) return;
      const active = document.querySelector(BOOK_SEL);
      if (active && active !== current?.root) {
        _attachKind('book');
      } else if (!active && current?.kind === 'book') {
        _detach();
      }
    });
    bookBlockObserver.observe(card, { attributes: true, subtree: true, attributeFilter: ['contenteditable'] });
  }

  function _teardownBookObserver() {
    if (bookBlockObserver) { bookBlockObserver.disconnect(); bookBlockObserver = null; }
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
      // `.page-content-view--editing` ist selbst der Scroll-Container
      // (overflow-y:auto + max-height:70vh). `_findScrollParent` startet bei
      // parentElement und wuerde Root ueberspringen — explizit setzen, damit
      // Wheel-Forwarding (controller.js) die Squiggles-bubbled-Wheel-Events
      // an den richtigen Scroller weiterleitet.
      scrollContainer = root;
    } else if (kind === 'book') {
      root = document.querySelector(BOOK_SEL);
      // Bucheditor scrollt am Window — controller#_findScrollParent loest auf.
      scrollContainer = null;
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
      getPageId: _pageId,
      isEnabled: _isEnabled,
      i18n: (k) => (typeof app.t === 'function' ? app.t(k) : k),
    });
    ctl.attach();
    current = { kind, root, ctl };
  }

  function _evaluate() {
    if (!_isEnabled()) { _detach(); _teardownBookObserver(); return; }
    // Prioritaet: Focus > Notebook > Bucheditor (kann nicht ko-existieren).
    if (app.focusActive) {
      _teardownBookObserver();
      _afterPaint(() => _attachKind('focus'));
    } else if (app.editMode) {
      _teardownBookObserver();
      _afterPaint(() => _attachKind('notebook'));
    } else if (app.showBookEditorCard) {
      // Block-Observer lebt so lange Bucheditor offen ist — unabhaengig
      // davon, ob gerade ein Block aktiv (contenteditable="true") ist.
      _afterPaint(() => {
        _setupBookObserver();
        _attachKind('book');
      });
    } else {
      _teardownBookObserver();
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
  window.addEventListener('beforeunload', () => { _detach(); _teardownBookObserver(); });
}
