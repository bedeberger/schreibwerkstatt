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
//   fetch /languagetool/check -> _renderMatches() registriert DOM-Ranges in
//   CSS.highlights (typo/grammar/style). Browser rendert die wavy-Underline
//   nativ via ::highlight()-Regeln — keine DOM-Spans pro Match, kein
//   JS-Reposition bei Scroll. Ranges aktualisieren sich beim Editieren
//   automatisch via DOM-Mutation; bei strukturellen Aenderungen invalidiert
//   der naechste Check.
//
// Popover wird ins Scroll-Layer eingehaengt (Scroll-Container bei
// Notebook/Focus, body bei Bucheditor mit Window-Scroll). Position absolute
// in Scroll-Content-Koordinaten — laeuft beim Scrollen kompositiv mit, ohne
// Scroll-Listener.
//
// Badge bleibt am Editor-Eck (Sibling zu root, gleiches offsetParent) und
// zeigt Status (loading/clean/matches/error/extension/disabled).
//
// LT-Browser-Extension-Detection pausiert Highlights solange Extension-Marker
// im DOM existieren.

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

const HL_TYPO    = 'lt-typo';
const HL_GRAMMAR = 'lt-grammar';
const HL_STYLE   = 'lt-style';
const HL_KEYS    = [HL_TYPO, HL_GRAMMAR, HL_STYLE];

const supportsHighlightApi = typeof CSS !== 'undefined'
  && CSS.highlights
  && typeof Highlight !== 'undefined';

