// Spellcheck-Controller — editor-agnostisch. Eine Instanz pro aktivem Editor.
//
// Mounting durch Editor-Modul:
//   const ctl = createSpellcheckController({ root, scrollContainer, getHtml,
//                                            onApplyReplacement, editorKind,
//                                            getBookLocale, isEnabled });
//   ctl.attach();   // bei Edit-Mode-Enter / Focus-Enter / Block-Activate
//   ctl.detach();   // bei Exit / Block-Deactivate
//
// Pipeline pro attach:
//   input/MutationObserver -> debounce 1500ms -> _runCheck() ->
//   fetch /languagetool/check -> _renderOverlay() via mapping.js.
// Re-Position via ResizeObserver + scroll-Listener; kein Re-Fetch dabei.
//
// DOM-Mutation invalidiert pending Check (requestId-Counter + HTML-Snapshot).
// LT-Browser-Extension-Detection pausiert das Overlay solange Marker am body
// existieren.

import { escHtml } from '../../utils.js';
import { buildOffsetTable, rangeFromOffset } from './mapping.js';

const DEBOUNCE_MS = 1500;
const POPOVER_MAX_REPLACEMENTS = 5;
const EXTENSION_SELECTORS = [
  'lt-div',
  'lt-highlighter',
  '[class*="lt-toolbar"]',
  '[class*="languagetool"]',
];

