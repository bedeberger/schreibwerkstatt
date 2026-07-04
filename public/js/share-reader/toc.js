'use strict';
// Inhaltsverzeichnis (Reader-seitig): Ein-/Ausblenden (persistent, im Optionen-
// Menü ⋯) + sanftes Scrollen zur Sektion. Progressive Enhancement — ohne JS
// bleibt das TOC offen.

import { el } from './dom.js';

export function setupToc({ menuSection }) {
  setupTocToggle(menuSection);
  setupTocScroll();
  setupTocSpy();
}

// Toggle-Eintrag im Optionen-Menü (⋯). Blendet das ganze TOC-Panel aus; im Grid
// (≥1100px) gibt die Layout-Klasse `share-toc-collapsed` die linke Spalte frei
// (Text rückt nach). Zustand pro Browser in localStorage. Nur aktiv, wenn
// überhaupt ein TOC da ist.
function setupTocToggle(menuSection) {
  const layout = document.querySelector('.share-layout');
  const toc = document.querySelector('.share-toc');
  const heading = toc && toc.querySelector('.share-toc__heading');
  if (!layout || !toc || !heading) return;
  const KEY = 'sw_share_toc_collapsed';
  const sec = menuSection();
  const btn = el('button', 'share-action-btn');
  btn.type = 'button';
  btn.appendChild(el('span', 'share-action-btn__label', heading.textContent));
  sec.appendChild(btn);
  function apply(collapsed, persist) {
    layout.classList.toggle('share-toc-collapsed', collapsed);
    btn.classList.toggle('share-action-btn--active', !collapsed);
    btn.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
    if (persist) { try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch {} }
  }
  let collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch {}
  apply(collapsed, false);
  btn.addEventListener('click', () => apply(!layout.classList.contains('share-toc-collapsed'), true));
}

// Native Anchor-Sprünge landen hart hinter dem Sticky-Header. Stattdessen smooth
// scrollen mit Header-Offset und die Ziel-Überschrift kurz aufleuchten lassen
// (reduced-motion respektiert → kein Smooth, nur Flash).
function setupTocScroll() {
  function tocHeaderOffset() {
    const h = document.querySelector('.share-header');
    return (h ? h.getBoundingClientRect().height : 0) + 16;
  }
  function flashTarget(elm) {
    elm.classList.remove('share-flash');
    void elm.offsetWidth; // Reflow → Animation neu starten
    elm.classList.add('share-flash');
    elm.addEventListener('animationend', () => elm.classList.remove('share-flash'), { once: true });
  }
  document.querySelectorAll('.share-toc__link').forEach((link) => {
    link.addEventListener('click', (ev) => {
      const id = (link.getAttribute('href') || '').replace(/^#/, '');
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      ev.preventDefault();
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const top = window.scrollY + target.getBoundingClientRect().top - tocHeaderOffset();
      window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
      flashTarget(target);
      try { history.replaceState(null, '', '#' + id); } catch {}
    });
  });
}

// Scroll-Spy: markiert im TOC den Eintrag der aktuell gelesenen Sektion
// („wo bin ich gerade"). Pendant zur Bucheditor-Outline, aber ohne Alpine —
// scroll-getrieben statt IntersectionObserver, weil die Anker-Ziele dünne
// Überschriften sind (IO nach intersectionRatio wackelt bei kurzen Elementen).
// Aktiv = die letzte Überschrift, die über die Leselinie (Sticky-Header-Kante)
// nach oben gescrollt ist. Im ≥1100px-Grid ist das TOC eine höhen-gedeckelte,
// scrollbare sticky Leiste → aktiven Eintrag darin sichtbar halten.
function setupTocSpy() {
  const links = Array.from(document.querySelectorAll('.share-toc__link'));
  const entries = links
    .map((link) => {
      const id = (link.getAttribute('href') || '').replace(/^#/, '');
      return { link, target: id ? document.getElementById(id) : null };
    })
    .filter((e) => e.target); // Dokument-Reihenfolge (querySelectorAll)
  if (entries.length < 2) return;

  const toc = document.querySelector('.share-toc');
  let activeLink = null;
  let raf = 0;

  function readingLine() {
    const h = document.querySelector('.share-header');
    return (h ? h.getBoundingClientRect().height : 0) + 24;
  }

  // Aktiven Eintrag im höhen-gedeckelten TOC-Viewport halten (nur den TOC-
  // Container scrollen, nie das Fenster). Analog Bucheditor _scrollOutlineToActive.
  function scrollTocToActive() {
    if (!toc || !activeLink) return;
    const c = toc.getBoundingClientRect();
    const a = activeLink.getBoundingClientRect();
    // Grosszügig: oben genug Luft, damit der aktive Eintrag nicht unter die
    // sticky „Inhaltsverzeichnis"-Überschrift rutscht; unten etwas Kontext.
    const pad = 44;
    if (a.top < c.top + pad) toc.scrollTop -= (c.top + pad) - a.top;
    else if (a.bottom > c.bottom - pad) toc.scrollTop += a.bottom - (c.bottom - pad);
  }

  function update() {
    raf = 0;
    const line = readingLine();
    let current = entries[0];
    for (const e of entries) {
      if (e.target.getBoundingClientRect().top <= line) current = e;
      else break;
    }
    if (current.link === activeLink) return;
    if (activeLink) {
      activeLink.classList.remove('share-toc__link--active');
      activeLink.removeAttribute('aria-current');
    }
    activeLink = current.link;
    activeLink.classList.add('share-toc__link--active');
    activeLink.setAttribute('aria-current', 'true');
    scrollTocToActive();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(update);
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  update();
}
