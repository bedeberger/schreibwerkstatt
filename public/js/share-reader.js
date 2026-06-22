'use strict';
// Reader-Frontend für geteilte Seiten/Kapitel (Beta-Leser-Feedback).
// Standalone, kein Alpine, kein SPA-Bundle. Progressive Enhancement über die
// SSR-View (public/share.html): ohne JS funktioniert die allgemeine Kommentar-
// Form weiter; mit JS kommen verankerte Inline-Anmerkungen + Threads dazu.
//
// Verankerung: jede Anmerkung haftet an einem Block via dessen data-bid
// (lib/html-clean.js#ensureBlockIds) + dem markierten Quote-Text. Beim Rendern
// wird re-verankert (Quote im Block suchen) — der Buchinhalt ist live, Offsets
// driften. Findet sich der Quote nicht mehr, bleibt der Thread gelistet, aber
// ohne Inline-Highlight ("Stelle geändert").

import { charOffset, locateRange, resolveCurrentQuote } from './share-anchor.js';

(function () {
  const cfgEl = document.getElementById('share-config');
  if (!cfgEl) return;
  let CFG;
  try { CFG = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
  const TOKEN = CFG.token;
  const I18N = CFG.i18n || {};
  if (!TOKEN) return;

  const t = (k) => I18N[k] || k;
  const article = document.getElementById('share-article');
  const list = document.querySelector('.share-comments__list');
  const emptyLi = document.querySelector('.share-comments__empty');
  const supportsHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  // ── Reader-Identität (persistent pro Browser) ──────────────────────────────
  const RT_KEY = 'sw_share_reader_token';
  const NAME_KEY = 'sw_share_reader_name';
  function readerToken() {
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
  function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
  function rememberName(n) { try { if (n) localStorage.setItem(NAME_KEY, n); } catch {} }
  const RT = readerToken();

  // ── State ──────────────────────────────────────────────────────────────────
  let comments = [];          // flache Liste (serverseitig serialisiert)
  const anchorRanges = [];    // { id, range } für Klick-Mapping
  let activeId = null;        // gerade fokussierter Thread

  // ── DOM-Helfer ───────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // jsdiff lazy laden (vendor, cache-first; nur wenn eine Stelle seit dem
  // Kommentar geändert wurde). Bewusst minimal statt page-revision-diff.js +
  // utils.js zu importieren — hält das anonyme Reader-Bundle schlank.
  let _diffPromise = null;
  function loadDiffLib() {
    if (typeof window.Diff !== 'undefined') return Promise.resolve(window.Diff);
    if (!_diffPromise) {
      _diffPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/diff-9.0.0.min.js';
        s.onload = () => resolve(window.Diff);
        s.onerror = reject;
        document.head.appendChild(s);
      }).catch((e) => { _diffPromise = null; throw e; });
    }
    return _diffPromise;
  }

  // Wort-Diff „Quote (damals) → aktueller Text" als del/ins-DOM-Knoten anhängen
  // (textContent → kein XSS). Gleiche .diff-add/.diff-del-Optik wie der Editor.
  function appendQuoteDiff(container, oldText, newText) {
    loadDiffLib().then((Diff) => {
      if (!Diff || typeof Diff.diffWords !== 'function') return;
      const wrap = el('div', 'share-thread__diff');
      for (const part of Diff.diffWords(oldText || '', newText || '')) {
        if (part.added) wrap.appendChild(el('ins', 'diff-add', part.value));
        else if (part.removed) wrap.appendChild(el('del', 'diff-del', part.value));
        else wrap.appendChild(el('span', null, part.value));
      }
      container.appendChild(wrap);
    }).catch(() => {});
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  // ── API ──────────────────────────────────────────────────────────────────────
  async function fetchThreads() {
    try {
      const res = await fetch(`/share/${encodeURIComponent(TOKEN)}/threads?rt=${encodeURIComponent(RT)}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) return;
      const j = await res.json();
      comments = Array.isArray(j.comments) ? j.comments : [];
      render();
    } catch {}
  }
  async function postComment(payload) {
    const res = await fetch(`/share/${encodeURIComponent(TOKEN)}/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, reader_token: RT }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(j.error_code || 'ERR');
      err.status = res.status;
      throw err;
    }
    return j.comment;
  }

  // ── Anker: Offset-Berechnung + Range-Rekonstruktion ──────────────────────────
  // charOffset/locateRange leben in share-anchor.js (SSoT, geteilt mit Owner-Karte).
  // Liefert {block, start, end, quote} aus der aktuellen Selektion oder null.
  function anchorFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    let elt = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const block = elt && elt.closest ? elt.closest('[data-bid]') : null;
    if (!block || !article.contains(block)) return null;
    const start = charOffset(block, range.startContainer, range.startOffset);
    const blockLen = block.textContent.length;
    let end = block.contains(range.endContainer)
      ? charOffset(block, range.endContainer, range.endOffset)
      : blockLen;
    if (end > blockLen) end = blockLen;
    if (end <= start) return null;
    const quote = block.textContent.slice(start, end);
    if (!quote.trim()) return null;
    return { bid: block.getAttribute('data-bid'), start, end, quote };
  }
  // Re-Anchoring (`locateRange(rootEl, anchor)`) kommt aus share-anchor.js (SSoT,
  // geteilt mit der Owner-Karte) — kein lokales Duplikat.

  // ── Highlights (CSS Custom Highlight API) ────────────────────────────────────
  function renderHighlights() {
    anchorRanges.length = 0;
    if (!supportsHighlight) return;
    const hl = new Highlight();
    const active = new Highlight();
    for (const c of comments) {
      if (c.parent_id || !c.anchor) continue;
      const range = locateRange(article, c.anchor);
      if (!range) { c._stale = true; continue; }
      c._stale = false;
      anchorRanges.push({ id: c.id, range });
      (c.id === activeId ? active : hl).add(range);
    }
    CSS.highlights.set('share-anchor', hl);
    CSS.highlights.set('share-anchor-active', active);
  }

  // ── Thread-Aufbau + Rendering ────────────────────────────────────────────────
  function buildTree() {
    const roots = [];
    const repliesByParent = {};
    for (const c of comments) {
      if (c.parent_id) (repliesByParent[c.parent_id] = repliesByParent[c.parent_id] || []).push(c);
    }
    for (const c of comments) {
      if (!c.parent_id) roots.push({ root: c, replies: repliesByParent[c.id] || [] });
    }
    return roots;
  }

  function authorName(c) {
    if (c.is_author) return t('author_badge');
    if (c.mine) return c.name ? `${c.name} (${t('you_badge')})` : t('you_badge');
    return c.name || t('anon');
  }

  function renderMeta(c) {
    const meta = el('div', 'share-comments__meta');
    const who = el('span', 'share-comment__who', authorName(c));
    if (c.is_author) who.classList.add('share-comment__who--author');
    meta.appendChild(who);
    meta.appendChild(el('span', null, ' · ' + fmtDate(c.created_at)));
    return meta;
  }

  function renderReplyForm(rootId) {
    const form = el('form', 'share-thread__reply');
    const ta = el('textarea');
    ta.rows = 2;
    ta.required = true;
    ta.maxLength = 4000;
    ta.placeholder = t('reply_placeholder');
    const actions = el('div', 'share-thread__reply-actions');
    const btn = el('button', null, t('send'));
    btn.type = 'submit';
    const status = el('span', 'share-comments__status');
    actions.appendChild(btn);
    actions.appendChild(status);
    form.appendChild(ta);
    form.appendChild(actions);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = (ta.value || '').trim();
      if (!body) { status.textContent = t('form_empty'); return; }
      btn.disabled = true;
      try {
        await postComment({ parent_id: rootId, body });
        await fetchThreads();
      } catch (e) {
        status.textContent = e.status === 429 ? t('comment_rate_limited') : t('form_error');
        btn.disabled = false;
      }
    });
    return form;
  }

  function renderThread(node) {
    const { root, replies } = node;
    const li = el('li', 'share-comments__item share-thread');
    li.dataset.commentId = root.id;
    if (root.resolved) li.classList.add('share-thread--resolved');
    if (root.id === activeId) li.classList.add('share-thread--active');

    // Anker-Zeile (Quote + Jump bzw. Stale-Hinweis).
    if (root.anchor) {
      const anchorRow = el('div', 'share-thread__anchor');
      const label = el('span', 'share-thread__anchor-label', t('quote_label'));
      anchorRow.appendChild(label);
      const quote = el('span', 'share-thread__quote', '„' + (root.anchor.quote || '') + '"');
      anchorRow.appendChild(quote);
      // resolveCurrentQuote trennt „Block weg" (gone) von „Text geändert"
      // (changed) — nur bei changed gibt es einen aktuellen Text zum Diffen.
      const res = resolveCurrentQuote(article, root.anchor);
      if (res.status === 'changed') {
        anchorRow.appendChild(el('span', 'share-thread__stale', t('anchor_changed')));
        li.appendChild(anchorRow);
        // Platzhalter direkt unter der Anker-Zeile, damit der async geladene
        // Diff an der richtigen Stelle landet (nicht ans li-Ende).
        const diffBox = el('div');
        li.appendChild(diffBox);
        appendQuoteDiff(diffBox, root.anchor.quote || '', res.currentText || '');
      } else if (root._stale || res.status === 'gone') {
        anchorRow.appendChild(el('span', 'share-thread__stale', t('anchor_stale')));
        li.appendChild(anchorRow);
      } else {
        anchorRow.classList.add('share-thread__anchor--clickable');
        anchorRow.setAttribute('role', 'button');
        anchorRow.tabIndex = 0;
        const jump = () => scrollToAnchor(root.id);
        anchorRow.addEventListener('click', jump);
        anchorRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } });
        li.appendChild(anchorRow);
      }
    }

    li.appendChild(renderMeta(root));
    if (root.resolved) {
      const badge = el('span', 'share-thread__resolved-badge', t('resolved_badge'));
      li.appendChild(badge);
    }
    li.appendChild(el('div', 'share-comments__body', root.body));

    // Antworten.
    if (replies.length) {
      const replyList = el('div', 'share-thread__replies');
      for (const r of replies) {
        const rEl = el('div', 'share-thread__reply-item');
        if (r.is_author) rEl.classList.add('share-thread__reply-item--author');
        rEl.appendChild(renderMeta(r));
        rEl.appendChild(el('div', 'share-comments__body', r.body));
        replyList.appendChild(rEl);
      }
      li.appendChild(replyList);
    }

    // Reader-Antwort (nur offene Threads).
    if (!root.resolved) li.appendChild(renderReplyForm(root.id));
    return li;
  }

  function render() {
    if (!list) return;
    if (emptyLi) emptyLi.remove();
    list.innerHTML = '';
    const tree = buildTree();
    if (!tree.length) {
      const li = el('li', 'share-comments__empty', t('threads_empty'));
      list.appendChild(li);
    } else {
      // Verankerte zuerst (Dokumentnähe), dann allgemeine — beide nach Zeit.
      tree.sort((a, b) => {
        const aa = a.root.anchor ? 0 : 1, bb = b.root.anchor ? 0 : 1;
        if (aa !== bb) return aa - bb;
        return new Date(a.root.created_at) - new Date(b.root.created_at);
      });
      for (const node of tree) list.appendChild(renderThread(node));
    }
    renderHighlights();
  }

  function scrollToAnchor(id) {
    setActive(id);
    const found = anchorRanges.find(a => a.id === id);
    if (found) {
      const rect = found.range.getBoundingClientRect();
      if (rect && rect.height) {
        window.scrollTo({ top: window.scrollY + rect.top - 120, behavior: 'smooth' });
      }
    }
  }
  function setActive(id) {
    activeId = id;
    renderHighlights();
    document.querySelectorAll('.share-thread--active').forEach(e => e.classList.remove('share-thread--active'));
    const li = list && list.querySelector(`.share-thread[data-comment-id="${id}"]`);
    if (li) {
      li.classList.add('share-thread--active');
      scrollThreadIntoView(li);
    }
  }
  // Den Thread in der rechten Befund-Leiste sichtbar machen. Ist das Panel ein
  // eigener Scroll-Container (Desktop ≥1100px, sticky + overflow-y:auto), nur
  // darin scrollen — der Artikel (window) bleibt an der angeklickten Stelle
  // stehen. Sonst (gestapeltes Mobile-Layout) Default-Scroll.
  function scrollThreadIntoView(li) {
    const panel = li.closest('.share-comments');
    const scrollable = panel
      && panel.scrollHeight > panel.clientHeight + 1
      && /(auto|scroll)/.test(getComputedStyle(panel).overflowY);
    if (scrollable) {
      const liRect = li.getBoundingClientRect();
      const pRect = panel.getBoundingClientRect();
      const delta = (liRect.top - pRect.top) - (pRect.height - liRect.height) / 2;
      panel.scrollTo({ top: panel.scrollTop + delta, behavior: 'smooth' });
    } else {
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ── Klick auf Highlight → Thread fokussieren ─────────────────────────────────
  if (article) {
    article.addEventListener('click', (ev) => {
      if (!anchorRanges.length) return;
      let caret = null;
      if (document.caretRangeFromPoint) caret = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(ev.clientX, ev.clientY);
        if (p) { caret = document.createRange(); caret.setStart(p.offsetNode, p.offset); caret.collapse(true); }
      }
      if (!caret) return;
      for (const a of anchorRanges) {
        try {
          if (a.range.isPointInRange(caret.startContainer, caret.startOffset)) { setActive(a.id); return; }
        } catch {}
      }
    });
  }

  // ── Selektions-Button + Composer ─────────────────────────────────────────────
  const selBtn = el('button', 'share-sel-btn', t('anchor_cta'));
  selBtn.type = 'button';
  selBtn.hidden = true;
  document.body.appendChild(selBtn);
  let pendingAnchor = null;

  function positionSelButton() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { selBtn.hidden = true; return; }
    const a = anchorFromSelection();
    if (!a) { selBtn.hidden = true; return; }
    pendingAnchor = a;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    selBtn.style.top = (window.scrollY + rect.top - 42) + 'px';
    selBtn.style.left = (window.scrollX + rect.left + rect.width / 2) + 'px';
    selBtn.hidden = false;
  }
  document.addEventListener('selectionchange', () => {
    // Nur reagieren, wenn Selektion im Artikel liegt.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { selBtn.hidden = true; return; }
    const node = sel.anchorNode;
    if (!node || !article.contains(node.nodeType === 1 ? node : node.parentNode)) { selBtn.hidden = true; return; }
    positionSelButton();
  });
  selBtn.addEventListener('mousedown', (e) => e.preventDefault()); // Selektion nicht verlieren
  selBtn.addEventListener('click', () => {
    if (pendingAnchor) openComposer(pendingAnchor);
    selBtn.hidden = true;
  });

  // Composer-Overlay (für verankerte + allgemeine Anmerkungen).
  function openComposer(anchor) {
    closeComposer();
    const overlay = el('div', 'share-composer');
    overlay.id = 'share-composer';
    const card = el('div', 'share-composer__card');
    card.appendChild(el('h3', 'share-composer__title', anchor ? t('composer_title') : t('composer_general_title')));
    if (anchor) {
      const q = el('blockquote', 'share-composer__quote', '„' + anchor.quote + '"');
      card.appendChild(q);
    }
    const nameInput = el('input', 'share-composer__name');
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.placeholder = t('your_name');
    nameInput.value = savedName();
    const ta = el('textarea', 'share-composer__body');
    ta.rows = 4;
    ta.maxLength = 4000;
    ta.placeholder = t('comment_form_body');
    const actions = el('div', 'share-composer__actions');
    const submit = el('button', 'share-composer__submit', t('send'));
    submit.type = 'button';
    const cancel = el('button', 'share-composer__cancel', t('cancel'));
    cancel.type = 'button';
    const status = el('span', 'share-comments__status');
    actions.appendChild(submit);
    actions.appendChild(cancel);
    actions.appendChild(status);
    card.appendChild(nameInput);
    card.appendChild(ta);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => ta.focus(), 30);

    cancel.addEventListener('click', closeComposer);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeComposer(); });
    submit.addEventListener('click', async () => {
      const body = (ta.value || '').trim();
      if (!body) { status.textContent = t('form_empty'); return; }
      const name = (nameInput.value || '').trim();
      submit.disabled = true;
      const payload = { body, reader_name: name };
      if (anchor) { payload.anchor_bid = anchor.bid; payload.anchor_quote = anchor.quote; payload.anchor_start = anchor.start; payload.anchor_end = anchor.end; }
      try {
        await postComment(payload);
        rememberName(name);
        closeComposer();
        await fetchThreads();
        // Bewusst KEIN setActive/Scroll auf den neuen Kommentar — der Leser
        // bleibt an der markierten Stelle stehen.
      } catch (e) {
        status.textContent = e.status === 429 ? t('comment_rate_limited') : t('form_error');
        submit.disabled = false;
      }
    });
  }
  function closeComposer() {
    const ex = document.getElementById('share-composer');
    if (ex) ex.remove();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeComposer(); });

  // ── Allgemeine Kommentar-Form (SSR) an JSON-Pfad koppeln ─────────────────────
  const form = document.getElementById('share-comment-form');
  if (form) {
    const status = document.getElementById('share-comment-status');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.textContent = '';
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      const body = (form.elements['body'].value || '').trim();
      const name = (form.elements['reader_name'].value || '').trim();
      const hp = (form.elements['_hp'].value || '').trim();
      if (!body) { status.textContent = form.dataset.emptyMsg; submit.disabled = false; return; }
      try {
        await postComment({ body, reader_name: name, _hp: hp });
        rememberName(name);
        form.reset();
        status.textContent = form.dataset.successMsg;
        await fetchThreads();
      } catch (err) {
        status.textContent = err.status === 429 ? form.dataset.rateMsg
          : form.dataset.errorMsg + (err.message ? ' (' + err.message + ')' : '');
      } finally {
        submit.disabled = false;
      }
    });
    // Namen vorbefüllen.
    const nameField = form.elements['reader_name'];
    if (nameField && !nameField.value) nameField.value = savedName();
  }

  // Re-Anchor bei Resize (Block-Geometrie ändert sich) — Highlights neu malen.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHighlights, 200);
  });

  // Start.
  fetchThreads();
})();
