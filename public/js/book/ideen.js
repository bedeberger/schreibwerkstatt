// Methoden für die Ideen-Karte (Sub-Komponente). Verwaltet User-Notizen
// pro Seite ODER pro Kapitel — Scope-Switch via app.ideenScope.
// Offene Ideen werden im Seiten-Chat als Kontext eingespielt (Backend-seitig
// via getOpenIdeen: Page-Ideen + Chapter-Ideen des umliegenden Kapitels).

import { fetchJson } from '../utils.js';
import { EVT } from '../events.js';

// Aktive Scope-IDs aus Root lesen. Liefert { kind, id } oder null.
function _activeScope(app) {
  if (!app) return null;
  if (app.ideenScope === 'chapter') {
    return app.ideenChapterId ? { kind: 'chapter', id: app.ideenChapterId } : null;
  }
  return app.currentPage?.id ? { kind: 'page', id: app.currentPage.id } : null;
}

export const ideenMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async loadIdeen() {
    const app = window.__app;
    const scope = _activeScope(app);
    if (!scope) { this.ideen = []; return; }
    this.loading = true;
    try {
      const qs = scope.kind === 'chapter' ? `chapter_id=${scope.id}` : `page_id=${scope.id}`;
      const rows = await fetchJson(`/ideen?${qs}`);
      this.ideen = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.load');
      this.ideen = [];
    } finally {
      this.loading = false;
    }
  },

  resetIdeen() {
    this.ideen = [];
    this.newContent = '';
    this.editingId = null;
    this.editingDraft = '';
    this.movingId = null;
    this.moveTargetId = '';
    this.menuOpenId = null;
    this._detachMenuListeners?.();
    this.errorMessage = '';
    this.busy = false;
  },

  // ── Meatball-Menu (Popover) ───────────────────────────────────────────────
  openMenu(ev, idee) {
    if (this.menuOpenId === idee.id) { this.closeMenu(); return; }
    // Hover-Tooltip des Triggers wegblenden — er hinge sonst über dem Menü.
    window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));
    this._triggerRect = ev.currentTarget.getBoundingClientRect();
    // Schätzung vor dem Render; danach mit der echten Popover-Grösse nachjustieren.
    // Erledigte Ideen haben ein kürzeres Menü (nur Wieder öffnen + Löschen) — eine
    // feste Höhe würde es beim Hochklappen zu weit über den Button schieben.
    this.menuPos = this._computeMenuPos(this._triggerRect, 220, 200);
    this.menuOpenId = idee.id;
    this._attachMenuListeners();
    this.$nextTick(() => {
      const el = this.$refs.ideenMenu;
      if (!el || !this._triggerRect) return;
      this.menuPos = this._computeMenuPos(this._triggerRect, el.offsetWidth, el.offsetHeight);
    });
  },

  _computeMenuPos(r, pw, ph) {
    const left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.right - pw));
    const top  = (r.bottom + ph + 8 > window.innerHeight)
      ? Math.max(8, r.top - ph - 4)
      : r.bottom + 4;
    return { top, left };
  },

  closeMenu() {
    this.menuOpenId = null;
    this._detachMenuListeners();
  },

  // Plain Methode statt Getter — siehe Hinweis bei offeneIdeen().
  menuOpenIdee() {
    if (this.menuOpenId == null) return null;
    return (this.ideen || []).find(i => i.id === this.menuOpenId) || null;
  },

  _attachMenuListeners() {
    if (this._menuCloseHandler) return;
    this._menuCloseHandler = () => this.closeMenu();
    window.addEventListener('scroll', this._menuCloseHandler, true);
    window.addEventListener('resize', this._menuCloseHandler);
  },

  _detachMenuListeners() {
    if (!this._menuCloseHandler) return;
    window.removeEventListener('scroll', this._menuCloseHandler, true);
    window.removeEventListener('resize', this._menuCloseHandler);
    this._menuCloseHandler = null;
  },

  // ── CRUD ─────────────────────────────────────────────────────────────────
  async addIdee() {
    const app = window.__app;
    const content = (this.newContent || '').trim();
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (content.length > 4000) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    const scope = _activeScope(app);
    const bookId = Alpine.store('nav').selectedBookId;
    if (!scope || !bookId) return;

    this.busy = true;
    try {
      const body = { book_id: bookId, content };
      if (scope.kind === 'page') body.page_id = scope.id;
      else                       body.chapter_id = scope.id;
      const row = await fetchJson('/ideen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // Neueste offene Idee nach oben (Liste ist nach erledigt ASC, created_at DESC sortiert)
      this.ideen = [row, ...this.ideen];
      this.newContent = '';
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  startEditIdee(idee) {
    this.editingId = idee.id;
    this.editingDraft = idee.content || '';
  },

  cancelEditIdee() {
    this.editingId = null;
    this.editingDraft = '';
  },

  async saveEditIdee(idee) {
    const app = window.__app;
    const content = (this.editingDraft || '').trim();
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (content.length > 4000) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    if (content === idee.content) { this.cancelEditIdee(); return; }

    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      this._replaceIdee(row);
      this.editingId = null;
      this.editingDraft = '';
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  async toggleErledigtIdee(idee) {
    const app = window.__app;
    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erledigt: !idee.erledigt }),
      });
      this._replaceIdee(row);
      // Sort halten: offene oben, erledigte unten — innerhalb je nach created_at DESC
      this.ideen = this._sortIdeen(this.ideen);
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  // ── Move ─────────────────────────────────────────────────────────────────
  startMoveIdee(idee) {
    this.movingId = idee.id;
    this.moveTargetId = '';
  },

  cancelMoveIdee() {
    this.movingId = null;
    this.moveTargetId = '';
  },

  // Aus zentralem Picker — Idee wird aus this.movingId geholt.
  async confirmMoveCurrentIdee() {
    const idee = (this.ideen || []).find(i => i.id === this.movingId);
    if (!idee) return;
    return this.confirmMoveIdee(idee);
  },

  async confirmMoveIdee(idee) {
    const app = window.__app;
    const targetId = parseInt(this.moveTargetId, 10);
    if (!targetId) return;

    this.busy = true;
    try {
      // Body je nach Idee-Scope (within-kind move): Page-Idee → page_id,
      // Chapter-Idee → chapter_id. Backend lehnt Cross-Kind ab.
      const body = idee.page_id != null ? { page_id: targetId } : { chapter_id: targetId };
      await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.movingId = null;
      this.moveTargetId = '';
      this.errorMessage = '';
      this._publishIdeenCount();
      // Ziel-Counts bumpen (Backend lehnt Move bei erledigt ab → +1 sicher).
      this._bumpTreeCountForTarget(idee, targetId);
    } catch (e) {
      this.errorMessage = app.t('ideen.error.move');
    } finally {
      this.busy = false;
    }
  },

  async deleteIdee(idee) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('ideen.confirmDelete'),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/ideen/${idee.id}`, { method: 'DELETE' });
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.delete');
    } finally {
      this.busy = false;
    }
  },

  // ── Helpers ──────────────────────────────────────────────────────────────
  _publishIdeenCount() {
    const app = window.__app;
    const scope = _activeScope(app);
    if (!scope) return;
    const count = (this.ideen || []).filter(i => !i.erledigt).length;
    if (scope.kind === 'page') {
      if (app.currentPage?.id === scope.id) app.currentPageIdeenOpenCount = count;
    } else {
      if (app.ideenChapterId === scope.id) app.currentChapterIdeenOpenCount = count;
    }
    this._setTreeIdeenCount(scope, count);
  },

  // Patched ideenCounts/chapterIdeenCounts-Map im badges-Store für Sidebar-Indikator.
  _setTreeIdeenCount(scope, count) {
    const badges = Alpine.store('badges');
    if (!badges || !scope?.id) return;
    if (scope.kind === 'page') {
      const next = { ...(badges.ideenCounts || {}) };
      if (count > 0) next[scope.id] = count;
      else           delete next[scope.id];
      badges.ideenCounts = next;
    } else {
      const next = { ...(badges.chapterIdeenCounts || {}) };
      if (count > 0) next[scope.id] = count;
      else           delete next[scope.id];
      badges.chapterIdeenCounts = next;
    }
  },

  _bumpTreeCountForTarget(idee, targetId) {
    const badges = Alpine.store('badges');
    if (!badges) return;
    const isPage = idee.page_id != null;
    const mapKey = isPage ? 'ideenCounts' : 'chapterIdeenCounts';
    const prev = (badges[mapKey] && badges[mapKey][targetId]) || 0;
    const next = { ...(badges[mapKey] || {}) };
    next[targetId] = prev + 1;
    badges[mapKey] = next;
  },

  _replaceIdee(row) {
    this.ideen = this.ideen.map(i => (i.id === row.id ? row : i));
  },

  _sortIdeen(arr) {
    return [...arr].sort((a, b) => {
      if (a.erledigt !== b.erledigt) return a.erledigt - b.erledigt;
      // created_at DESC
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  },

  // Hinweis: Keine getter — `...ideenMethods`-Spread im Alpine.data-Factory ruft
  // getters sofort auf, mit `this === ideenMethods` (kein `ideen`-Feld) → Crash.
  // Plain Methoden funktionieren identisch im Template via `offeneIdeen()`.
  offeneIdeen() {
    return (this.ideen || []).filter(i => !i.erledigt);
  },
  erledigteIdeen() {
    return (this.ideen || []).filter(i => !!i.erledigt);
  },
};
