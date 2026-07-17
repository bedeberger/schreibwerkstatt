'use strict';
// Weiterlesen-Position für den Share-Reader. Eigenständiges Modul (kein Alpine),
// liest #share-config selbst — analog dwell.js. Merkt sich pro Link (Token) den
// zuletzt erreichten Scroll-Anteil in localStorage und bietet beim nächsten
// Besuch einen „Weiterlesen"-Chip an, der dorthin springt.
//
// Anteil statt Pixel: der Buchinhalt ist live (Autor editiert weiter), ein
// Bruchteil (0..1) übersteht moderate Längenänderungen robuster als eine
// absolute Pixelposition. Progressive Enhancement — ohne JS kein Merken.

(function () {
  const cfgEl = document.getElementById('share-config');
  if (!cfgEl) return;
  let CFG;
  try { CFG = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
  const TOKEN = CFG.token;
  if (!TOKEN) return;
  const I18N = CFG.i18n || {};
  const t = (k) => I18N[k] || k;
  const KEY = 'sw_share_pos_' + TOKEN;

  function maxScroll() {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollHeight - doc.clientHeight);
  }
  function currentFraction() {
    const max = maxScroll();
    if (max <= 0) return 0;
    return Math.min(1, Math.max(0, (window.scrollY || 0) / max));
  }

  // Gespeicherte Position anbieten (nur wenn nennenswert weit, aber nicht schon
  // am Ende, und der Inhalt überhaupt scrollbar ist).
  let saved = 0;
  try { saved = parseFloat(localStorage.getItem(KEY) || '0') || 0; } catch { saved = 0; }
  const scrollable = maxScroll() > window.innerHeight * 0.5;
  if (scrollable && saved > 0.05 && saved < 0.92) {
    showResumeChip(saved);
  }

  function showResumeChip(fraction) {
    const chip = document.createElement('div');
    chip.className = 'share-resume';
    chip.setAttribute('role', 'status');

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'share-resume__btn';
    go.textContent = t('resume_reading');

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'share-resume__dismiss';
    dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', t('cancel'));

    chip.appendChild(go);
    chip.appendChild(dismiss);
    document.body.appendChild(chip);

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    go.addEventListener('click', () => {
      const top = fraction * maxScroll();
      window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
      chip.remove();
    });
    dismiss.addEventListener('click', () => chip.remove());
    // Sobald der Leser selbst nahe an die Zielstelle scrollt, ist der Chip obsolet.
    const onScroll = () => {
      if (Math.abs(currentFraction() - fraction) < 0.05) { chip.remove(); window.removeEventListener('scroll', onScroll); }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Laufend (gedrosselt) + beim Verlassen speichern.
  let raf = null;
  function persist() {
    raf = null;
    try { localStorage.setItem(KEY, String(currentFraction())); } catch {}
  }
  let last = 0;
  window.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - last < 800) return;
    last = now;
    if (raf == null) raf = requestAnimationFrame(persist);
  }, { passive: true });
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
})();
