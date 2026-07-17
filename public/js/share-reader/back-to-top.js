'use strict';
// Nach-oben-Button für den Share-Reader. Eigenständiges Modul (kein Alpine),
// liest #share-config selbst (nur für das aria-Label). Erscheint schwebend unten
// rechts, sobald der Leser ein Stück gescrollt hat, und springt zurück an den
// Anfang. Progressive Enhancement — ohne JS kein Button.

(function () {
  const cfgEl = document.getElementById('share-config');
  let I18N = {};
  if (cfgEl) { try { I18N = (JSON.parse(cfgEl.textContent || '{}').i18n) || {}; } catch { I18N = {}; } }
  const label = I18N.back_to_top || 'Top';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'share-back-to-top';
  btn.setAttribute('aria-label', label);
  btn.textContent = '↑';
  document.body.appendChild(btn);

  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }));

  let raf = null;
  function update() {
    raf = null;
    btn.classList.toggle('share-back-to-top--visible', (window.scrollY || 0) > 600);
  }
  window.addEventListener('scroll', () => { if (raf == null) raf = requestAnimationFrame(update); }, { passive: true });
  update();
})();
