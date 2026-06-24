'use strict';
// Optionen-Menü (Meatball ⋯) oben rechts. Bündelt alle sekundären Reader-
// Optionen (Identität, Farbschema, Inhaltsverzeichnis) hinter einem ⋯-Trigger,
// damit die Leseansicht ruhig bleibt. Standalone (kein Alpine, kein Icon-Sprite)
// — Trigger als inline-SVG; die Cluster montieren ihre Bedienelemente über die
// zurückgegebene menuSection() in die Liste.

import { el } from './dom.js';

const MEATBALL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';

// Baut Trigger + Panel im Host (#share-actions) und liefert `menuSection(title?)`
// zum Einhängen von Bedienelement-Clustern. Ohne Host → No-op-menuSection (gibt
// einen losen, nicht eingehängten Container zurück, Cluster bleiben unsichtbar).
export function createOptionsMenu({ t }) {
  const host = document.getElementById('share-actions');
  if (!host) return { menuSection: () => el('div') };
  const wrap = el('div', 'share-menu');
  const trigger = el('button', 'share-menu__trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', t('options_label'));
  trigger.innerHTML = MEATBALL_SVG;
  const menuPanel = el('div', 'share-menu__panel');
  menuPanel.hidden = true;
  menuPanel.setAttribute('role', 'menu');
  wrap.appendChild(trigger);
  wrap.appendChild(menuPanel);
  host.appendChild(wrap);
  const setOpen = (open) => {
    menuPanel.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  trigger.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menuPanel.hidden); });
  document.addEventListener('mousedown', (e) => { if (!menuPanel.hidden && !wrap.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menuPanel.hidden) setOpen(false); });

  // Eine abgegrenzte Sektion in der Menü-Liste (optionaler Titel als Heading).
  function menuSection(title) {
    const sec = el('div', 'share-menu__section');
    if (title) sec.appendChild(el('div', 'share-menu__heading', title));
    menuPanel.appendChild(sec);
    return sec;
  }
  return { menuSection };
}
