// Spellcheck-Controller fuer Form-Felder (input/textarea). Eine Instanz pro
// Feld. Unterschied zur contenteditable-Variante in controller.js:
//
//   - Quelle: `el.value` (kein DOM-Walk noetig).
//   - Kein Inline-Overlay/Squiggle — Form-Felder rendern Text intern (kein
//     CSS.highlights-Support). Stattdessen kompaktes Badge im Feld (top/bottom
//     right via .lt-field-wrap); Klick oeffnet Popover mit Vorschlaegen.
//   - Filter: Spelling-only — Grammar/Style/Punctuation werden in Form-Feldern
//     bewusst weggelassen (Titel/Notizen kurz, kein Mehrwert).
//   - Apply: setRangeText + input-Event (Alpine/x-model bekommt mit).
//
// Mounting / Lifecycle: siehe dispatch.js (focusin-basiert, WeakMap-cached).
//
// Layout: Beim attach wird das Feld einmalig in <span class="lt-field-wrap">
// eingewickelt; der Badge wird Kind dieses Wraps mit position: absolute.
// Dadurch sitzt der Badge IMMER in der oberen/unteren rechten Ecke des Feldes
// — unabhaengig vom Eltern-Layout (flex/grid/block). Beim detach wird das Feld
// wieder ausgewickelt (DOM bleibt sauber). Alpine-Bindings bleiben intakt,
// weil das Element-Objekt unveraendert bleibt.

const DEFAULT_DEBOUNCE_INPUT = 500;
const DEFAULT_DEBOUNCE_TEXTAREA = 1000;
const POPOVER_MAX_REPLACEMENTS = 5;
const POPOVER_MAX_MATCHES = 12;

function _isSpelling(m) {
  const id = m?.rule?.id || '';
  const cat = m?.rule?.category?.id || '';
  return id.includes('SPELL') || cat === 'TYPOS';
}

function _matchId(m) {
  return `${m.offset}:${m.length}:${m.rule?.id || ''}`;
}

function _extractWord(text, m) {
  const w = (text || '').substr(m.offset || 0, m.length || 0);
  const trimmed = (w || '').trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : '';
}

function _makeIcon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  use.setAttributeNS(XLINK, 'xlink:href', `/icons.svg#${name}`);
  svg.appendChild(use);
  return svg;
}

