// Sub-Komponenten-Methoden für Alpine.data('editorFocusCard').
//
// State-Machine: idle → entering → active → exiting → idle.
// Re-Entry während entering/exiting wird hart geblockt; ein Generation-Zähler
// (_focusGen) invalidiert asynchrone Nachzügler (RAFs, die nach einem schnellen
// exit noch feuern wollen).
//
// `this` zeigt auf Alpine.data('editorFocusCard'). `window.__app` ist der
// reaktive Root-Proxy.

import {
  BLOCK_TAGS, BLOCK_SEL,
  POINTER_GRACE_MS, VV_DEBOUNCE_MS, CURSOR_HIDE_MS,
  HAS_IO, HAS_MO,
  reportError,
} from './constants.js';
import {
  isEmptyParagraph, jumpToTrailingParagraph, getScrollContainer,
  findBlockFromNode, findBlockAtViewportCenter,
  setActiveBlock, setNearBlocks,
} from './dom-blocks.js';
import { applySentenceHighlight } from './sentence.js';
import {
  dynamicTypewriterThreshold, getCaretRect, typewriterScroll,
} from './typewriter.js';
import { writeFocusSnapshot, clearFocusSnapshot } from './storage.js';

export const focusCardMethods = {
  toggleFocusMode() {
    if (this._focusState === 'active') this.exitFocusMode();
    else if (this._focusState === 'idle') this.enterFocusMode();
    // entering/exiting → ignorieren (kein Double-Trigger).
  },

  startFocusEdit() {
    const app = window.__app;
    if (!app) return;
    if (!app.editMode) {
      app.startEdit?.();
      if (!app.editMode) return;
    }
    this.$nextTick(() => this.enterFocusMode());
  },

  enterFocusMode() {
    const app = window.__app;
    if (!app) return;
    if (this._focusState !== 'idle') return;
    if (!app.showEditorCard || !app.editMode) return;

    // Übergang edit-mode → focus-mode: offenen Debounce-Draft jetzt flushen,
    // damit bei Offline-Sessions kein getippter Inhalt verloren geht, falls
    // der User später im Focus-Mode abbricht oder Crashs auftreten.
    app._flushDraftSaveNow?.();

    this._focusState = 'entering';
    const gen = ++this._focusGen;

    app.focusMode = true;
    document.body.classList.add('focus-mode');
    document.body.classList.remove('focus-mode--paragraph', 'focus-mode--sentence', 'focus-mode--window-3', 'focus-mode--typewriter-only');
    document.body.classList.add('focus-mode--' + (app.focusGranularity || 'paragraph'));

    this.$nextTick(() => {
      // Wenn in der Zwischenzeit jemand exit() gerufen oder schneller
      // re-entered hat → abbrechen.
      if (gen !== this._focusGen || this._focusState !== 'entering') return;
      try {
        this._focusInstall();
        this._focusState = 'active';
        this._focusUpdateActive(true);
        writeFocusSnapshot(app.currentPage?.id);
      } catch (err) {
        reportError('enterFocusMode', err);
        this._focusTeardown();
        clearFocusSnapshot();
        app.focusMode = false;
        document.body.classList.remove('focus-mode');
        this._focusState = 'idle';
      }
    });
  },

  _focusInstall() {
    const app = window.__app;
    const container = getScrollContainer();
    if (!container) throw new Error('focus: no scroll container');

    const abort = new AbortController();
    const signal = abort.signal;
    const visibleBlocks = new Set();

    // IntersectionObserver: pflegt Set sichtbarer Blöcke. MutationObserver:
    // beobachtet NEU hinzukommende Blöcke (nur addedNodes, nicht Vollscan bei
    // jeder Mutation – sonst wird Paste von 500 Absätzen O(n²)). removedNodes
    // werden unobserved, damit IO keine Refs auf entfernte DOM-Knoten über
    // lange Edit-Sessions sammelt.
    let io = null;
    if (HAS_IO) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visibleBlocks.add(e.target);
          else visibleBlocks.delete(e.target);
        }
      }, { root: container, threshold: 0 });
      for (const el of container.querySelectorAll(BLOCK_SEL)) io.observe(el);
    }

    let mo = null;
    if (HAS_MO) {
      const observeSubtree = (node) => {
        if (!io || node.nodeType !== 1) return;
        if (BLOCK_TAGS.has(node.tagName)) io.observe(node);
        const nested = node.querySelectorAll?.(BLOCK_SEL);
        if (nested) for (const el of nested) io.observe(el);
      };
      const unobserveSubtree = (node) => {
        if (!io || node.nodeType !== 1) return;
        visibleBlocks.delete(node);
        if (BLOCK_TAGS.has(node.tagName)) io.unobserve(node);
        const nested = node.querySelectorAll?.(BLOCK_SEL);
        if (nested) for (const el of nested) { visibleBlocks.delete(el); io.unobserve(el); }
      };
      mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) observeSubtree(node);
          for (const node of m.removedNodes) unobserveSubtree(node);
        }
      });
      mo.observe(container, { childList: true, subtree: true });
    }

    // pointerIntent: Flag + Timeout-Fallback. Klick → Flag an → Selection-
    // change konsumiert es und recentert NICHT. Arrow/Tipp ohne Klick →
    // Flag aus → Recenter. Timeout fängt Klicks ab, die nie einen
    // selectionchange erzeugen (Klick in leeren Margin).
    const ctx = {
      abort, container, visibleBlocks, io, mo,
      pointerIntent: false,
      pointerTimer: 0,
      composing: false,       // IME-Composition aktiv (CJK-Eingabe)
      expectedScroll: 0,      // prog-Scroll-Unterscheidung (Counter statt Zeit)
      vvTimer: 0,
      cursorTimer: 0,
      // Short-circuit-Cache für _focusUpdateActive: bleibt der aktive Block
      // gleich (häufigster Fall beim Tippen), sparen wir setActiveBlock /
      // setNearBlocks / sentence-Highlight komplett ein. _lastGranularity
      // invalidiert den Cache bei Live-Mode-Switch.
      _lastBlock: null,
      _lastGranularity: null,
    };

    const markPointer = () => {
      ctx.pointerIntent = true;
      clearTimeout(ctx.pointerTimer);
      ctx.pointerTimer = setTimeout(() => { ctx.pointerIntent = false; }, POINTER_GRACE_MS);
    };

    const onSelection = () => {
      if (this._focusState !== 'active') return;
      if (ctx.composing) return;  // IME: nicht recentern während CJK-Composition
      const isPointer = ctx.pointerIntent;
      ctx.pointerIntent = false;
      clearTimeout(ctx.pointerTimer);
      this._focusUpdateActive(!isPointer);
    };

    // Auto-Hide-Cursor: Maus 2s ruhig → Cursor unsichtbar. Nächste Bewegung
    // bringt ihn zurück. Nur Klassentoggle, kein Style-Reset.
    const showCursor = () => {
      document.body.classList.remove('focus-cursor-hidden');
      clearTimeout(ctx.cursorTimer);
      ctx.cursorTimer = setTimeout(() => {
        if (this._focusState === 'active') {
          document.body.classList.add('focus-cursor-hidden');
        }
      }, CURSOR_HIDE_MS);
    };

    // Input-Event fängt Fälle, die selectionchange nicht abdeckt: undo/redo
    // ohne Caret-Move, Paste mit stabiler Caret-Position, Content-Rewrite
    // durch externe Module. Wort-/Zeichen-Counter läuft via installEditCounter
    // (in edit.js gestartet, Voraussetzung für Fokus) — kein zweiter Listener
    // hier nötig.
    const onInput = () => {
      if (this._focusState !== 'active') return;
      if (ctx.composing) return;
      this._focusUpdateActive(true);
    };

    // Chromium kopiert beim Paragraph-Split in contenteditable die Klasse auf
    // beide <p>. Bis _focusUpdateActive im nächsten RAF aufräumt, sind kurz
    // ZWEI Absätze .focus-paragraph-active → sichtbarer Doppelflash. Aktiven
    // Marker hier synchron VOR dem Split abräumen; RAF setzt danach neu.
    const onBeforeInput = (e) => {
      if (this._focusState !== 'active') return;
      if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
        setActiveBlock(container, null);
        setNearBlocks(container, null);
        // Cache invalidieren — sonst hält der Short-Circuit in
        // _focusUpdateActive den vermeintlich „noch aktiven" Block fest
        // und setzt nach dem Split keine neue Markierung.
        ctx._lastBlock = null;
      }
    };

    const onCompositionStart = () => { ctx.composing = true; };
    const onCompositionEnd = () => {
      ctx.composing = false;
      if (this._focusState === 'active') this._focusUpdateActive(true);
    };

    const onScroll = () => {
      if (this._focusState !== 'active') return;
      if (ctx.expectedScroll > 0) { ctx.expectedScroll--; return; }
      this._focusUpdateActive(false);
    };

    // Editor verliert Fokus (z.B. Modal öffnet, Sidebar-Klick) → aktive
    // Markierung entfernen, damit nichts „hängen" bleibt.
    const onBlur = () => {
      if (this._focusState !== 'active') return;
      setActiveBlock(container, null);
      ctx._lastBlock = null;
    };
    // Editor bekommt Fokus zurück (z.B. nach Modal-Schliessen) → Recenter
    // auf aktuelle Caret-Position.
    const onFocus = () => {
      if (this._focusState !== 'active') return;
      this._focusUpdateActive(true);
    };

    const onKey = (e) => {
      if (this._focusState !== 'active') return;
      if (e.key === 'Escape') {
        if (app?._synonymMenuOpen || app?._synonymPickerOpen) return;
        if (app?._figurLookupOpen) { app.closeFigurLookup?.(); return; }
        if (app?.editSaving) return;   // während Save-Request kein Exit
        e.preventDefault();
        if (app?.editMode && app?.editDirty && app?.cancelEdit) {
          app.cancelEdit();
        } else {
          this.exitFocusMode();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyE') {
        e.preventDefault();
        this.toggleFocusMode();
      } else if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        // Vim/emacs-Konvention: Ctrl+L recentert Cursor-Zeile in Viewport-Mitte.
        // Browser-Default (Adress-Leiste fokussieren) wird im Fokus-Modus
        // unterdrückt — User wollte ohnehin im Editor bleiben.
        e.preventDefault();
        this._focusUpdateActive(true);
      }
    };

    const onPointerMove = () => {
      if (this._focusState !== 'active') return;
      showCursor();
    };

    // Mobile-Tastatur: visualViewport schrumpft UND kann scrollen
    // (Android Chrome: offsetTop wird non-zero, wenn die KB den fixed
    // Container nach oben schiebt). Debounced, damit KB-Öffnen-Storm
    // (scroll-events bei 60Hz) nicht permanent Recenter triggert.
    // Desktop: window.resize (Sidebar, DevTools, Orientation) feuert,
    // visualViewport evtl. nicht – beide Pfade abonnieren.
    const applyViewport = () => {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      document.documentElement.style.setProperty('--focus-vh', h + 'px');
      document.documentElement.style.setProperty('--focus-vh-top', top + 'px');
      // Nur den aktiven Absatz re-validieren, NICHT recentern. Ein Recenter
      // bei jedem Viewport-Tick würde den Editor bei jedem Mobile-KB-Frame
      // oder Desktop-Resize springen lassen („flattern"). Scrollt der User
      // selbst, greifen onScroll/onSelection ohnehin.
      if (this._focusState === 'active') this._focusUpdateActive(false);
    };
    const syncViewport = () => {
      clearTimeout(ctx.vvTimer);
      ctx.vvTimer = setTimeout(applyViewport, VV_DEBOUNCE_MS);
    };
    // Initial: direkt anwenden (ohne Debounce), damit erster Frame korrekt.
    window.scrollTo(0, 0);
    applyViewport();

    document.addEventListener('selectionchange', onSelection, { signal });
    container.addEventListener('beforeinput', onBeforeInput, { signal });
    container.addEventListener('input', onInput, { signal });
    container.addEventListener('compositionstart', onCompositionStart, { signal });
    container.addEventListener('compositionend', onCompositionEnd, { signal });
    container.addEventListener('scroll', onScroll, { passive: true, signal });
    container.addEventListener('pointerdown', markPointer, { signal });
    container.addEventListener('pointerup', markPointer, { signal });
    container.addEventListener('blur', onBlur, { signal, capture: true });
    container.addEventListener('focus', onFocus, { signal, capture: true });
    window.addEventListener('keydown', onKey, { signal });
    window.addEventListener('pointermove', onPointerMove, { signal, passive: true });
    window.addEventListener('resize', syncViewport, { signal });
    window.visualViewport?.addEventListener('resize', syncViewport, { signal });
    window.visualViewport?.addEventListener('scroll', syncViewport, { signal });

    this._focusListeners = ctx;
    this._focusVisibleBlocks = visibleBlocks;

    showCursor();

    const editEl = document.querySelector('.page-content-view--editing');
    editEl?.focus();
    this._focusAutoAddedP = jumpToTrailingParagraph(container);
  },

  _focusTeardown() {
    const ctx = this._focusListeners;
    if (ctx) {
      ctx.abort?.abort();
      ctx.io?.disconnect();
      ctx.mo?.disconnect();
      clearTimeout(ctx.pointerTimer);
      clearTimeout(ctx.vvTimer);
      clearTimeout(ctx.cursorTimer);
      this._focusListeners = null;
    }
    this._focusVisibleBlocks = null;
    if (this._focusRaf) { cancelAnimationFrame(this._focusRaf); this._focusRaf = null; }
  },

  async exitFocusMode() {
    const app = window.__app;
    if (!app) return;
    if (this._focusState !== 'active') return;
    this._focusState = 'exiting';
    const gen = ++this._focusGen;

    // Auto-Slot vom Focus-Entry abräumen, falls User nichts reingeschrieben
    // hat. Sonst würde der leere `<p>` als „Änderung" gespeichert werden und
    // bei jedem Focus-Open eine BookStack-Revision erzeugen.
    const autoP = this._focusAutoAddedP;
    if (autoP && autoP.parentNode && isEmptyParagraph(autoP)) {
      autoP.remove();
    }
    this._focusAutoAddedP = null;

    // Immer speichern beim Verlassen. UI bleibt optisch bis Save durch,
    // Event-Handler sind via _focusState='exiting' bereits stumm-geschaltet.
    // Bei Offline/Fehler bleibt editDirty true + Draft im LocalStorage →
    // User bleibt im Edit-Modus und kann manuell retten.
    if (app.editMode && app.editDirty && !app.editSaving) {
      try { await app.quickSave?.(); }
      catch (e) { reportError('exitFocusMode:save', e); }
    }
    // Race: jemand hat während await enter() gerufen → abbrechen.
    if (gen !== this._focusGen) return;

    this._focusTeardown();
    clearFocusSnapshot();

    app.focusMode = false;
    document.body.classList.remove('focus-mode');
    document.body.classList.remove('focus-mode--paragraph', 'focus-mode--sentence', 'focus-mode--window-3', 'focus-mode--typewriter-only');
    document.body.classList.remove('focus-cursor-hidden');
    document.documentElement.style.removeProperty('--focus-vh');
    document.documentElement.style.removeProperty('--focus-vh-top');

    document.querySelectorAll('#editor-card .focus-paragraph-active, #editor-card .focus-paragraph-near')
      .forEach(el => {
        el.classList.remove('focus-paragraph-active');
        el.classList.remove('focus-paragraph-near');
        if (el.classList.length === 0) el.removeAttribute('class');
      });
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('focus-sentence-dim');
    }

    // Nichts Ungespeichertes → zurück in die Ansicht (Save im Fokus impliziert
    // Ende der Edit-Session; unsaubere Exits behalten den Edit-Modus).
    if (app.editMode && !app.editDirty) {
      app._stopAutosave?.();
      app._uninstallOnlineRetry?.();
      app._editCounterCtx?.teardown?.();
      app.editMode = false;
      app.editSaving = false;
      app.saveOffline = false;
      app.lastDraftSavedAt = null;
      app.closeSynonymMenu?.();
      app.closeSynonymPicker?.();
      app.closeFigurLookup?.();
    }

    // View-Mode + Kennzahlen (Wörter/Zeichen/Token) immer auffrischen, egal
    // ob Save erfolgte, no-op war oder fehlschlug. Garantie: beim Verlassen
    // des Fokusmodus reflektieren View-Mode-HTML und tokEsts-Badges den
    // aktuellen originalHtml. Idempotent zu den Save-Pfaden, die diese
    // Calls ohnehin bereits feuern.
    if (app.currentPage && app.originalHtml != null) {
      app._syncPageStatsAfterSave?.(app.currentPage, app.originalHtml);
    }
    app.updatePageView?.();

    this._focusState = 'idle';
  },

  _focusUpdateActive(scroll) {
    if (this._focusState !== 'active') return;
    if (this._focusRaf) cancelAnimationFrame(this._focusRaf);
    const gen = this._focusGen;
    this._focusRaf = requestAnimationFrame(() => {
      this._focusRaf = null;
      // try/catch um den gesamten RAF-Body: ein DOM-Edge-Case (z.B. Selection
      // über Shadow-Root, obskurer Range-Fehler) darf den Editor nicht
      // stillstellen. Fehler → loggen, nächster Event-Tick neu versuchen.
      try {
        // Falls wir mittlerweile exiting/idle sind → nichts tun.
        if (gen !== this._focusGen || this._focusState !== 'active') return;
        const ctx = this._focusListeners;
        if (!ctx) return;
        const container = ctx.container;
        if (!container) return;

        let block = null;
        const sel = document.getSelection();
        if (sel && sel.rangeCount > 0) {
          const anchor = sel.anchorNode;
          if (anchor && container.contains(anchor)) {
            block = findBlockFromNode(anchor, container);
          }
        }
        if (!block) block = findBlockAtViewportCenter(container, ctx.visibleBlocks);

        const granularity = window.__app?.focusGranularity || 'paragraph';
        const blockChanged = block !== ctx._lastBlock;
        const granularityChanged = granularity !== ctx._lastGranularity;
        // Sentence-Mode muss bei jedem Tick neu laufen (Caret kann Satzgrenze
        // überqueren, ohne den Block zu wechseln). Andere Modi sind purely
        // block-basiert → bei unverändertem Block reichen Scroll-Updates.
        const needsMarkUpdate = blockChanged || granularityChanged || granularity === 'sentence';
        if (needsMarkUpdate) {
          if (granularity === 'typewriter-only') {
            // Kein Block markieren — Body-Class hebt Dim sowieso auf. Trotzdem
            // Leichen-Klassen abräumen (User wechselt Mode → bereits gesetzte
            // .focus-paragraph-active/-near sollen weg).
            setActiveBlock(container, null);
            setNearBlocks(container, null);
          } else {
            setActiveBlock(container, block);
            if (granularity === 'window-3') {
              setNearBlocks(container, block);
            } else {
              setNearBlocks(container, null);
            }
            if (granularity === 'sentence') {
              applySentenceHighlight(block, sel);
            } else if (typeof CSS !== 'undefined' && CSS.highlights) {
              CSS.highlights.delete('focus-sentence-dim');
            }
          }
          ctx._lastBlock = block;
          ctx._lastGranularity = granularity;
        }

        // Aktive Textmarkierung: nicht recentern, sonst springt der Viewport
        // während der User die Auswahl aufzieht oder an ihr arbeitet.
        const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed;
        if (scroll && block && !hasSelection) {
          // Cursor-Zeile bevorzugen (echter Typewriter-Scroll). Nur wenn keine
          // Caret-Rect ermittelbar ist (z.B. leerer Absatz, kein Fokus), auf
          // Block-Mitte zurückfallen.
          const targetRect = getCaretRect(container) || block.getBoundingClientRect();
          const threshold = dynamicTypewriterThreshold(block);
          typewriterScroll(container, targetRect, ctx, threshold);
        }
      } catch (err) {
        reportError('updateActive', err);
      }
    });
  },
};