export function createSpellcheckController({
  root,
  scrollContainer,
  getHtml,
  onApplyReplacement,
  editorKind = 'notebook',
  getBookLocale,
  getBookId,
  isEnabled = () => true,
  i18n = (key) => key,
}) {
  if (!root) throw new Error('spellcheck: root required');

  // State (Closure).
  let overlay = null;
  let popover = null;
  const squiggles = new Map(); // matchId -> { match, range, els: [], rectBoxes: [] }
  const ignored = new Set();   // matchId session-only

  let mutationObs = null;
  let resizeObs = null;
  let scrollEl = null;
  let extensionObs = null;
  let extensionDetected = false;
  let attached = false;

  let debounceTimer = null;
  let abortCtrl = null;
  let seq = 0;
  let lastHtmlSnapshot = '';

  function _matchId(m) {
    // LT liefert keine stabile ID -> aus offset+length+ruleId zusammenbauen.
    return `${m.offset}:${m.length}:${m.rule?.id || ''}`;
  }

  function _categoryClass(match) {
    const id = match.rule?.id || '';
    const cat = match.rule?.category?.id || '';
    if (id.includes('SPELL') || cat === 'TYPOS') return 'lt-squiggle--typo';
    if (cat === 'STYLE' || cat === 'REDUNDANCY' || cat === 'TYPOGRAPHY') return 'lt-squiggle--style';
    return 'lt-squiggle--grammar';
  }

  function _ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'lt-overlay';
    overlay.setAttribute('data-editor', editorKind);
    overlay.setAttribute('aria-hidden', 'true');
    // Sibling zum root, damit absolute Positionierung gegen denselben
    // offset-parent läuft. Root muss position:relative haben (CSS-Pflicht).
    root.parentNode?.insertBefore(overlay, root.nextSibling);
    return overlay;
  }

  function _removeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    squiggles.clear();
  }

  function _closePopover() {
    if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
    popover = null;
  }

  function _scheduleCheck() {
    if (!attached) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => _runCheck(), DEBOUNCE_MS);
  }

  async function _runCheck() {
    if (!attached || extensionDetected) return;
    if (!isEnabled()) return;
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    const myReq = ++seq;
    const table = buildOffsetTable(root);
    if (!table.text.trim()) {
      _renderMatches([], table);
      return;
    }
    lastHtmlSnapshot = getHtml ? getHtml() : root.innerHTML;
    const language = getBookLocale ? getBookLocale() : 'auto';
    const bookId = getBookId ? getBookId() : null;

    try {
      const resp = await fetch('/languagetool/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: table.text, language, bookId }),
        signal: abortCtrl.signal,
        credentials: 'same-origin',
      });
      if (resp.status === 404) {
        // Disabled — kein Retry.
        _renderMatches([], table);
        return;
      }
      if (!resp.ok) return;
      const json = await resp.json();
      if (myReq !== seq) return; // stale
      const currentSnap = getHtml ? getHtml() : root.innerHTML;
      if (currentSnap !== lastHtmlSnapshot) return; // DOM mutated mid-flight
      _renderMatches(Array.isArray(json.matches) ? json.matches : [], table);
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        // soft-fail: kein Editor-Bruch
        return;
      }
    }
  }

  function _renderMatches(matches, table) {
    _ensureOverlay();
    overlay.replaceChildren();
    squiggles.clear();
    for (const m of matches) {
      const id = _matchId(m);
      if (ignored.has(id)) continue;
      const range = rangeFromOffset(table, m.offset, m.length);
      if (!range) continue;
      const rects = Array.from(range.getClientRects());
      if (!rects.length) continue;
      const els = [];
      for (const rect of rects) {
        const span = document.createElement('span');
        span.className = `lt-squiggle ${_categoryClass(m)}`;
        span.setAttribute('data-match-id', id);
        span.setAttribute('role', 'button');
        span.setAttribute('tabindex', '0');
        span.setAttribute('data-tip', m.message || '');
        _positionSquiggle(span, rect);
        span.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          _openPopover(id, rect);
        });
        span.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            _openPopover(id, rect);
          }
        });
        overlay.appendChild(span);
        els.push(span);
      }
      squiggles.set(id, { match: m, range, els });
    }
  }

  function _positionSquiggle(span, rect) {
    const overlayRect = overlay.getBoundingClientRect();
    span.style.left = `${rect.left - overlayRect.left}px`;
    span.style.top = `${rect.top - overlayRect.top}px`;
    span.style.width = `${rect.width}px`;
    span.style.height = `${rect.height}px`;
  }

  function _reposition() {
    if (!attached || !overlay) return;
    for (const entry of squiggles.values()) {
      const rects = Array.from(entry.range.getClientRects());
      // Match Count? Wenn Anzahl Rects sich zu den Spans nicht deckt — kompletter Re-Render im naechsten Check.
      if (rects.length !== entry.els.length) {
        _scheduleCheck();
        return;
      }
      for (let i = 0; i < rects.length; i++) {
        _positionSquiggle(entry.els[i], rects[i]);
      }
    }
    if (popover && popover._anchorRect) {
      _positionPopoverNear(popover, popover._anchorRect);
    }
  }

  function _openPopover(matchId, anchorRect) {
    _closePopover();
    const entry = squiggles.get(matchId);
    if (!entry) return;
    const m = entry.match;

    popover = document.createElement('div');
    popover.className = 'lt-popover';
    popover.setAttribute('role', 'dialog');
    popover._anchorRect = anchorRect;

    const header = document.createElement('div');
    header.className = 'lt-popover__header';
    const badge = document.createElement('span');
    badge.className = `lt-popover__badge ${_categoryClass(m)}`;
    badge.textContent = m.rule?.category?.name || m.shortMessage || '';
    header.appendChild(badge);
    if (m.shortMessage && m.shortMessage !== badge.textContent) {
      const title = document.createElement('span');
      title.className = 'lt-popover__title';
      title.textContent = m.shortMessage;
      header.appendChild(title);
    }
    popover.appendChild(header);

    if (m.message) {
      const msg = document.createElement('p');
      msg.className = 'lt-popover__message';
      msg.textContent = m.message;
      popover.appendChild(msg);
    }

    const replacements = Array.isArray(m.replacements) ? m.replacements.slice(0, POPOVER_MAX_REPLACEMENTS) : [];
    if (replacements.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'lt-popover__empty';
      empty.textContent = i18n('spellcheck.popover.no_suggestions');
      popover.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'lt-popover__replacements';
      for (const r of replacements) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lt-popover__replacement';
        btn.textContent = r.value || '';
        btn.addEventListener('click', () => _applyReplacement(matchId, r.value || ''));
        list.appendChild(btn);
      }
      popover.appendChild(list);
    }

    const footer = document.createElement('div');
    footer.className = 'lt-popover__footer';
    const ignoreBtn = document.createElement('button');
    ignoreBtn.type = 'button';
    ignoreBtn.className = 'lt-popover__ignore';
    ignoreBtn.textContent = i18n('spellcheck.popover.ignore');
    ignoreBtn.addEventListener('click', () => {
      ignored.add(matchId);
      _closePopover();
      // re-render via current matches: einfacher: triggert _scheduleCheck nicht,
      // sondern entfernt sofort die Spans.
      const entry2 = squiggles.get(matchId);
      if (entry2) {
        for (const el of entry2.els) el.remove();
        squiggles.delete(matchId);
      }
    });
    footer.appendChild(ignoreBtn);

    const urlInfo = Array.isArray(m.rule?.urls) && m.rule.urls[0]?.value;
    if (urlInfo) {
      const link = document.createElement('a');
      link.href = urlInfo;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'lt-popover__info';
      link.textContent = i18n('spellcheck.popover.rule_info');
      footer.appendChild(link);
    }
    popover.appendChild(footer);

    document.body.appendChild(popover);
    _positionPopoverNear(popover, anchorRect);

    // Outside-Click schliesst.
    setTimeout(() => {
      const onDocClick = (ev) => {
        if (!popover) return;
        if (popover.contains(ev.target)) return;
        _closePopover();
        document.removeEventListener('mousedown', onDocClick, true);
      };
      document.addEventListener('mousedown', onDocClick, true);
    }, 0);
  }

  function _positionPopoverNear(el, anchorRect) {
    const padding = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pr = el.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + 4;
    if (left + pr.width + padding > vw) left = Math.max(padding, vw - pr.width - padding);
    if (top + pr.height + padding > vh) top = anchorRect.top - pr.height - 4;
    if (top < padding) top = padding;
    el.style.left = `${Math.max(padding, left)}px`;
    el.style.top = `${top}px`;
  }

  function _applyReplacement(matchId, text) {
    const entry = squiggles.get(matchId);
    if (!entry) return;
    _closePopover();
    if (typeof onApplyReplacement === 'function') {
      try { onApplyReplacement(entry.range, text); }
      catch { /* host-side errors swallowed; next check rebuilds */ }
    }
    // Spans entfernen; nächster Check baut frisch auf.
    for (const el of entry.els) el.remove();
    squiggles.delete(matchId);
    _scheduleCheck();
  }

  function _detectExtension() {
    for (const sel of EXTENSION_SELECTORS) {
      if (document.querySelector(sel)) return true;
    }
    return false;
  }

  function _updateExtensionState() {
    const present = _detectExtension();
    if (present && !extensionDetected) {
      extensionDetected = true;
      // Overlay leeren, App-Squiggles pausieren.
      if (overlay) overlay.replaceChildren();
      squiggles.clear();
      _closePopover();
      window.dispatchEvent(new CustomEvent('languagetool:extension-detected'));
    } else if (!present && extensionDetected) {
      extensionDetected = false;
      window.dispatchEvent(new CustomEvent('languagetool:extension-cleared'));
      _scheduleCheck();
    }
  }

  function attach() {
    if (attached) return;
    attached = true;
    _ensureOverlay();

    mutationObs = new MutationObserver(() => _scheduleCheck());
    mutationObs.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener('input', _scheduleCheck);

    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => _reposition());
      resizeObs.observe(root);
    }
    scrollEl = scrollContainer || _findScrollParent(root);
    if (scrollEl) scrollEl.addEventListener('scroll', _reposition, { passive: true });
    window.addEventListener('resize', _reposition);

    extensionObs = new MutationObserver(() => _updateExtensionState());
    extensionObs.observe(document.body, { childList: true, subtree: true, attributes: true });
    _updateExtensionState();

    // Sofort-Check beim Attach.
    _runCheck();
  }

  function detach() {
    if (!attached) return;
    attached = false;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (extensionObs) { extensionObs.disconnect(); extensionObs = null; }
    root.removeEventListener('input', _scheduleCheck);
    if (scrollEl) scrollEl.removeEventListener('scroll', _reposition);
    window.removeEventListener('resize', _reposition);
    scrollEl = null;
    _closePopover();
    _removeOverlay();
  }

  function refresh() {
    _scheduleCheck();
  }

  // Hilfen
  function _findScrollParent(el) {
    let p = el.parentElement;
    while (p) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(s.overflowY)) return p;
      p = p.parentElement;
    }
    return window;
  }

  return { attach, detach, refresh, isAttached: () => attached };
}

// XSS-Safety-Hinweis: alle User-/LT-Strings landen via textContent in der DOM
// (badge.textContent, btn.textContent, msg.textContent). Kein innerHTML mit
// LT-Response — escHtml ist als Import vorhanden, falls künftig eine
// hervorgehobene Kontext-Anzeige im Popover gewuenscht ist.
void escHtml;
