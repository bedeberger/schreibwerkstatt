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
import { bindScrollFade } from './scroll-fade.js';

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

  function forgetName() { try { localStorage.removeItem(NAME_KEY); } catch {} }

  // ── Leser-Identität: globaler Chip oben rechts + Namens-Modal ──────────────
  // Der Name wird nicht pro Formular abgefragt, sondern einmal zentral gesetzt:
  // beim ersten Laden öffnet ein Modal („Dein Name"), danach steht „Als <Name> ·
  // Ändern" im Optionen-Menü (⋯) oben rechts. Composer,
  // Reply-Form und SSR-Form kommentieren mit dem hier gesetzten Namen (sonst
  // anonym). „Überspringen"/Outside-Click merkt sich den Verzicht für die Session
  // (sessionStorage), damit das Modal in derselben Tab-Sitzung nicht nervt.
  const DISMISS_KEY = 'sw_share_name_dismissed';
  function nameDismissed() { try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } }
  function markNameDismissed() { try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {} }

  function closeNameModal() {
    const ex = document.getElementById('share-name-modal');
    if (ex) ex.remove();
  }

  function setupIdentity() {
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
        if (n !== prev) syncReaderName(n);
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

  // ── Optionen-Menü (Meatball ⋯) oben rechts ─────────────────────────────────
  // Bündelt alle sekundären Reader-Optionen (Identität, Farbschema, Inhalts-
  // verzeichnis) hinter einem ⋯-Trigger, damit die Leseansicht ruhig bleibt.
  // Standalone (kein Alpine, kein Icon-Sprite) — Trigger als inline-SVG; die
  // Cluster montieren ihre Bedienelemente über menuSection() in die Liste.
  const MEATBALL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  let menuPanel = null;
  function setupOptionsMenu() {
    const host = document.getElementById('share-actions');
    if (!host) return;
    const wrap = el('div', 'share-menu');
    const trigger = el('button', 'share-menu__trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', t('options_label'));
    trigger.innerHTML = MEATBALL_SVG;
    menuPanel = el('div', 'share-menu__panel');
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
  }
  // Eine abgegrenzte Sektion in der Menü-Liste (optionaler Titel als Heading).
  function menuSection(title) {
    const sec = el('div', 'share-menu__section');
    if (title) sec.appendChild(el('div', 'share-menu__heading', title));
    if (menuPanel) menuPanel.appendChild(sec);
    return sec;
  }

  setupOptionsMenu();
  setupIdentity();

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

  // ── Theme-Switcher (Auto / Hell / Dunkel) ────────────────────────────────────
  // Progressive Enhancement: share-theme-init.js hat das Theme schon vor dem
  // ersten Paint gesetzt (FOUC-Schutz). Hier bauen wir nur den Switcher als
  // Sektion im Optionen-Menü (⋯). Auto = kein data-theme (CSS-Media-Query folgt
  // System); explizit = Attribut.
  (function setupThemeSwitcher() {
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
  })();

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
  // Leichtgewichtige Signatur über die Threads — erkennt neue/aufgelöste
  // Kommentare und Antworten, ohne bei jedem Poll-Tick neu zu rendern (sonst
  // Scroll-Reset + verlorene halb getippte Antwort).
  function commentsSig(arr) {
    return arr.map(c => `${c.id}:${c.parent_id || 0}:${c.resolved ? 1 : 0}:${(c.body || '').length}`).join('|');
  }
  let lastSig = null;
  async function fetchThreads() {
    try {
      const res = await fetch(`/share/${encodeURIComponent(TOKEN)}/threads?rt=${encodeURIComponent(RT)}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) return;
      const j = await res.json();
      const next = Array.isArray(j.comments) ? j.comments : [];
      const sig = commentsSig(next);
      comments = next;
      if (sig === lastSig) return; // keine Änderung → kein Reflow
      lastSig = sig;
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

  // Eigenen Kommentar löschen (Self-Identität via reader_token). 409 HAS_REPLIES
  // = der Autor hat geantwortet → die UI zeigt für solche Threads keinen
  // Lösch-Button (Schutz vor Cascade), der Status fängt Race-Fälle ab.
  async function deleteOwnComment(id) {
    const res = await fetch(`/share/${encodeURIComponent(TOKEN)}/comment/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reader_token: RT }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j.error_code || 'ERR');
      err.status = res.status;
      throw err;
    }
  }
  // Eigenen Root-Thread als erledigt markieren / wieder öffnen.
  async function resolveOwnComment(id, resolved) {
    const res = await fetch(`/share/${encodeURIComponent(TOKEN)}/comment/${id}/resolve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reader_token: RT, resolved }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j.error_code || 'ERR');
      err.status = res.status;
      throw err;
    }
  }

  // Namensänderung am Identitäts-Chip auf die bisherigen eigenen Kommentare
  // dieses Browsers (reader_token) übertragen und die Threads neu laden, damit
  // der neue Name sofort sichtbar wird.
  async function syncReaderName(name) {
    try {
      await fetch(`/share/${encodeURIComponent(TOKEN)}/reader-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reader_token: RT, reader_name: name }),
      });
    } catch {}
    lastSig = null; // Re-Render erzwingen (Body-Signatur ändert sich nicht)
    fetchThreads();
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
        await postComment({ parent_id: rootId, body, reader_name: savedName() });
        await fetchThreads();
      } catch (e) {
        status.textContent = e.status === 429 ? t('comment_rate_limited') : t('form_error');
        btn.disabled = false;
      }
    });
    return form;
  }

  // Self-Service-Aktionen für eigene Kommentare (mine). Root: Erledigt-Toggle +
  // Löschen (nur ohne Antworten); Antwort-Beiträge: nur Löschen. Buttons als
  // dezente Text-Aktionen unter dem Body. Bei Fehlern erscheint ein Status-Text;
  // bei Erfolg lädt fetchThreads die Liste neu.
  function renderOwnActions(c, { isRoot, hasReplies }) {
    const actions = el('div', 'share-thread__actions');
    const status = el('span', 'share-comments__status');

    if (isRoot) {
      const toggle = el('button', 'share-thread__action', c.resolved ? t('reopen') : t('mark_done'));
      toggle.type = 'button';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try { await resolveOwnComment(c.id, !c.resolved); await fetchThreads(); }
        catch (e) { status.textContent = t('form_error'); toggle.disabled = false; }
      });
      actions.appendChild(toggle);
    }

    // Antworten (Replies) sind Blätter → immer löschbar. Root nur ohne Antworten
    // (sonst würde die Owner-Antwort per CASCADE verschwinden — serverseitig geblockt).
    if (!isRoot || !hasReplies) {
      const del = el('button', 'share-thread__action share-thread__action--danger', t('delete'));
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!window.confirm(t('delete_confirm'))) return;
        del.disabled = true;
        try { await deleteOwnComment(c.id); await fetchThreads(); }
        catch (e) {
          status.textContent = e.message === 'HAS_REPLIES' ? t('delete_has_replies') : t('form_error');
          del.disabled = false;
        }
      });
      actions.appendChild(del);
    }

    actions.appendChild(status);
    return actions;
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

    // Self-Service: eigenen Root erledigt-markieren/löschen.
    if (root.mine) li.appendChild(renderOwnActions(root, { isRoot: true, hasReplies: replies.length > 0 }));

    // Antworten.
    if (replies.length) {
      const replyList = el('div', 'share-thread__replies');
      for (const r of replies) {
        const rEl = el('div', 'share-thread__reply-item');
        if (r.is_author) rEl.classList.add('share-thread__reply-item--author');
        rEl.appendChild(renderMeta(r));
        rEl.appendChild(el('div', 'share-comments__body', r.body));
        if (r.mine) rEl.appendChild(renderOwnActions(r, { isRoot: false, hasReplies: false }));
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

  // ── Inhaltsverzeichnis ein-/ausblenden (Reader-seitig, persistent) ───────────
  // Toggle-Eintrag im Optionen-Menü (⋯). Blendet das ganze TOC-Panel aus; im Grid
  // (≥1100px) gibt die Layout-Klasse `share-toc-collapsed` die linke Spalte frei
  // (Text rückt nach). Zustand pro Browser in localStorage. Nur aktiv, wenn
  // überhaupt ein TOC da ist.
  (function setupTocToggle() {
    const layout = document.querySelector('.share-layout');
    const toc = document.querySelector('.share-toc');
    const heading = toc && toc.querySelector('.share-toc__heading');
    if (!layout || !toc || !heading) return;
    const KEY = 'sw_share_toc_collapsed';
    const sec = menuSection();
    const btn = el('button', 'share-action-btn');
    btn.type = 'button';
    btn.appendChild(el('span', 'share-action-btn__label', heading.textContent));
    sec.appendChild(btn);
    function apply(collapsed, persist) {
      layout.classList.toggle('share-toc-collapsed', collapsed);
      btn.classList.toggle('share-action-btn--active', !collapsed);
      btn.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
      if (persist) { try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch {} }
    }
    let collapsed = false;
    try { collapsed = localStorage.getItem(KEY) === '1'; } catch {}
    apply(collapsed, false);
    btn.addEventListener('click', () => apply(!layout.classList.contains('share-toc-collapsed'), true));
  })();

  // Auto-Hide-Scrollbar an TOC + Kommentar-Leiste (≥1100px eigene Scroll-Container),
  // gleiches Pattern wie Sidebar-Tree + Bucheditor-Inhaltsverzeichnis in der SPA.
  bindScrollFade(document.querySelector('.share-toc'));
  bindScrollFade(document.querySelector('.share-comments'));

  // ── Inhaltsverzeichnis → sanftes Scrollen zur Sektion ────────────────────────
  // Native Anchor-Sprünge landen hart hinter dem Sticky-Header. Stattdessen
  // smooth scrollen mit Header-Offset und die Ziel-Überschrift kurz aufleuchten
  // lassen (reduced-motion respektiert → kein Smooth, nur Flash).
  function tocHeaderOffset() {
    const h = document.querySelector('.share-header');
    return (h ? h.getBoundingClientRect().height : 0) + 16;
  }
  function flashTarget(elm) {
    elm.classList.remove('share-flash');
    void elm.offsetWidth; // Reflow → Animation neu starten
    elm.classList.add('share-flash');
    elm.addEventListener('animationend', () => elm.classList.remove('share-flash'), { once: true });
  }
  document.querySelectorAll('.share-toc__link').forEach((link) => {
    link.addEventListener('click', (ev) => {
      const id = (link.getAttribute('href') || '').replace(/^#/, '');
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      ev.preventDefault();
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const top = window.scrollY + target.getBoundingClientRect().top - tocHeaderOffset();
      window.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
      flashTarget(target);
      try { history.replaceState(null, '', '#' + id); } catch {}
    });
  });

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
      submit.disabled = true;
      // Name kommt global aus dem Identitäts-Chip (oben rechts) — kein Feld hier.
      const payload = { body, reader_name: savedName() };
      if (anchor) { payload.anchor_bid = anchor.bid; payload.anchor_quote = anchor.quote; payload.anchor_start = anchor.start; payload.anchor_end = anchor.end; }
      try {
        await postComment(payload);
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('share-name-modal')) { markNameDismissed(); closeNameModal(); }
    closeComposer();
  });

  // ── Allgemeine Kommentar-Form (SSR) an JSON-Pfad koppeln ─────────────────────
  const form = document.getElementById('share-comment-form');
  if (form) {
    const status = document.getElementById('share-comment-status');
    // Mit JS kommt der Name global aus dem Identitäts-Chip (oben rechts) — das
    // beschriftete Server-Feld entfällt. Ohne JS bleibt es als Fallback stehen.
    const nameField = form.elements['reader_name'];
    const nameLabel = nameField ? nameField.closest('.share-comments__label') : null;
    if (nameLabel) nameLabel.remove();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.textContent = '';
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      const body = (form.elements['body'].value || '').trim();
      const hp = (form.elements['_hp'].value || '').trim();
      if (!body) { status.textContent = form.dataset.emptyMsg; submit.disabled = false; return; }
      try {
        await postComment({ body, reader_name: savedName(), _hp: hp });
        form.elements['body'].value = '';
        status.textContent = form.dataset.successMsg;
        await fetchThreads();
      } catch (err) {
        status.textContent = err.status === 429 ? form.dataset.rateMsg
          : form.dataset.errorMsg + (err.message ? ' (' + err.message + ')' : '');
      } finally {
        submit.disabled = false;
      }
    });
  }

  // Re-Anchor bei Resize (Block-Geometrie ändert sich) — Highlights neu malen.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHighlights, 200);
  });

  // ── Live-Poll: Autor-Antworten ohne Reload sichtbar machen ───────────────────
  // Pendant zum 5-s-Poll der Owner-Karte. fetchThreads() rendert nur bei echter
  // Änderung (Signatur), trotzdem pausieren wir, solange der Leser gerade tippt
  // oder selektiert — sonst würde ein Tick den Composer/Selektions-Flow oder
  // einen halb getippten Beitrag stören. Hintergrund-Tab wird übersprungen.
  const POLL_MS = 10000;
  function readerBusy() {
    if (document.getElementById('share-composer')) return true; // Composer offen
    if (!selBtn.hidden) return true;                            // Text gerade markiert
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return true;
    // Halb getippten, gerade unfokussierten Beitrag nicht verwerfen.
    for (const ta of document.querySelectorAll('textarea')) {
      if ((ta.value || '').trim()) return true;
    }
    return false;
  }
  setInterval(() => {
    if (document.hidden || readerBusy()) return;
    fetchThreads();
  }, POLL_MS);

  // Start.
  fetchThreads();
})();