export function createSpellcheckController({
  root,
  scrollContainer,
  getHtml,
  onApplyReplacement,
  editorKind = 'notebook',
  getBookLocale,
  getBookId,
  getPageId,
  isEnabled = () => true,
  i18n = (key) => key,
}) {
  if (!root) throw new Error('spellcheck: root required');

  // Per-Instance Highlight-Buckets. CSS.highlights ist global; pro Instanz
  // wird ein frischer Highlight registriert und beim detach() geleert.
  const highlights = { [HL_TYPO]: null, [HL_GRAMMAR]: null, [HL_STYLE]: null };
  const squiggles = new Map(); // matchId -> { match, range, category }
  const ignored = new Set();   // matchId session-only

  let popover = null;
  let popoverHost = null;
  let popoverAnchorRange = null;

  let badge = null;
  let badgeState = 'idle';

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

  function _extractMatchedWord(m) {
    const ctx = m?.context;
    if (!ctx || typeof ctx.text !== 'string') return '';
    const word = ctx.text.substr(ctx.offset || 0, ctx.length || 0).trim();
    return word.length > 0 && word.length <= 80 ? word : '';
  }

  function _categoryKey(match) {
    const id = match.rule?.id || '';
    const cat = match.rule?.category?.id || '';
    if (id.includes('SPELL') || cat === 'TYPOS') return HL_TYPO;
    if (cat === 'STYLE' || cat === 'REDUNDANCY' || cat === 'TYPOGRAPHY') return HL_STYLE;
    return HL_GRAMMAR;
  }

  function _badgeClassFor(match) {
    const k = _categoryKey(match);
    if (k === HL_TYPO) return 'lt-squiggle--typo';
    if (k === HL_STYLE) return 'lt-squiggle--style';
    return 'lt-squiggle--grammar';
  }

  function _ensureHighlights() {
    if (!supportsHighlightApi) return false;
    for (const key of HL_KEYS) {
      if (!highlights[key]) {
        highlights[key] = new Highlight();
        CSS.highlights.set(key, highlights[key]);
      }
    }
    return true;
  }

  function _clearHighlights() {
    for (const key of HL_KEYS) {
      if (highlights[key]) highlights[key].clear();
    }
  }

  // ─── Badge ───────────────────────────────────────────────────────────────

  function _ensureBadge() {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.className = 'lt-badge';
    badge.setAttribute('data-editor', editorKind);
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    root.parentNode?.insertBefore(badge, root.nextSibling);
    _syncBadgePosition();
    return badge;
  }

  function _syncBadgePosition() {
    if (!badge || !root) return;
    badge.style.top  = `${root.offsetTop + 6}px`;
    badge.style.left = `${root.offsetLeft + root.offsetWidth - 8}px`;
  }

  function _removeBadge() {
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    badge = null;
    badgeState = 'idle';
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

  function _updateBadge(state, opts = {}) {
    badgeState = state;
    _ensureBadge();
    _syncBadgePosition();
    badge.setAttribute('data-state', state);
    let icon = 'check';
    let label = '';
    let title = '';
    if (state === 'extension') {
      icon = 'alert-triangle';
      title = i18n('spellcheck.extension_conflict.title');
    } else if (state === 'error') {
      icon = 'alert-triangle';
      title = i18n('spellcheck.status.error');
    } else if (state === 'loading') {
      icon = 'loader';
      title = i18n('spellcheck.status.active');
    } else if (state === 'matches') {
      icon = 'alert-triangle';
      const n = Number(opts.count || 0);
      label = String(n);
      title = i18n('spellcheck.status.matches').replace('{n}', String(n));
    } else if (state === 'clean') {
      icon = 'check';
      title = i18n('spellcheck.status.no_matches');
    } else if (state === 'disabled') {
      icon = 'x';
      title = i18n('spellcheck.status.disabled');
    }
    badge.setAttribute('data-tip', title);
    badge.setAttribute('aria-label', title);
    badge.replaceChildren();
    const iconWrap = document.createElement('span');
    iconWrap.className = 'lt-badge__icon';
    iconWrap.appendChild(_makeIcon(icon));
    badge.appendChild(iconWrap);
    if (label) {
      const labelSpan = document.createElement('span');
      labelSpan.className = 'lt-badge__label';
      labelSpan.textContent = label;
      badge.appendChild(labelSpan);
    }
  }

  // ─── Popover ─────────────────────────────────────────────────────────────

  function _closePopover() {
    if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
    popover = null;
    popoverHost = null;
    popoverAnchorRange = null;
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
      _renderMatches([]);
      _updateBadge('clean');
      return;
    }
    lastHtmlSnapshot = getHtml ? getHtml() : root.innerHTML;
    const language = getBookLocale ? getBookLocale() : 'auto';
    const bookId = getBookId ? getBookId() : null;
    const pageId = getPageId ? getPageId() : null;

    _updateBadge('loading');

    try {
      const resp = await fetch('/languagetool/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: table.text, language, bookId, pageId }),
        signal: abortCtrl.signal,
        credentials: 'same-origin',
      });
      if (resp.status === 404) {
        _renderMatches([]);
        _updateBadge('disabled');
        return;
      }
      if (!resp.ok) { _updateBadge('error'); return; }
      const json = await resp.json();
      if (myReq !== seq) return; // stale
      const currentSnap = getHtml ? getHtml() : root.innerHTML;
      if (currentSnap !== lastHtmlSnapshot) return; // DOM mutated mid-flight
      const matches = Array.isArray(json.matches) ? json.matches : [];
      _renderMatches(matches, table);
      const visibleCount = matches.filter((m) => !ignored.has(_matchId(m))).length;
      _updateBadge(visibleCount ? 'matches' : 'clean', { count: visibleCount });
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        _updateBadge('error');
        return;
      }
    }
  }

  function _renderMatches(matches, table) {
    if (!_ensureHighlights()) return;
    _clearHighlights();
    squiggles.clear();
    if (!table) return;
    for (const m of matches) {
      const id = _matchId(m);
      if (ignored.has(id)) continue;
      const range = rangeFromOffset(table, m.offset, m.length);
      if (!range) continue;
      const cat = _categoryKey(m);
      highlights[cat].add(range);
      squiggles.set(id, { match: m, range, category: cat });
    }
  }

  // ─── Click-Hit-Test ──────────────────────────────────────────────────────
  // User klickt in Editor-Text. Caret-Position via caretPositionFromPoint
  // (Standard) bzw. caretRangeFromPoint (Webkit-Fallback). Match-Lookup ueber
  // gespeicherte Ranges (kein DOM-Element pro Squiggle mehr).

  function _caretFromPoint(x, y) {
    if (typeof document.caretPositionFromPoint === 'function') {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) return { node: pos.offsetNode, offset: pos.offset };
    }
    if (typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }

  function _findMatchAtCaret(node, offset) {
    if (!node) return null;
    const probe = document.createRange();
    try {
      probe.setStart(node, offset);
      probe.collapse(true);
    } catch { return null; }
    for (const [id, entry] of squiggles) {
      try {
        // probe innerhalb entry.range?  entry.start <= probe.start < entry.end.
        // START_TO_START: entry.range.start vs probe.start (<=0 → entry start <= probe).
        // START_TO_END:   entry.range.end   vs probe.start (>0  → entry end  >  probe).
        const startCmp = entry.range.compareBoundaryPoints(Range.START_TO_START, probe);
        const endCmp   = entry.range.compareBoundaryPoints(Range.START_TO_END, probe);
        if (startCmp <= 0 && endCmp > 0) return id;
      } catch { /* range invalid */ }
    }
    return null;
  }

  function _onRootMousedown(ev) {
    if (ev.button !== 0) return;
    if (popover && popover.contains(ev.target)) return;
    if (!squiggles.size) return;
    const pt = _caretFromPoint(ev.clientX, ev.clientY);
    if (!pt) return;
    const id = _findMatchAtCaret(pt.node, pt.offset);
    if (!id) return;
    ev.preventDefault();
    ev.stopPropagation();
    _openPopover(id);
  }

  function _openPopover(matchId) {
    _closePopover();
    const entry = squiggles.get(matchId);
    if (!entry) return;
    const m = entry.match;
    popoverAnchorRange = entry.range;

    popover = document.createElement('div');
    popover.className = 'lt-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('contenteditable', 'false');
    popover.setAttribute('data-editor', editorKind);

    const header = document.createElement('div');
    header.className = 'lt-popover__header';
    const catBadge = document.createElement('span');
    catBadge.className = `lt-popover__badge ${_badgeClassFor(m)}`;
    catBadge.textContent = m.rule?.category?.name || m.shortMessage || '';
    header.appendChild(catBadge);
    if (m.shortMessage && m.shortMessage !== catBadge.textContent) {
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
        // mousedown.preventDefault: verhindert dass Editor-Selection beim Klick
        // verschoben wird (Buttons sitzen innerhalb contenteditable-Subtree).
        btn.addEventListener('mousedown', (ev) => ev.preventDefault());
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
    ignoreBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
    ignoreBtn.addEventListener('click', () => {
      ignored.add(matchId);
      const entry2 = squiggles.get(matchId);
      if (entry2) {
        highlights[entry2.category]?.delete(entry2.range);
        squiggles.delete(matchId);
      }
      _closePopover();
    });
    footer.appendChild(ignoreBtn);

    const isSpell = (m.rule?.id || '').includes('SPELL') || (m.rule?.category?.id || '') === 'TYPOS';
    if (isSpell) {
      const word = _extractMatchedWord(m);
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
              const entry3 = squiggles.get(matchId);
              if (entry3) {
                highlights[entry3.category]?.delete(entry3.range);
                squiggles.delete(matchId);
              }
              _closePopover();
              _scheduleCheck();
            } else {
              dictBtn.disabled = false;
            }
          } catch { dictBtn.disabled = false; }
        });
        footer.appendChild(dictBtn);
      }
    }

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

    _mountPopover();

    // Outside-Click schliesst. setTimeout: aktueller mousedown soll nicht
    // gleich wieder schliessen.
    setTimeout(() => {
      const onDocClick = (ev) => {
        if (!popover) {
          document.removeEventListener('mousedown', onDocClick, true);
          return;
        }
        if (popover.contains(ev.target)) return;
        _closePopover();
        document.removeEventListener('mousedown', onDocClick, true);
      };
      document.addEventListener('mousedown', onDocClick, true);
    }, 0);
  }

  function _mountPopover() {
    if (!popover || !popoverAnchorRange) return;
    const anchorRect = popoverAnchorRange.getBoundingClientRect();

    // Strategie: Popover wird ins Scroll-Layer eingehaengt, damit Scroll den
    // Popover physisch mitnimmt (kein JS-Reposition, kein 1-Frame-Trail).
    //
    //   - scrollEl == window/scrollingElement: Popover an body, position
    //     absolute, document-Koordinaten (anchorRect + window.scrollX/Y).
    //     Window-Scroll bewegt body-Kinder nativ.
    //   - scrollEl interner Container (Notebook=.page-content-view--editing,
    //     Focus=.focus-editor__content, beide gleichzeitig contenteditable):
    //     Popover als Kind dort einhaengen, position absolute in
    //     Scroll-Content-Koordinaten. Popover ist contenteditable="false"
    //     und damit eine nicht-editbare Insel; Caret/Selection greift nicht
    //     hinein. MutationObserver filtert popover-eigene Mutationen heraus
    //     (sonst triggert das Anhaengen einen Re-Check, der die Squiggles
    //     wegnimmt bevor der User klicken kann).
    const useScrollerHost = scrollEl
      && scrollEl !== window
      && scrollEl !== document.scrollingElement
      && scrollEl !== document.documentElement
      && scrollEl !== document.body;

    if (useScrollerHost) {
      // Offset-Parent fuer absolute child sicherstellen.
      if (getComputedStyle(scrollEl).position === 'static') {
        scrollEl.style.position = 'relative';
      }
      popoverHost = scrollEl;
      popoverHost.appendChild(popover);
      _positionInsideScroller(popover, anchorRect, popoverHost);
    } else {
      popoverHost = document.body;
      popoverHost.appendChild(popover);
      _positionInBodyAbsolute(popover, anchorRect);
    }
  }

  function _positionInsideScroller(el, anchorRect, host) {
    const hostRect = host.getBoundingClientRect();
    const padding = 8;
    const pr = el.getBoundingClientRect();
    // Vertical: clamp/flip gegen Viewport.
    let viewportTop = anchorRect.bottom + 4;
    if (viewportTop + pr.height + padding > window.innerHeight) {
      viewportTop = anchorRect.top - pr.height - 4;
    }
    if (viewportTop < padding) viewportTop = padding;
    // Horizontal: clamp gegen Host-Sichtbereich (Popover bleibt im Scroll-Slot).
    let viewportLeft = anchorRect.left;
    const hostRight = hostRect.left + host.clientWidth;
    if (viewportLeft + pr.width + padding > hostRight) {
      viewportLeft = Math.max(hostRect.left + padding, hostRight - pr.width - padding);
    }
    if (viewportLeft < hostRect.left + padding) viewportLeft = hostRect.left + padding;
    el.style.left = `${viewportLeft - hostRect.left + host.scrollLeft}px`;
    el.style.top  = `${viewportTop  - hostRect.top  + host.scrollTop}px`;
  }

  function _positionInBodyAbsolute(el, anchorRect) {
    const padding = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pr = el.getBoundingClientRect();
    let viewportLeft = anchorRect.left;
    let viewportTop = anchorRect.bottom + 4;
    if (viewportLeft + pr.width + padding > vw) {
      viewportLeft = Math.max(padding, vw - pr.width - padding);
    }
    if (viewportTop + pr.height + padding > vh) {
      viewportTop = anchorRect.top - pr.height - 4;
    }
    if (viewportTop < padding) viewportTop = padding;
    el.style.left = `${viewportLeft + window.scrollX}px`;
    el.style.top  = `${viewportTop  + window.scrollY}px`;
  }

  function _remountPopover() {
    if (!popover || !popoverAnchorRange || !popoverHost) return;
    const anchorRect = popoverAnchorRange.getBoundingClientRect();
    if (popoverHost === document.body) {
      _positionInBodyAbsolute(popover, anchorRect);
    } else {
      _positionInsideScroller(popover, anchorRect, popoverHost);
    }
  }

  function _applyReplacement(matchId, text) {
    const entry = squiggles.get(matchId);
    if (!entry) return;
    _closePopover();
    if (typeof onApplyReplacement === 'function') {
      try { onApplyReplacement(entry.range, text); }
      catch { /* host-side errors swallowed; next check rebuilds */ }
    }
    highlights[entry.category]?.delete(entry.range);
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
      _clearHighlights();
      squiggles.clear();
      _closePopover();
      _updateBadge('extension');
      window.dispatchEvent(new CustomEvent('languagetool:extension-detected'));
    } else if (!present && extensionDetected) {
      extensionDetected = false;
      window.dispatchEvent(new CustomEvent('languagetool:extension-cleared'));
      _scheduleCheck();
    }
  }

  // MutationObserver-Filter: ignoriere Mutationen, die nur das Popover-Subtree
  // betreffen (Popover ist contenteditable="false"-Insel im Editor-Root). Sonst
  // triggert das Anhaengen/Entfernen des Popover einen Re-Check, der die
  // Squiggles vor dem User-Klick verwirft.
  function _isPopoverOnlyMutation(m) {
    if (!popover) return false;
    if (m.type === 'characterData' || m.type === 'attributes') {
      return popover.contains(m.target);
    }
    if (m.type === 'childList') {
      const added = m.addedNodes ? Array.from(m.addedNodes) : [];
      const removed = m.removedNodes ? Array.from(m.removedNodes) : [];
      if (added.length === 0 && removed.length === 0) return false;
      const allSelf = (n) => n === popover || popover.contains(n);
      return added.every(allSelf) && removed.every(allSelf);
    }
    return false;
  }

  function attach() {
    if (attached) return;
    attached = true;

    if (!supportsHighlightApi) {
      // Stiller Skip — App laeuft, nur ohne LT-Markierungen.
      _updateBadge('disabled');
      return;
    }

    _ensureHighlights();
    _ensureBadge();

    mutationObs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (_isPopoverOnlyMutation(m)) continue;
        _scheduleCheck();
        return;
      }
    });
    mutationObs.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener('input', _scheduleCheck);
    root.addEventListener('mousedown', _onRootMousedown, true);

    if (typeof ResizeObserver !== 'undefined') {
      // Resize verschiebt Anker — Popover neu positionieren + Badge an Ecke
      // halten. Squiggles selbst aktualisiert der Browser via Highlight-Range
      // automatisch.
      resizeObs = new ResizeObserver(() => {
        _syncBadgePosition();
        _remountPopover();
      });
      resizeObs.observe(root);
    }
    scrollEl = scrollContainer || _findScrollParent(root);

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
    root.removeEventListener('mousedown', _onRootMousedown, true);
    scrollEl = null;
    _closePopover();
    _clearHighlights();
    squiggles.clear();
    _removeBadge();
  }

  function refresh() {
    _scheduleCheck();
  }

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
