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
//
// Diese Datei ist die Facade + der gekoppelte Kern (State, API, Highlights,
// Thread-Render, Live-Poll). Die selbstständigen Widgets liegen unter
// share-reader/: dom (el/fmtDate), identity (Reader-Token + Namens-Chip/Modal),
// menu (Optionen-⋯), theme (Farbschema), toc (Inhaltsverzeichnis), diff
// (Quote-Diff), layout (vertikale Verankerung der Karten = Google-Docs-Modell),
// composer (Selektions-Button + Anmerkungs-Overlay).

import { locateRange, resolveCurrentQuote } from './share-anchor.js';
import { bindScrollFade } from './scroll-fade.js';
import { el, fmtDate } from './share-reader/dom.js';
import {
  readerToken, savedName, markNameDismissed, closeNameModal, setupIdentity,
} from './share-reader/identity.js';
import { createOptionsMenu } from './share-reader/menu.js';
import { setupThemeSwitcher } from './share-reader/theme.js';
import { setupToc } from './share-reader/toc.js';
import { setupProgressBar } from './share-reader/progress.js';
import { appendQuoteDiff } from './share-reader/diff.js';
import { createCardLayout } from './share-reader/layout.js';
import { setupComposer } from './share-reader/composer.js';

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
  // Verankerte Anmerkungen leben in der schwebenden Leiste rechts
  // (.share-comments__list = Positionierungs-Ebene), allgemeine Kommentare in der
  // abgesetzten Sektion unten (.share-general__list) mit eigener Form.
  const list = document.querySelector('.share-comments__list');
  const generalList = document.querySelector('.share-general__list');
  const supportsHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  const RT = readerToken();

  // ── Optionen-Menü (⋯) + sekundäre Cluster (Identität, Theme, TOC) ────────────
  // Reihenfolge bestimmt die Sektions-Folge im Panel: Identität → Theme → TOC.
  const { menuSection } = createOptionsMenu({ t });
  setupIdentity({ t, menuSection, onNameChange: syncReaderName });
  setupThemeSwitcher({ t, menuSection });
  setupToc({ menuSection });
  setupProgressBar();

  // Auto-Hide-Scrollbar am TOC (≥1100px eigener Scroll-Container), gleiches
  // Pattern wie Sidebar-Tree + Bucheditor-Inhaltsverzeichnis in der SPA. Die
  // Kommentar-Leiste scrollt mit dem Fenster mit (schwebende Karten) — kein
  // eigener Scroll-Container, daher kein Scroll-Fade dort.
  bindScrollFade(document.querySelector('.share-toc'));

  // ── State ──────────────────────────────────────────────────────────────────
  let comments = [];          // flache Liste (serverseitig serialisiert)
  const anchorRanges = [];    // { id, range } für Klick-Mapping
  let activeId = null;        // gerade fokussierter Thread

  // Vertikale Verankerung der schwebenden Karten (Google-Docs-Modell).
  const cardLayout = createCardLayout({
    article: () => article,
    getLayer: () => list,
    getAnchoredCards: () => comments
      .filter(c => !c.parent_id && c.anchor)
      .map(c => ({ id: c.id, anchor: c.anchor })),
    getActiveId: () => activeId,
  });
  cardLayout.init();

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

  // Re-Anchoring (`locateRange(rootEl, anchor)`) kommt aus share-anchor.js (SSoT,
  // geteilt mit der Owner-Karte) — kein lokales Duplikat. Die Selektions-→Anker-
  // Logik (charOffset) lebt im Composer-Widget (share-reader/composer.js).

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

  // Hue-Hash identisch zu app.userAvatarHue (public/js/app/app-ui.js), damit
  // dieselbe Person in Reader und SPA stabil dieselbe Pip-Farbe bekommt.
  function avatarHue(seed) {
    const s = String(seed || '').toLowerCase();
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  // Avatar-Daten (Label + Initialen-Pip + deterministische Hue), analog zur
  // SPA-Leiste (comment-rail-core commentAvatar). Leser haben keine Email →
  // Seed/Initialen aus dem Anzeigenamen; der Autor bekommt einen festen Seed.
  function commentAvatar(c) {
    const label = authorName(c);
    const seed = c.is_author ? 'author' : (c.name || 'anon');
    const tokens = String(label).split(/[\s._@-]+/).filter(Boolean);
    const initials = tokens.length
      ? ((tokens[0][0] || '') + (tokens.length > 1 ? (tokens[1][0] || '') : '')).toUpperCase().slice(0, 2)
      : '?';
    return { label, initials, hue: avatarHue(seed) };
  }

  function renderMeta(c) {
    const meta = el('div', 'comment-rail__meta');
    const av = commentAvatar(c);
    const avatar = el('span', 'comment-rail__avatar', av.initials);
    avatar.setAttribute('aria-hidden', 'true');
    avatar.style.setProperty('--avatar-hue', av.hue);
    meta.appendChild(avatar);
    meta.appendChild(el('span', 'comment-rail__author', av.label));
    meta.appendChild(el('span', 'comment-rail__time', fmtDate(c.created_at)));
    if (c.resolved) meta.appendChild(el('span', 'comment-rail__resolved', t('resolved_badge')));
    return meta;
  }

  function renderReplyForm(rootId) {
    const form = el('form', 'comment-rail__reply');
    const ta = el('textarea', 'comment-rail__textarea');
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
    // Optik aus der geteilten Karte (.comment-rail__*, components/comment-rail.css);
    // `share-thread` bleibt als Hook für die Margin-Note-Positionierung
    // (share-reader/layout.js) + setActive.
    const li = el('li', 'comment-rail__thread share-thread');
    li.dataset.commentId = root.id;
    if (root.resolved) li.classList.add('comment-rail__thread--resolved');
    if (root.id === activeId) li.classList.add('comment-rail__thread--selected');

    // Anker-Zeile: getönter Quote-Snippet + Jump bzw. Stale-Hinweis.
    if (root.anchor) {
      const anchorRow = el('div', 'comment-rail__anchor');
      const quote = el('span', 'comment-rail__quote', root.anchor.quote || '');
      anchorRow.appendChild(quote);
      // resolveCurrentQuote trennt „Block weg" (gone) von „Text geändert"
      // (changed) — nur bei changed gibt es einen aktuellen Text zum Diffen.
      const res = resolveCurrentQuote(article, root.anchor);
      if (res.status === 'changed') {
        quote.classList.add('comment-rail__quote--stale');
        anchorRow.appendChild(el('span', 'share-thread__stale', t('anchor_changed')));
        li.appendChild(anchorRow);
        // Platzhalter direkt unter der Anker-Zeile, damit der async geladene
        // Diff an der richtigen Stelle landet (nicht ans li-Ende).
        const diffBox = el('div');
        li.appendChild(diffBox);
        appendQuoteDiff(diffBox, root.anchor.quote || '', res.currentText || '');
      } else if (root._stale || res.status === 'gone') {
        quote.classList.add('comment-rail__quote--stale');
        anchorRow.appendChild(el('span', 'share-thread__stale', t('anchor_stale')));
        li.appendChild(anchorRow);
      } else {
        anchorRow.setAttribute('role', 'button');
        anchorRow.tabIndex = 0;
        const jump = () => scrollToAnchor(root.id);
        anchorRow.addEventListener('click', jump);
        anchorRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } });
        li.appendChild(anchorRow);
      }
    }

    // Root-Kommentar (Meta + Body + Self-Service-Aktionen).
    const rootComment = el('div', 'comment-rail__comment');
    rootComment.appendChild(renderMeta(root));
    rootComment.appendChild(el('div', 'comment-rail__body', root.body));
    if (root.mine) rootComment.appendChild(renderOwnActions(root, { isRoot: true, hasReplies: replies.length > 0 }));
    li.appendChild(rootComment);

    // Antworten (abgesetzt; Autor-Antworten mit Akzentbalken).
    for (const r of replies) {
      const rEl = el('div', 'comment-rail__comment comment-rail__comment--reply');
      if (r.is_author) rEl.classList.add('comment-rail__comment--author');
      rEl.appendChild(renderMeta(r));
      rEl.appendChild(el('div', 'comment-rail__body', r.body));
      if (r.mine) rEl.appendChild(renderOwnActions(r, { isRoot: false, hasReplies: false }));
      li.appendChild(rEl);
    }

    // Reader-Antwort (nur offene Threads) in der Fuss-Sektion.
    if (!root.resolved) {
      const foot = el('div', 'comment-rail__foot');
      foot.appendChild(renderReplyForm(root.id));
      li.appendChild(foot);
    }
    return li;
  }

  const byTime = (a, b) => new Date(a.root.created_at) - new Date(b.root.created_at);

  function render() {
    const tree = buildTree();
    const anchored = tree.filter(n => n.root.anchor).sort(byTime);
    const general = tree.filter(n => !n.root.anchor).sort(byTime);

    // Verankerte Anmerkungen → schwebende Leiste rechts. Pro Karte ein Marker-Tick
    // (echte Anker-Höhe, vom Layout positioniert), damit verschobene Karten ihren
    // Bezug zur Textstelle behalten.
    if (list) {
      list.innerHTML = '';
      if (!anchored.length) {
        list.appendChild(el('li', 'share-comments__empty', t('threads_empty')));
      } else {
        for (const node of anchored) {
          const marker = el('div', 'share-thread-marker');
          marker.setAttribute('data-marker-for', node.root.id);
          marker.setAttribute('aria-hidden', 'true');
          list.appendChild(marker);
          list.appendChild(renderThread(node));
        }
      }
    }

    // Allgemeine Kommentare → abgesetzte Sektion unten (eigene Form darunter).
    if (generalList) {
      generalList.innerHTML = '';
      if (!general.length) {
        generalList.appendChild(el('li', 'share-comments__empty', t('comments_empty')));
      } else {
        for (const node of general) generalList.appendChild(renderThread(node));
      }
    }

    renderHighlights();
    cardLayout.schedule();
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
    document.querySelectorAll('.comment-rail__thread--selected').forEach(e => e.classList.remove('comment-rail__thread--selected'));
    const card = list && list.querySelector(`.share-thread[data-comment-id="${id}"]`);
    if (card) {
      card.classList.add('comment-rail__thread--selected');
      // Auswahl pinnt die aktive Karte auf ihre exakte Anker-Höhe und verteilt die
      // übrigen darum herum → Layout neu rechnen.
      cardLayout.schedule();
      // Flach gestapelt (Mobile, kein Verankerungs-Layout) sichtbar scrollen.
      if (window.matchMedia && window.matchMedia('(max-width: 1099px)').matches) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
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

  // ── Selektions-Button + Composer-Overlay (Widget) ────────────────────────────
  const composer = setupComposer({
    t, article, postComment, savedName,
    onPosted: fetchThreads,
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('share-name-modal')) { markNameDismissed(); closeNameModal(); }
    composer.closeComposer();
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
    if (composer.isBusy()) return true; // Composer offen oder Text gerade markiert
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