export function createFormFieldSpellcheck({
  el,
  getBookLocale,
  getBookId,
  isEnabled = () => true,
  i18n = (k) => k,
}) {
  if (!el) throw new Error('form-spellcheck: el required');
  const isTextarea = el.tagName === 'TEXTAREA';
  const debounceMs = isTextarea ? DEFAULT_DEBOUNCE_TEXTAREA : DEFAULT_DEBOUNCE_INPUT;

  let badge = null;
  let fieldWrap = null;
  let popover = null;
  let docClick = null;
  let matches = [];           // filtered: spelling only
  const ignored = new Set();
  let abortCtrl = null;
  let debounceTimer = null;
  let seq = 0;
  let attached = false;
  let lastValueSnapshot = '';

  function _ensureBadge() {
    if (badge) return badge;
    badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'lt-badge lt-badge--form';
    badge.setAttribute('data-state', 'idle');
    badge.setAttribute('aria-live', 'polite');
    badge.addEventListener('mousedown', (ev) => ev.preventDefault());
    badge.addEventListener('click', _onBadgeClick);
    _insertBadge();
    return badge;
  }

  function _insertBadge() {
    if (!el.parentNode) return;
    let wrap = el.parentNode;
    const wrapped = wrap.classList && wrap.classList.contains('lt-field-wrap');
    if (!wrapped) {
      wrap = document.createElement('span');
      wrap.className = isTextarea ? 'lt-field-wrap lt-field-wrap--textarea' : 'lt-field-wrap';
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);
    }
    if (badge.parentNode !== wrap) wrap.appendChild(badge);
    fieldWrap = wrap;
  }

  function _removeBadge() {
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    badge = null;
    // Unwrap field — move it back to grandparent at the wrap's position.
    if (fieldWrap && fieldWrap.parentNode && fieldWrap.classList.contains('lt-field-wrap')) {
      const parent = fieldWrap.parentNode;
      while (fieldWrap.firstChild) parent.insertBefore(fieldWrap.firstChild, fieldWrap);
      parent.removeChild(fieldWrap);
    }
    fieldWrap = null;
  }

  function _updateBadge(state, opts = {}) {
    _ensureBadge();
    badge.setAttribute('data-state', state);
    badge.replaceChildren();
    let icon = 'check';
    let label = '';
    let title = '';
    if (state === 'loading') { icon = 'loader'; title = i18n('spellcheck.status.active'); }
    else if (state === 'matches') {
      icon = 'alert-triangle';
      const n = Number(opts.count || 0);
      label = String(n);
      title = i18n('spellcheck.status.matches').replace('{n}', String(n));
    }
    else if (state === 'clean') { icon = 'check'; title = i18n('spellcheck.status.no_matches'); }
    else if (state === 'error') { icon = 'alert-triangle'; title = i18n('spellcheck.status.error'); }
    else if (state === 'disabled') { icon = 'x'; title = i18n('spellcheck.status.disabled'); }
    else { /* idle */ title = ''; }
    if (title) {
      badge.setAttribute('data-tip', title);
      badge.setAttribute('aria-label', title);
    } else {
      badge.removeAttribute('data-tip');
      badge.removeAttribute('aria-label');
    }
    const iconWrap = document.createElement('span');
    iconWrap.className = 'lt-badge__icon';
    iconWrap.appendChild(_makeIcon(icon));
    badge.appendChild(iconWrap);
    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'lt-badge__label';
      lbl.textContent = label;
      badge.appendChild(lbl);
    }
    // Idle/clean: Badge nur sichtbar wenn Feld fokussiert oder Hover —
    // weniger visuelles Rauschen in Listen (Buchorganizer).
    badge.classList.toggle('lt-badge--quiet', state === 'idle' || state === 'clean' || state === 'disabled');
  }

  function _onBadgeClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (popover) { _closePopover(); return; }
    if (!matches.length) return;
    _openPopover();
  }

  function _closePopover() {
    if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
    popover = null;
    if (docClick) {
      document.removeEventListener('mousedown', docClick, true);
      docClick = null;
    }
  }

  function _openPopover() {
    _closePopover();
    popover = document.createElement('div');
    popover.className = 'lt-popover lt-popover--form';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('data-editor', 'form');

    const visible = matches.filter((m) => !ignored.has(_matchId(m))).slice(0, POPOVER_MAX_MATCHES);
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'lt-popover__empty';
      empty.textContent = i18n('spellcheck.popover.no_suggestions');
      popover.appendChild(empty);
    }
    for (const m of visible) {
      popover.appendChild(_renderMatchRow(m));
    }
    document.body.appendChild(popover);
    _positionPopover();
    // Outside-Click schliesst. setTimeout: aktueller Click landet sonst gleich
    // im outside-Handler.
    setTimeout(() => {
      docClick = (ev) => {
        if (!popover) return;
        if (popover.contains(ev.target)) return;
        if (badge && badge.contains(ev.target)) return;
        _closePopover();
      };
      document.addEventListener('mousedown', docClick, true);
    }, 0);
  }

  function _renderMatchRow(m) {
    const row = document.createElement('div');
    row.className = 'lt-popover__match';
    const word = _extractWord(el.value || '', m);
    const head = document.createElement('div');
    head.className = 'lt-popover__match-head';
    const wordEl = document.createElement('span');
    wordEl.className = 'lt-popover__match-word';
    wordEl.textContent = word || (m.shortMessage || '');
    head.appendChild(wordEl);
    if (m.message && m.message !== m.shortMessage) {
      const msg = document.createElement('span');
      msg.className = 'lt-popover__match-msg';
      msg.textContent = m.message;
      head.appendChild(msg);
    }
    row.appendChild(head);

    const reps = Array.isArray(m.replacements) ? m.replacements.slice(0, POPOVER_MAX_REPLACEMENTS) : [];
    if (reps.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'lt-popover__empty';
      empty.textContent = i18n('spellcheck.popover.no_suggestions');
      row.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'lt-popover__replacements';
      for (const r of reps) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lt-popover__replacement';
        btn.textContent = r.value || '';
        btn.addEventListener('mousedown', (ev) => ev.preventDefault());
        btn.addEventListener('click', () => _applyReplacement(m, r.value || ''));
        list.appendChild(btn);
      }
      row.appendChild(list);
    }

    const actions = document.createElement('div');
    actions.className = 'lt-popover__row-actions';
    const ignoreBtn = document.createElement('button');
    ignoreBtn.type = 'button';
    ignoreBtn.className = 'lt-popover__ignore';
    ignoreBtn.textContent = i18n('spellcheck.popover.ignore');
    ignoreBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
    ignoreBtn.addEventListener('click', () => {
      ignored.add(_matchId(m));
      _rerenderPopover();
    });
    actions.appendChild(ignoreBtn);

    if (word) {
      const dictBtn = document.createElement('button');
      dictBtn.type = 'button';
      dictBtn.className = 'lt-popover__dict';
      dictBtn.textContent = i18n('spellcheck.popover.add_to_dict');
      dictBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
      dictBtn.addEventListener('click', async () => {
        dictBtn.disabled = true;
        try {
          const rawLang = getBookLocale ? getBookLocale() : '*';
          const lang = (!rawLang || rawLang === 'auto') ? '*' : rawLang;
          const resp = await fetch('/dictionary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ word, bookId: 0, lang }),
            credentials: 'same-origin',
          });
          if (resp.ok) {
            ignored.add(_matchId(m));
            _rerenderPopover();
            _scheduleCheck();
          } else {
            dictBtn.disabled = false;
          }
        } catch { dictBtn.disabled = false; }
      });
      actions.appendChild(dictBtn);
    }
    row.appendChild(actions);
    return row;
  }

  function _rerenderPopover() {
    if (!popover) return;
    _openPopover();
  }

  function _positionPopover() {
    if (!popover) return;
    const rect = el.getBoundingClientRect();
    const padding = 8;
    popover.style.position = 'absolute';
    let top = rect.bottom + window.scrollY + 4;
    let left = rect.left + window.scrollX;
    const pr = popover.getBoundingClientRect();
    const vw = window.innerWidth;
    if (left + pr.width + padding > vw) {
      left = Math.max(padding, vw - pr.width - padding);
    }
    // Wenn unterhalb kein Platz, oberhalb anzeigen.
    if (rect.bottom + pr.height + padding > window.innerHeight) {
      top = rect.top + window.scrollY - pr.height - 4;
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  function _applyReplacement(m, text) {
    const off = Number(m.offset || 0);
    const len = Number(m.length || 0);
    const value = el.value || '';
    // Safety: Snapshot-Drift (User hat zwischen Check und Klick getippt) →
    // wenn das matchende Wort dort nicht mehr steht, ueberspringen.
    const word = value.substr(off, len);
    const expected = _extractWord(lastValueSnapshot, m);
    if (expected && word.trim() !== expected.trim()) {
      _closePopover();
      _scheduleCheck();
      return;
    }
    // setRangeText respektiert Undo-Stack des Form-Felds.
    try {
      el.focus({ preventScroll: true });
      el.setSelectionRange(off, off + len);
      if (typeof el.setRangeText === 'function') {
        el.setRangeText(text, off, off + len, 'end');
      } else {
        el.value = value.slice(0, off) + text + value.slice(off + len);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch { /* swallowed; next check rebuilds */ }
    _closePopover();
    _scheduleCheck();
  }

  function _scheduleCheck() {
    if (!attached) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => _runCheck(), debounceMs);
  }

  async function _runCheck() {
    if (!attached) return;
    if (!isEnabled()) { _updateBadge('disabled'); return; }
    const text = el.value || '';
    if (!text.trim()) {
      matches = [];
      _updateBadge('idle');
      _closePopover();
      return;
    }
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const myReq = ++seq;
    lastValueSnapshot = text;
    const language = getBookLocale ? getBookLocale() : 'auto';
    const bookId = getBookId ? getBookId() : null;
    _updateBadge('loading');
    try {
      const resp = await fetch('/languagetool/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language, bookId }),
        signal: abortCtrl.signal,
        credentials: 'same-origin',
      });
      if (resp.status === 404) { matches = []; _updateBadge('disabled'); return; }
      if (!resp.ok) { _updateBadge('error'); return; }
      const json = await resp.json();
      if (myReq !== seq) return;
      // Snapshot-Check: User hat waehrend Flight getippt → Match-Offsets stale.
      if ((el.value || '') !== lastValueSnapshot) return;
      const all = Array.isArray(json.matches) ? json.matches : [];
      matches = all.filter(_isSpelling);
      const visibleCount = matches.filter((m) => !ignored.has(_matchId(m))).length;
      if (visibleCount === 0) {
        _updateBadge('clean');
        _closePopover();
      } else {
        _updateBadge('matches', { count: visibleCount });
        if (popover) _rerenderPopover();
      }
    } catch (err) {
      if (err && err.name !== 'AbortError') _updateBadge('error');
    }
  }

  function _onInput() { _scheduleCheck(); }

  function attach() {
    if (attached) return;
    attached = true;
    _ensureBadge();
    el.addEventListener('input', _onInput);
    _runCheck();
  }

  function detach() {
    if (!attached) return;
    attached = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    el.removeEventListener('input', _onInput);
    _closePopover();
    _removeBadge();
    matches = [];
    ignored.clear();
  }

  function refresh() { _scheduleCheck(); }

  return { attach, detach, refresh, isAttached: () => attached, getElement: () => el };
}
