'use strict';
// Vertikale Verankerung der Anmerkungs-Karten in der Reader-Leiste
// (Google-Docs-Modell). Pendant zur Bucheditor-Leiste
// (public/js/editor/book-editor-comments.js) — hier standalone, ohne Alpine.
//
// Artikel und Kommentar-Spalte teilen denselben Scroll-Container (das Fenster)
// und beginnen in derselben Grid-Zeile auf gleicher Höhe. Der Abstand
// „Textstelle → Spalten-Oberkante" ist deshalb scroll-invariant — wir messen ihn
// nur bei Layout-Änderungen (Render, Resize, Edit-Reflow, Auswahl), NICHT bei
// jedem Scroll. Jede verankerte Karte schwebt auf der Höhe ihrer Textstelle;
// überlappende Karten werden greedy nach unten weggeschoben. Bei Auswahl wird die
// aktive Karte auf ihre exakte Anker-Höhe gepinnt, die übrigen darum herum gelegt.

import { locateRange } from '../share-anchor.js';

const CARD_GAP = 10;
// Unter diesem Viewport fällt die Leiste auf eine statische Stapel-Liste zurück
// (siehe share.css ≥1100px-Branch) — das JS überspringt dann die Verankerung.
const FLAT_BELOW = '(max-width: 1099px)';

// opts:
//   article()         → das Artikel-Element (#share-article)
//   getLayer()        → die Positionierungs-Ebene (.share-comments__list)
//   getAnchoredCards()→ [{ id, anchor }] der verankerten Root-Threads
//   getActiveId()     → aktuell fokussierter Thread (für Pin) oder null
export function createCardLayout(opts) {
  const { article, getLayer, getAnchoredCards, getActiveId } = opts;
  let raf = null;
  let ro = null;
  const observed = new Set();
  const supportsMM = typeof window !== 'undefined' && typeof window.matchMedia === 'function';

  function isFlat() { return supportsMM && window.matchMedia(FLAT_BELOW).matches; }

  function observe(el) {
    if (!el || !ro || observed.has(el)) return;
    try { ro.observe(el); observed.add(el); } catch {}
  }

  // Anker-Y einer Karte relativ zur Layer-Oberkante. Erst über die lokalisierte
  // Range (Quote im Block gefunden); sonst — „Stelle geändert", Quote weg, Block
  // noch da — über die Block-Oberkante. Beides weg (Block gelöscht) → null.
  function anchorY(card, view, layerTop) {
    const a = card.anchor;
    if (!a) return null;
    const range = locateRange(view, a);
    if (range) { const r = range.getBoundingClientRect(); if (r.height || r.width) return r.top - layerTop; }
    if (a.bid) {
      let blk = null;
      try { blk = view.querySelector(`[data-bid="${CSS.escape(String(a.bid))}"]`); } catch {}
      if (blk) return blk.getBoundingClientRect().top - layerTop;
    }
    return null;
  }

  function layout() {
    const layer = getLayer();
    const view = article();
    if (!layer || !view) return;

    // Flach-Modus (Mobile): inline-Positionen löschen, CSS stapelt statisch.
    if (isFlat()) {
      layer.style.removeProperty('--layer-height');
      for (const el of layer.querySelectorAll('.share-thread, .share-thread-marker')) {
        el.style.removeProperty('--comment-top');
        el.style.removeProperty('--marker-top');
      }
      return;
    }
    observe(view);

    const cards = getAnchoredCards();
    // Keine verankerten Karten → Höhe auf auto zurück (der Empty-Hinweis fliesst
    // normal, statt aus einer 0-px-Ebene zu ragen).
    if (!cards.length) { layer.style.removeProperty('--layer-height'); return; }
    const layerTop = layer.getBoundingClientRect().top;
    const activeId = getActiveId();

    // 1) Anker-Y + gemessene Kartenhöhe pro Thread; Marker auf echte Anker-Höhe.
    const items = cards.map((c) => {
      const el = layer.querySelector(`.share-thread[data-comment-id="${CSS.escape(String(c.id))}"]`);
      const marker = layer.querySelector(`.share-thread-marker[data-marker-for="${CSS.escape(String(c.id))}"]`);
      observe(el);
      const y = anchorY(c, view, layerTop);
      if (marker) {
        if (y == null) marker.style.removeProperty('--marker-top');
        else marker.style.setProperty('--marker-top', Math.round(y) + 'px');
      }
      return { c, el, marker, y, h: el ? el.offsetHeight : 0 };
    });

    const located = items.filter((it) => it.y != null && it.el).sort((a, b) => a.y - b.y);
    const floating = items.filter((it) => it.y == null && it.el);

    // 2) Kollisions-Auflösung → Wunsch-Tops. Bei Auswahl die aktive Karte auf ihre
    //    echte Höhe pinnen und die übrigen darum legen; sonst greedy top-down.
    const pin = located.find((it) => it.c.id === activeId);
    if (pin) {
      const pi = located.indexOf(pin);
      pin.top = Math.max(0, pin.y);
      let cur = pin.top + pin.h + CARD_GAP;
      for (const it of located.slice(pi + 1)) { const top = Math.max(it.y, cur); it.top = top; cur = top + it.h + CARD_GAP; }
      let curBottom = pin.top - CARD_GAP;
      for (const it of located.slice(0, pi).reverse()) {
        let top = Math.min(it.y, curBottom - it.h);
        if (top < 0) top = 0;
        it.top = top; curBottom = top - CARD_GAP;
      }
    } else {
      let cur = 0;
      for (const it of located) { const top = Math.max(it.y, cur); it.top = top; cur = top + it.h + CARD_GAP; }
    }

    // 2b) Finaler Vorwärts-Sweep erzwingt Überlappungsfreiheit (der Pin-Aufwärts-
    //     zweig kann mehrere Karten auf top:0 klemmen). Reicht der Platz → No-op.
    located.sort((a, b) => a.top - b.top);
    let prevBottom = -Infinity;
    for (const it of located) { const top = Math.max(it.top, prevBottom + CARD_GAP, 0); it.top = top; prevBottom = top + it.h; }

    // 3) Nicht lokalisierbare (Block gelöscht) unten anhängen.
    let bottom = located.reduce((m, it) => Math.max(m, it.top + it.h), 0);
    for (const it of floating) { it.top = bottom + CARD_GAP; bottom = it.top + it.h; }

    for (const it of [...located, ...floating]) {
      if (it.el) it.el.style.setProperty('--comment-top', Math.round(it.top) + 'px');
    }
    layer.style.setProperty('--layer-height', Math.max(0, Math.round(bottom)) + 'px');
    // Nach dem ersten Positionieren Karten einblenden (vorher unsichtbar, damit sie
    // nicht für 2 rAF-Frames auf top:0 aufblitzen). Positionswechsel sind hart, ohne
    // Scroll-Animation.
    layer.classList.add('is-positioned');
  }

  // Doppel-rAF: erstes wartet auf den DOM-Re-Render der Karten, zweites misst die
  // dann existierenden Höhen.
  function schedule() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => { raf = null; layout(); });
    });
  }

  function init() {
    if (typeof ResizeObserver !== 'undefined') ro = new ResizeObserver(() => schedule());
    window.addEventListener('resize', schedule);
  }

  return { init, schedule, layout };
}
