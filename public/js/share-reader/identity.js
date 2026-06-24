'use strict';
// Reader-Identität (persistent pro Browser) + Namens-Chip/Modal. Standalone.
// Der Name wird nicht pro Formular abgefragt, sondern einmal zentral gesetzt:
// beim ersten Laden öffnet ein Modal („Dein Name"), danach steht „Als <Name> ·
// Ändern" im Optionen-Menü (⋯). Composer, Reply-Form und SSR-Form kommentieren
// mit dem hier gesetzten Namen (sonst anonym). „Überspringen"/Outside-Click
// merkt sich den Verzicht für die Session (sessionStorage).

import { el } from './dom.js';

const RT_KEY = 'sw_share_reader_token';
const NAME_KEY = 'sw_share_reader_name';
const DISMISS_KEY = 'sw_share_name_dismissed';

export function readerToken() {
  let v = '';
  try { v = localStorage.getItem(RT_KEY) || ''; } catch {}
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
    const a = new Uint8Array(16);
    (crypto.getRandomValues ? crypto.getRandomValues(a) : a.fill(0));
    v = 'r' + Array.from(a, b => (b % 36).toString(36)).join('');
    try { localStorage.setItem(RT_KEY, v); } catch {}
  }
  return v;
}
export function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
export function rememberName(n) { try { if (n) localStorage.setItem(NAME_KEY, n); } catch {} }
export function forgetName() { try { localStorage.removeItem(NAME_KEY); } catch {} }
export function nameDismissed() { try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } }
export function markNameDismissed() { try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {} }
export function closeNameModal() {
  const ex = document.getElementById('share-name-modal');
  if (ex) ex.remove();
}

// Identitäts-Chip (in den Optionen-Menü-Cluster via menuSection) + Namens-Modal.
// `onNameChange(name)` wird bei tatsächlicher Änderung aufgerufen, damit die
// Facade die bisherigen eigenen Kommentare auf den neuen Namen nachzieht.
export function setupIdentity({ t, menuSection, onNameChange }) {
  const sec = menuSection();
  const chip = el('div', 'share-identity-bar');
  sec.appendChild(chip);

  function renderChip() {
    chip.innerHTML = '';
    const name = savedName();
    if (name) chip.appendChild(el('span', 'share-identity-bar__as', t('comment_as').replace('{name}', name)));
    const btn = el('button', 'share-identity-bar__btn', name ? t('change_name') : t('set_name'));
    btn.type = 'button';
    btn.addEventListener('click', () => openNameModal());
    chip.appendChild(btn);
  }

  function openNameModal() {
    closeNameModal();
    const overlay = el('div', 'share-composer');
    overlay.id = 'share-name-modal';
    const card = el('div', 'share-composer__card');
    card.appendChild(el('h3', 'share-composer__title', t('name_modal_title')));
    card.appendChild(el('p', 'share-name-modal__intro', t('name_modal_intro')));
    const input = el('input', 'share-composer__name');
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = t('your_name');
    input.value = savedName();
    const actions = el('div', 'share-composer__actions');
    const save = el('button', 'share-composer__submit', t('name_modal_save'));
    save.type = 'button';
    const skip = el('button', 'share-composer__cancel', t('name_modal_skip'));
    skip.type = 'button';
    actions.appendChild(save);
    actions.appendChild(skip);
    card.appendChild(input);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 30);

    function commit() {
      const n = (input.value || '').trim();
      const prev = savedName();
      if (n) rememberName(n); else forgetName();
      markNameDismissed();
      renderChip();
      closeNameModal();
      // Bisherige eigene Kommentare auf den neuen Namen nachziehen (Server
      // matcht über reader_token), dann Threads neu laden.
      if (n !== prev && typeof onNameChange === 'function') onNameChange(n);
    }
    save.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    skip.addEventListener('click', () => { markNameDismissed(); closeNameModal(); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { markNameDismissed(); closeNameModal(); } });
  }

  renderChip();
  // Auto-Öffnen beim ersten Laden, solange kein Name gesetzt und nicht in
  // dieser Session weggeklickt.
  if (!savedName() && !nameDismissed()) openNameModal();
}
