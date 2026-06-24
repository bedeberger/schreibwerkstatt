'use strict';
// Lese-Fortschrittsbalken ganz oben am Fensterrand. Spiegelt den vertikalen
// Scroll-Anteil des Dokuments als Balkenbreite (--progress). Progressive
// Enhancement: ohne JS kein Balken, mit JS folgt er dem Scroll (rAF-gedrosselt).

import { el } from './dom.js';

export function setupProgressBar() {
  const wrap = el('div', 'share-progress');
  wrap.setAttribute('aria-hidden', 'true');
  const bar = el('div', 'share-progress__bar');
  wrap.appendChild(bar);
  document.body.appendChild(wrap);

  let raf = null;
  function update() {
    raf = null;
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const y = window.scrollY || doc.scrollTop || 0;
    const pct = max > 0 ? Math.min(100, Math.max(0, (y / max) * 100)) : 0;
    bar.style.setProperty('--progress', pct + '%');
  }
  function schedule() { if (raf == null) raf = requestAnimationFrame(update); }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
}
