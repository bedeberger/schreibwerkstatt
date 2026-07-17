'use strict';
// Lesekomfort-Regler für den Share-Reader: Schriftgrösse, Zeilenbreite
// (Satzspiegel) und Serif/Serifenlos. Eigenständiges Modul (kein Alpine), liest
// #share-config selbst — analog dwell.js/tts.js. Baut einen „Aa"-Knopf mit
// Popover in die Werkzeug-Leiste (#share-actions) und wendet die Einstellungen
// über CSS-Custom-Properties (Skalierung/Breite) bzw. ein data-Attribut am Body
// (Schriftart) an. Persistiert pro Browser in localStorage. Progressive
// Enhancement — ohne JS bleiben die CSS-Defaults (18px, 70ch, Serif).

const FONT_STEPS = [0.9, 1.0, 1.15, 1.3];
const FONT_LABELS = ['A−', 'A', 'A+', 'A++'];
const WIDTHS = { narrow: '60ch', normal: '70ch', wide: '82ch' };

(function () {
  const host = document.getElementById('share-actions');
  if (!host) return;
  const cfgEl = document.getElementById('share-config');
  let I18N = {};
  if (cfgEl) { try { I18N = (JSON.parse(cfgEl.textContent || '{}').i18n) || {}; } catch { I18N = {}; } }
  const t = (k) => I18N[k] || k;

  const KEY = 'sw_share_reading_prefs';
  const prefs = { font: 1.0, width: 'normal', face: 'serif' };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (FONT_STEPS.includes(raw.font)) prefs.font = raw.font;
    if (raw.width in WIDTHS) prefs.width = raw.width;
    if (raw.face === 'serif' || raw.face === 'sans') prefs.face = raw.face;
  } catch {}

  function apply(persist) {
    const root = document.documentElement;
    root.style.setProperty('--share-reader-font-scale', String(prefs.font));
    root.style.setProperty('--share-reader-measure', WIDTHS[prefs.width]);
    document.body.setAttribute('data-reader-font', prefs.face);
    if (persist) { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} }
  }
  apply(false);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Trigger + Popover (gleiches Öffnen/Schliessen-Muster wie das Optionen-Menü).
  const wrap = el('div', 'share-prefs');
  const trigger = el('button', 'share-prefs__trigger', 'Aa');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', t('prefs_label'));
  const panel = el('div', 'share-prefs__panel');
  panel.hidden = true;
  wrap.appendChild(trigger);
  wrap.appendChild(panel);
  host.appendChild(wrap);
  const setOpen = (open) => { panel.hidden = !open; trigger.setAttribute('aria-expanded', open ? 'true' : 'false'); };
  trigger.addEventListener('click', (e) => { e.stopPropagation(); setOpen(panel.hidden); });
  document.addEventListener('mousedown', (e) => { if (!panel.hidden && !wrap.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) setOpen(false); });

  // Ein Segment-Control (Label + Buttons). get()/set() lesen/schreiben prefs.
  function group(labelText, options, get, set) {
    const g = el('div', 'share-prefs__group');
    g.appendChild(el('span', 'share-prefs__label', labelText));
    const seg = el('div', 'share-prefs__seg');
    const btns = [];
    function paint() {
      btns.forEach(({ btn, value }) => {
        const on = value === get();
        btn.classList.toggle('share-prefs__seg-btn--active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    for (const opt of options) {
      const btn = el('button', 'share-prefs__seg-btn', opt.label);
      btn.type = 'button';
      if (opt.aria) btn.setAttribute('aria-label', opt.aria);
      btn.addEventListener('click', () => { set(opt.value); apply(true); paint(); });
      btns.push({ btn, value: opt.value });
      seg.appendChild(btn);
    }
    g.appendChild(seg);
    panel.appendChild(g);
    paint();
  }

  group(t('prefs_font_size'),
    FONT_STEPS.map((v, i) => ({
      value: v,
      label: FONT_LABELS[i],
      aria: i === 0 ? t('prefs_smaller') : (i === FONT_STEPS.length - 1 ? t('prefs_larger') : undefined),
    })),
    () => prefs.font, (v) => { prefs.font = v; });

  group(t('prefs_line_width'), [
    { value: 'narrow', label: t('prefs_width_narrow') },
    { value: 'normal', label: t('prefs_width_normal') },
    { value: 'wide', label: t('prefs_width_wide') },
  ], () => prefs.width, (v) => { prefs.width = v; });

  group(t('prefs_typeface'), [
    { value: 'serif', label: t('prefs_serif') },
    { value: 'sans', label: t('prefs_sans') },
  ], () => prefs.face, (v) => { prefs.face = v; });
})();
