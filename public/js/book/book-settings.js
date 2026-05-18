// Buch-Einstellungen (Sprache, Region, Buchtyp, Perspektive, Zeit, Kontext).
// Methoden werden in Alpine.data('bookSettingsCard') gespreadet;
// Root-Zugriffe via window.__app.

import { fetchJson } from '../utils.js';
import { contentRepo } from '../repo/content.js';

export const bookSettingsMethods = {
  async loadBookSettings() {
    if (!window.__app.selectedBookId) return;
    this.bookSettingsLoading = true;
    try {
      const data = await fetchJson(`/booksettings/${window.__app.selectedBookId}`);
      this.bookSettingsLanguage  = data.language    || 'de';
      this.bookSettingsRegion    = data.region      || 'CH';
      this.bookSettingsBuchtyp   = data.buchtyp     || '';
      this.bookSettingsBuchKontext = data.buch_kontext || '';
      this.bookSettingsErzaehlperspektive = data.erzaehlperspektive || '';
      this.bookSettingsErzaehlzeit        = data.erzaehlzeit        || '';
      this.bookSettingsIsFinished         = !!data.is_finished;
      this.bookSettingsAllowLektorBookChat = !!data.allow_lektor_book_chat;
    } catch (e) {
      console.error('[book-settings] Laden fehlgeschlagen:', e);
    } finally {
      this.bookSettingsLoading = false;
    }
  },

  // Kategorie + Tags. Pool global; pro Buch eine
  // Kategorie (optional) + N Tags (Multi-Select). Inline-Create fuer Tags.
  async loadBookCategoriesAndTags() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    try {
      const [pool, tagPool, categoryRes, tagsRes] = await Promise.all([
        fetchJson('/local/categories'),
        fetchJson('/local/tags'),
        fetchJson(`/books/${bookId}/category`),
        fetchJson(`/books/${bookId}/tags`),
      ]);
      this.categoryPool = pool.categories || [];
      this.tagPool      = tagPool.tags || [];
      this.bookCategoryId = categoryRes.category?.id || '';
      this.bookTagIds     = (tagsRes.tags || []).map(t => t.id);
    } catch (e) {
      console.error('[book-settings] Kategorien/Tags laden fehlgeschlagen:', e);
    }
  },

  bookCategoryOptions() {
    return (this.categoryPool || []).map(c => ({ value: String(c.id), label: c.name }));
  },

  async saveBookCategory() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    const raw = this.bookCategoryId;
    const cid = raw === '' || raw === null || raw === undefined ? null : parseInt(raw, 10);
    try {
      const r = await fetch(`/books/${bookId}/category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category_id: cid }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      }
      await window.__app.loadBooks();
    } catch (e) {
      this.bookSettingsError = e.message;
    }
  },

  async toggleBookTag(tagId) {
    const i = this.bookTagIds.indexOf(tagId);
    if (i >= 0) this.bookTagIds.splice(i, 1);
    else this.bookTagIds.push(tagId);
    await this.saveBookTags();
  },

  async saveBookTags() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    try {
      const r = await fetch(`/books/${bookId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_ids: this.bookTagIds }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      }
      await window.__app.loadBooks();
    } catch (e) {
      this.bookSettingsError = e.message;
    }
  },

  async createInlineTag() {
    const name = (this.newTagName || '').trim();
    if (!name) return;
    this.newTagBusy = true;
    try {
      const r = await fetch('/local/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      this.tagPool = [...this.tagPool, { id: data.tag.id, name: data.tag.name, slug: data.tag.slug, color: null }];
      this.tagPool.sort((a, b) => a.name.localeCompare(b.name));
      this.newTagName = '';
      if (!this.bookTagIds.includes(data.tag.id)) {
        this.bookTagIds.push(data.tag.id);
        await this.saveBookTags();
      }
    } catch (e) {
      this.bookSettingsError = e.message;
    } finally {
      this.newTagBusy = false;
    }
  },

  async saveBookSettings() {
    if (!window.__app.selectedBookId) return;
    this.bookSettingsSaving = true;
    this.bookSettingsSaved  = false;
    this.bookSettingsError  = '';
    try {
      const r = await fetch(`/booksettings/${window.__app.selectedBookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language:          this.bookSettingsLanguage,
          region:            this.bookSettingsRegion,
          buchtyp:           this.bookSettingsBuchtyp              || null,
          buch_kontext:      this.bookSettingsBuchKontext          || null,
          erzaehlperspektive: this.bookSettingsErzaehlperspektive  || null,
          erzaehlzeit:       this.bookSettingsErzaehlzeit          || null,
          is_finished:       this.bookSettingsIsFinished ? 1 : 0,
          allow_lektor_book_chat: this.bookSettingsAllowLektorBookChat ? 1 : 0,
        }),
      });
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch (_) {}
        throw new Error(data ? window.__app.tError(data) : `HTTP ${r.status}`);
      }
      this.bookSettingsSaved = true;
      // Header-Donut konsumiert dailyProgressIsFinished am Root — direkt
      // synchronisieren, damit Toggle Buch-Abschluss ohne Reload greift.
      if (window.__app) window.__app.dailyProgressIsFinished = !!this.bookSettingsIsFinished;
      if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
      this._savedAtTimer = setTimeout(() => { this.bookSettingsSaved = false; this._savedAtTimer = null; }, 2500);
    } catch (e) {
      this.bookSettingsError = e.message;
    } finally {
      this.bookSettingsSaving = false;
    }
  },

  bookSettingsLocaleDisplay() {
    const map = {
      'de-CH': 'Deutsch (Schweiz)',
      'de-DE': 'Deutsch (Deutschland)',
      'en-US': 'English (USA)',
      'en-GB': 'English (UK)',
    };
    return map[`${this.bookSettingsLanguage}-${this.bookSettingsRegion}`] || `${this.bookSettingsLanguage}-${this.bookSettingsRegion}`;
  },

  /** Gibt die Buchtyp-Liste für die aktuelle Sprache zurück (aus promptConfig). */
  bookSettingsBuchtypen() {
    const lang = this.bookSettingsLanguage || 'de';
    const typen = window.__app.promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },

  bookSettingsBuchtypOptions() {
    return this.bookSettingsBuchtypen().map(t => ({ value: t.key, label: t.label }));
  },

  bookSettingsPovOptions() {
    const app = window.__app;
    return [
      { value: 'ich',                label: app.t('book.settings.pov.ich') },
      { value: 'er_sie_personal',    label: app.t('book.settings.pov.er_personal') },
      { value: 'er_sie_auktorial',   label: app.t('book.settings.pov.er_auktorial') },
      { value: 'du',                 label: app.t('book.settings.pov.du') },
      { value: 'wir',                label: app.t('book.settings.pov.wir') },
      { value: 'gemischt',           label: app.t('book.settings.pov.gemischt') },
    ];
  },

  bookSettingsTempusOptions() {
    const app = window.__app;
    return [
      { value: 'praeteritum', label: app.t('book.settings.tempus.praeteritum') },
      { value: 'praesens',    label: app.t('book.settings.tempus.praesens') },
      { value: 'gemischt',    label: app.t('book.settings.tempus.gemischt') },
    ];
  },

  async loadBookJobStats() {
    if (!window.__app.selectedBookId) {
      this.bookJobStats = null;
      return;
    }
    this.bookJobStatsLoading = true;
    try {
      this.bookJobStats = await fetchJson(`/jobs/stats?book_id=${encodeURIComponent(window.__app.selectedBookId)}`);
    } catch (e) {
      console.error('[book-settings] Job-Statistiken laden fehlgeschlagen:', e);
      this.bookJobStats = [];
    } finally {
      this.bookJobStatsLoading = false;
    }
  },

  async resetBookHistory() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    const book = window.__app.books.find(b => String(b.id) === String(bookId));
    const name = book?.name || '';
    if (!await window.__app.appConfirm({
      message: window.__app.t('userSettings.resetConfirm', { name }),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;

    this.bookHistoryResetLoading = true;
    this.bookHistoryResetMessage = '';
    this.bookHistoryResetError   = '';
    try {
      const r = await fetch(`/history/book/${bookId}`, { method: 'DELETE' });
      if (!r.ok) {
        let errData = null;
        try { errData = await r.json(); } catch (_) {}
        throw new Error(errData ? window.__app.tError(errData) : `HTTP ${r.status}`);
      }
      const data = await r.json();
      const d = data.deleted || {};
      this.bookHistoryResetMessage = window.__app.t('userSettings.resetSummary', {
        lektorate: d.page_checks || 0,
        reviews:   d.book_reviews || 0,
        chats:     d.chat_sessions || 0,
      });
      if (String(window.__app.selectedBookId) === String(bookId)) {
        window.__app.pageHistory       = [];
        window.__app.bookReviewHistory = [];
        window.dispatchEvent(new CustomEvent('chat:reset'));
      }
      if (this._resetMsgTimer) clearTimeout(this._resetMsgTimer);
      this._resetMsgTimer = setTimeout(() => { this.bookHistoryResetMessage = ''; this._resetMsgTimer = null; }, 6000);
    } catch (e) {
      this.bookHistoryResetError = e.message;
    } finally {
      this.bookHistoryResetLoading = false;
    }
  },

  async deleteBook() {
    const app = window.__app;
    const bookId = app.selectedBookId;
    if (!bookId) return;
    const book = app.books.find(b => String(b.id) === String(bookId));
    const name = book?.name || '';
    if (!await app.appConfirm({
      message: app.t('book.settings.deleteBookConfirm', { name }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;

    this.bookDeleteLoading = true;
    this.bookDeleteError = '';
    try {
      await contentRepo.deleteBook(bookId);
      app.showBookSettingsCard = false;
      app.selectedBookId = '';
      app.resetView();
      await app.loadBooks();
      app.setStatus(app.t('book.settings.deleteBookSummary', { name }), false, 5000);
    } catch (e) {
      this.bookDeleteError = app.t('book.settings.deleteBookFailed', { msg: e.message });
    } finally {
      this.bookDeleteLoading = false;
    }
  },

  // ── Sharing ────────────────────────────────────────────────────────────────

  async loadBookAccess() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) { this.bookAccessList = []; return; }
    this.bookAccessLoading = true;
    this.bookAccessError = '';
    try {
      const data = await fetchJson(`/books/${bookId}/access`);
      this.bookAccessList = data?.access || [];
    } catch (e) {
      this.bookAccessError = e.message;
    } finally {
      this.bookAccessLoading = false;
    }
  },

  // Owner darf sharen; Server enforced final.
  bookAccessIsOwner() {
    return window.__app.currentBookRole === 'owner';
  },

  shareInitials(entry) {
    const name = (entry?.display_name || '').trim();
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      return parts[0].slice(0, 2).toUpperCase();
    }
    const local = (entry?.user_email || '').split('@')[0];
    return local.slice(0, 2).toUpperCase();
  },

  shareAvatarStyle() {
    return {};
  },

  async loadShareUserPool() {
    try {
      const data = await fetchJson('/me/users-light');
      this.shareUserPool = Array.isArray(data?.users) ? data.users : [];
    } catch (e) {
      // Pool ist optional — Suggestions bleiben leer, Invite-Pfad geht weiter.
      this.shareUserPool = [];
    }
  },

  _shareEmailValid(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  shareCanInvite() {
    return !!window.__app.currentUser?.can_invite_users;
  },

  shareSuggestions() {
    const q = (this.shareEmail || '').trim().toLowerCase();
    const taken = new Set((this.bookAccessList || []).map(e => (e.user_email || '').toLowerCase()));
    const pool = (this.shareUserPool || []).filter(u => !taken.has((u.email || '').toLowerCase()));
    let matches = pool;
    if (q) {
      matches = pool.filter(u =>
        u.email.toLowerCase().includes(q) ||
        (u.display_name || '').toLowerCase().includes(q));
    }
    const list = matches.slice(0, 8).map(u => ({
      kind: 'user',
      key: 'user:' + u.email,
      email: u.email,
      label: u.display_name || u.email,
      sub: u.display_name ? u.email : '',
    }));
    // Invite-Option, wenn Eingabe eine gültige Email ist, kein User matcht und
    // der aktuelle User Invite-Recht hat. Auch nicht anzeigen, wenn die Email
    // bereits Zugriff hat.
    if (q && this._shareEmailValid(q) && !taken.has(q) && this.shareCanInvite()) {
      const exact = pool.find(u => u.email.toLowerCase() === q);
      if (!exact) {
        list.push({
          kind: 'invite',
          key: 'invite:' + q,
          email: q,
          label: window.__app.t('book.share.inviteOption', { email: q }),
          sub: '',
        });
      }
    }
    return list;
  },

  pickShareSuggestion(s) {
    if (!s) return;
    this.shareEmail = s.email;
    this.shareSuggestOpen = false;
    if (s.kind === 'invite') {
      this.submitShareInvite();
    }
  },

  shareSubmitLabel() {
    const q = (this.shareEmail || '').trim().toLowerCase();
    if (!q) return window.__app.t('book.share.inviteBtn');
    const taken = new Set((this.bookAccessList || []).map(e => (e.user_email || '').toLowerCase()));
    if (taken.has(q)) return window.__app.t('book.share.inviteBtn');
    const known = (this.shareUserPool || []).some(u => u.email.toLowerCase() === q);
    if (!known && this._shareEmailValid(q) && this.shareCanInvite()) {
      return window.__app.t('book.share.inviteAndShareBtn');
    }
    return window.__app.t('book.share.inviteBtn');
  },

  async submitShareInvite() {
    if (!this.bookAccessIsOwner()) return;
    const bookId = window.__app.selectedBookId;
    const email = (this.shareEmail || '').trim().toLowerCase();
    if (!bookId || !email) return;
    const known = (this.shareUserPool || []).some(u => u.email.toLowerCase() === email);
    if (!known && this._shareEmailValid(email) && this.shareCanInvite()) {
      this.shareBusy = true;
      this.bookAccessError = '';
      try {
        const r = await fetch('/me/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
        await this.loadShareUserPool();
      } catch (e) {
        this.bookAccessError = e.message;
        this.shareBusy = false;
        return;
      }
    }
    await this.shareBookAccessAdd();
  },

  async shareBookAccessAdd() {
    if (!this.bookAccessIsOwner()) return;
    const bookId = window.__app.selectedBookId;
    const email = (this.shareEmail || '').trim().toLowerCase();
    const role = this.shareRole;
    if (!bookId || !email) return;
    this.shareBusy = true;
    this.bookAccessError = '';
    try {
      const r = await fetch(`/books/${bookId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      this.shareEmail = '';
      this.shareSuggestOpen = false;
      await this.loadBookAccess();
    } catch (e) {
      this.bookAccessError = e.message;
    } finally {
      this.shareBusy = false;
    }
  },

  async changeBookAccessRole(email, newRole) {
    if (!this.bookAccessIsOwner()) return;
    const bookId = window.__app.selectedBookId;
    this.bookAccessError = '';
    try {
      const r = await fetch(`/books/${bookId}/access/${encodeURIComponent(email)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadBookAccess();
    } catch (e) {
      this.bookAccessError = e.message;
    }
  },

  async revokeBookAccess(email) {
    if (!this.bookAccessIsOwner()) return;
    const bookId = window.__app.selectedBookId;
    if (!await window.__app.appConfirm({
      message: window.__app.t('book.share.revokeConfirm', { email }),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;
    this.bookAccessError = '';
    try {
      const r = await fetch(`/books/${bookId}/access/${encodeURIComponent(email)}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadBookAccess();
    } catch (e) {
      this.bookAccessError = e.message;
    }
  },

  async transferOwnership(email) {
    if (!this.bookAccessIsOwner()) return;
    const bookId = window.__app.selectedBookId;
    if (!await window.__app.appConfirm({
      message: window.__app.t('book.share.transferConfirm', { email }),
      confirmLabel: window.__app.t('book.share.transferConfirmBtn'),
      danger: true,
    })) return;
    this.bookAccessError = '';
    try {
      const r = await fetch(`/books/${bookId}/transfer-ownership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      // Rollen cachen invalidieren + neu laden.
      window.__app.bookRoles = {};
      window.__app.currentBookRole = null;
      if (window.__app._loadBookRole) await window.__app._loadBookRole(bookId);
      await this.loadBookAccess();
    } catch (e) {
      this.bookAccessError = e.message;
    }
  },

  bookAccessRoleOptions() {
    const app = window.__app;
    return [
      { value: 'viewer', label: app.t('book.share.role.viewer') },
      { value: 'lektor', label: app.t('book.share.role.lektor') },
      { value: 'editor', label: app.t('book.share.role.editor') },
    ];
  },

  // Drill-Down: Typ-Zeile aufklappen → letzte N Runs nachladen.
  // Cache pro Typ in bookJobRuns; Re-Toggle schliesst nur, lädt nicht neu.
  async toggleJobRuns(type) {
    if (this.expandedJobType === type) {
      this.expandedJobType = null;
      return;
    }
    this.expandedJobType = type;
    if (this.bookJobRuns[type]) return;
    this.bookJobRunsLoading = true;
    try {
      const bookId = window.__app.selectedBookId;
      const runs = await fetchJson(`/jobs/runs?book_id=${encodeURIComponent(bookId)}&type=${encodeURIComponent(type)}&limit=20`);
      this.bookJobRuns[type] = runs;
    } catch (e) {
      console.error('[book-settings] Job-Runs laden fehlgeschlagen:', e);
      this.bookJobRuns[type] = [];
    } finally {
      this.bookJobRunsLoading = false;
    }
  },
};
