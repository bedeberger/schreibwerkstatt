'use strict';
// Theme-Switcher (Auto / Hell / Dunkel) als Sektion im Optionen-Menü (⋯).
// Progressive Enhancement: share-theme-init.js hat das Theme schon vor dem
// ersten Paint gesetzt (FOUC-Schutz). Hier bauen wir nur den Switcher. Auto =
// kein data-theme (CSS-Media-Query folgt System); explizit = Attribut.

import { el } from './dom.js';

export function setupThemeSwitcher({ t, menuSection }) {
  const sec = menuSection(t('theme_label'));
  const KEY = 'sw_share_theme';
  const modes = [['auto', t('theme_auto')], ['light', t('theme_light')], ['dark', t('theme_dark')]];
  const btns = {};
  function apply(pref, persist) {
    if (persist) { try { localStorage.setItem(KEY, pref); } catch {} }
    if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
    else document.documentElement.removeAttribute('data-theme');
    for (const [m] of modes) {
      const on = m === pref;
      btns[m].classList.toggle('share-theme__btn--active', on);
      btns[m].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  const group = el('div', 'share-theme__group');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('theme_label'));
  for (const [mode, label] of modes) {
    const b = el('button', 'share-theme__btn', label);
    b.type = 'button';
    b.addEventListener('click', () => apply(mode, true));
    btns[mode] = b;
    group.appendChild(b);
  }
  sec.appendChild(group);
  const init = window.__shareThemePref;
  apply(init === 'light' || init === 'dark' ? init : 'auto', false);
}
