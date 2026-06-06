// Buch-Einstellungen (Sprache, Region, Buchtyp, Perspektive, Zeit, Kontext).
// Methoden werden in Alpine.data('bookSettingsCard') gespreadet;
// Root-Zugriffe via window.__app.

import { fetchJson } from '../utils.js';
import { contentRepo } from '../repo/content.js';
import { countryOptions } from '../country-codes.js';

export const bookSettingsMethods = {
  async loadBookSettings() {
    if (!window.__app.selectedBookId) return;
    this.bookSettingsLoading = true;
    try {
      const data = await fetchJson(`/booksettings/${window.__app.selectedBookId}`);
      const book = window.__app.books.find(b => String(b.id) === String(window.__app.selectedBookId));
      this.bookSettingsName       = book?.name || '';
      this.bookSettingsLanguage  = data.language    || 'de';
      this.bookSettingsRegion    = data.region      || 'CH';
      this.bookSettingsBuchtyp   = data.buchtyp     || '';
      this.bookSettingsBuchKontext = data.buch_kontext || '';
      this.bookSettingsErzaehlperspektive = data.erzaehlperspektive || '';
      this.bookSettingsErzaehlzeit        = data.erzaehlzeit        || '';
      this.bookSettingsIsFinished         = !!data.is_finished;
      this.bookSettingsAllowLektorBookChat = !!data.allow_lektor_book_chat;
      this.bookSettingsDailyGoalChars     = data.daily_goal_chars != null ? Number(data.daily_goal_chars) : 1500;
      this.bookSettingsOrteReal           = !!data.orte_real;
      this.bookSettingsSchauplatzLand     = data.schauplatz_land || '';
    } catch (e) {
      console.error('[book-settings] Laden fehlgeschlagen:', e);
    } finally {
      this.bookSettingsLoading = false;
    }
  },

  // Kategorie. Pool global; pro Buch eine Kategorie (optional).
  async loadBookCategory() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    try {
      const [pool, categoryRes] = await Promise.all([
        fetchJson('/local/categories'),
        fetchJson(`/books/${bookId}/category`),
      ]);
      this.categoryPool = pool.categories || [];
      this.bookCategoryId = categoryRes.category?.id || '';
    } catch (e) {
      console.error('[book-settings] Kategorie laden fehlgeschlagen:', e);
    }
  },

  bookCategoryOptions() {
    return (this.categoryPool || []).map(c => ({ value: String(c.id), label: c.name }));
  },

  async saveBookCategory(value) {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    // value aus combobox-change-Event-Detail; x-modelable-Sync zu bookCategoryId
    // ist beim Dispatch noch nicht propagiert (stale read).
    const raw = value !== undefined ? value : this.bookCategoryId;
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
      await window.__app.loadBooks({ skipPages: true });
    } catch (e) {
      this.bookSettingsError = e.message;
    }
  },

  // Ein Header-Save-Button schreibt BEIDE Stores: book_settings (/booksettings)
  // UND book_publication (/publication). Beide sind unabhängige Full-Replace-
  // Writes auf getrennte Tabellen — ein Klick persistiert alles, egal in welchem
  // Tab editiert wurde (Titelei/Klappentext im Publikation-Tab + Sprache/Kontext/
  // Tagesziel in den anderen Tabs). Beide laufen parallel; die Header-Status-
  // Getter aggregieren über beide. Methoden (keine Getter) — bookSettingsMethods
  // wird gespreadet, Getter würden beim Spread eval't statt durchgereicht.
  async saveActiveTab() { await Promise.all([this.saveBookSettings(), this.savePublication()]); },
  headerSaving()   { return this.bookSettingsSaving || this.pubSaving; },
  headerError()    { return this.bookSettingsError || this.pubError; },
  headerSaved()    { return (this.bookSettingsSaved || this.pubSaved) && !this.headerError(); },
  headerDisabled() { return this.bookSettingsSaving || this.pubSaving || this.bookSettingsLoading; },

  async saveBookSettings() {
    if (!window.__app.selectedBookId) return;
    this.bookSettingsSaving = true;
    this.bookSettingsSaved  = false;
    this.bookSettingsError  = '';
    try {
      const bookId = window.__app.selectedBookId;
      const currentBook = window.__app.books.find(b => String(b.id) === String(bookId));
      const newName = (this.bookSettingsName || '').trim();
      if (!newName) throw new Error(window.__app.t('book.create.errorEmpty'));
      if (newName !== (currentBook?.name || '')) {
        await contentRepo.updateBook(bookId, { name: newName });
      }
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
          daily_goal_chars:  Number.isFinite(Number(this.bookSettingsDailyGoalChars)) ? Number(this.bookSettingsDailyGoalChars) : null,
          orte_real:         this.bookSettingsOrteReal ? 1 : 0,
          schauplatz_land:   this.bookSettingsSchauplatzLand || null,
        }),
      });
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch (_) {}
        throw new Error(data ? window.__app.tError(data) : `HTTP ${r.status}`);
      }
      this.bookSettingsSaved = true;
      const newBuchtyp = this.bookSettingsBuchtyp || null;
      const buchtypChanged = (currentBook?.buchtyp ?? null) !== newBuchtyp;
      if (newName !== (currentBook?.name || '') || buchtypChanged) {
        await window.__app.loadBooks?.({ skipPages: true, fresh: true });
      }
      // Header-Donut konsumiert dailyProgressIsFinished + dailyProgressDailyGoalChars
      // am Root — direkt spiegeln, damit Toggle Buch-Abschluss und neues Tagesziel
      // ohne Reload greifen.
      if (window.__app) {
        window.__app.dailyProgressIsFinished = !!this.bookSettingsIsFinished;
        window.__app.dailyProgressDailyGoalChars = Number.isFinite(Number(this.bookSettingsDailyGoalChars))
          ? Number(this.bookSettingsDailyGoalChars) : null;
      }
      if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
      this._savedAtTimer = setTimeout(() => { this.bookSettingsSaved = false; this._savedAtTimer = null; }, 2500);
    } catch (e) {
      this.bookSettingsError = e.message;
    } finally {
      this.bookSettingsSaving = false;
    }
  },

  // ── Publikation (book_publication: Cover/Titelei/Bio, geteilt mit PDF+EPUB) ──
  async loadPublication() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    try {
      this.bookPublication = await fetchJson(`/publication/${bookId}`);
      this.bookPublicationLoaded = true;
    } catch (e) {
      console.error('[book-settings] Publikation laden fehlgeschlagen:', e);
    }
  },

  async savePublication() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    // Nicht speichern, bevor die volle Meta geladen ist — der strikte Full-
    // Replace-Upsert würde den DB-Stand sonst mit leeren Defaults überschreiben.
    // saveActiveTab ruft uns auf jedem Save-Klick auf, auch ohne Publikations-Edit.
    if (!this.bookPublicationLoaded) return;
    this.pubSaving = true; this.pubSaved = false; this.pubError = '';
    try {
      // Volle geladene Meta zurueckschreiben — der strikte Upsert setzt jedes
      // NICHT gesendete Feld auf Default. Spread statt Hand-Liste: validateMeta
      // whitelistet serverseitig (Extra-Keys wie has_cover ignoriert), so dass
      // auch die EPUB-Card-eigenen Felder (Typografie/OPF) erhalten bleiben.
      const p = this.bookPublication || {};
      const r = await fetch(`/publication/${bookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...p }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(window.__app.tError(d) || `HTTP ${r.status}`); }
      this.bookPublication = await r.json();
      this.pubSaved = true;
      if (this._pubSavedTimer) clearTimeout(this._pubSavedTimer);
      this._pubSavedTimer = setTimeout(() => { this.pubSaved = false; this._pubSavedTimer = null; }, 2500);
    } catch (e) {
      this.pubError = e.message;
    } finally {
      this.pubSaving = false;
    }
  },

  async uploadPublicationCover(ev) {
    const file = ev?.target?.files?.[0];
    const bookId = window.__app.selectedBookId;
    if (!file || !bookId) return;
    this.pubCoverUploading = true; this.pubCoverError = '';
    try {
      const r = await fetch(`/publication/${bookId}/cover`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.pubCoverError = window.__app.tError(d) || window.__app.t('publication.imageInvalid'); return; }
      this.pubPreviewVersion++;
      await this.loadPublication();
    } finally {
      this.pubCoverUploading = false;
      ev.target.value = '';
    }
  },

  async removePublicationCover() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    const r = await fetch(`/publication/${bookId}/cover`, { method: 'DELETE' });
    if (!r.ok) return;
    this.pubPreviewVersion++;
    await this.loadPublication();
  },

  publicationCoverUrl() {
    const bookId = window.__app.selectedBookId;
    if (!this.bookPublication?.has_cover || !bookId) return '';
    return `/publication/${bookId}/cover?v=${this.pubPreviewVersion}`;
  },

  async uploadPublicationAuthorImage(ev) {
    const file = ev?.target?.files?.[0];
    const bookId = window.__app.selectedBookId;
    if (!file || !bookId) return;
    this.pubAuthorUploading = true; this.pubAuthorError = '';
    try {
      const r = await fetch(`/publication/${bookId}/author-image`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.pubAuthorError = window.__app.tError(d) || window.__app.t('publication.imageInvalid'); return; }
      this.pubPreviewVersion++;
      await this.loadPublication();
    } finally {
      this.pubAuthorUploading = false;
      ev.target.value = '';
    }
  },

  async removePublicationAuthorImage() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    const r = await fetch(`/publication/${bookId}/author-image`, { method: 'DELETE' });
    if (!r.ok) return;
    this.pubPreviewVersion++;
    await this.loadPublication();
  },

  publicationAuthorImageUrl() {
    const bookId = window.__app.selectedBookId;
    if (!this.bookPublication?.has_author_image || !bookId) return '';
    return `/publication/${bookId}/author-image?v=${this.pubPreviewVersion}`;
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

  // Haupt-Schauplatzland: ISO-3166-1-alpha-2-Liste, lokalisierte Labels.
  // emptyLabel-Option ('') = „nicht festgelegt", via Combobox-emptyLabel ergänzt.
  bookSettingsLandOptions() {
    const lang = this.bookSettingsLanguage || 'de';
    return countryOptions(lang);
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

  _shareEmailValid(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  shareCanInvite() {
    return !!window.__app.currentUser?.can_invite_users;
  },

  // Versucht zuerst zu teilen; existiert der User noch nicht (USER_NOT_FOUND)
  // und darf der aktuelle User einladen, wird stattdessen eine Einladung
  // verschickt. Geteilt wird dann erst nach Annahme der Einladung.
  async submitShareInvite() {
    if (!this.bookAccessIsOwner()) return;
    const bookId = window.__app.selectedBookId;
    const email = (this.shareEmail || '').trim().toLowerCase();
    const role = this.shareRole;
    if (!bookId || !email) return;
    if (!this._shareEmailValid(email)) {
      this.bookAccessError = window.__app.t('book.share.emailInvalid');
      return;
    }
    this.shareBusy = true;
    this.bookAccessError = '';
    this.shareInviteMessage = '';
    if (this._shareInviteMsgTimer) { clearTimeout(this._shareInviteMsgTimer); this._shareInviteMsgTimer = null; }
    try {
      const shareRes = await fetch(`/books/${bookId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const shareData = await shareRes.json().catch(() => ({}));
      if (shareRes.ok) {
        this.shareEmail = '';
        await this.loadBookAccess();
        return;
      }
      if (shareData?.error_code === 'USER_NOT_FOUND' && this.shareCanInvite()) {
        const inviteRes = await fetch('/me/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const inviteData = await inviteRes.json().catch(() => ({}));
        if (!inviteRes.ok) throw new Error(window.__app.tError(inviteData) || `HTTP ${inviteRes.status}`);
        this.shareEmail = '';
        this.shareInviteMessage = window.__app.t('book.share.inviteSent', { email });
        this._shareInviteMsgTimer = setTimeout(() => { this.shareInviteMessage = ''; this._shareInviteMsgTimer = null; }, 6000);
        return;
      }
      throw new Error(window.__app.tError(shareData) || `HTTP ${shareRes.status}`);
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

  // ── Blog-Sync (WordPress) ─────────────────────────────────────────────────
  // Methoden + Hilfsfunktionen für den Blog-Verbindungs-Tab im BookSettings-Card.
  // Sichtbar nur bei buchtyp === 'blog'. State lebt im Card-Init (blogForm,
  // blogConnection, blogBusy, blogAction, blogMessage, blogError, blogImportJobId,
  // blogPullJobId). Job-Status-Polling läuft via root job-queue events.

  async loadBlogStatus() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    try {
      const data = await fetchJson(`/blog/${bookId}/status`);
      this.blogConnection = data.connection || null;
      if (this.blogConnection) {
        this.blogForm.baseUrl       = this.blogConnection.baseUrl || '';
        this.blogForm.username      = this.blogConnection.username || '';
        this.blogForm.defaultStatus = this.blogConnection.defaultStatus || 'draft';
      }
      await this._rehydrateBlogJobs(bookId);
    } catch (e) {
      console.error('[blog] Status laden fehlgeschlagen:', e);
    }
  },

  // Reload/Tab-Reopen: lokales blogImportJobId/blogPullJobId neu binden, falls
  // serverseitig noch ein Job für (book, user) läuft — sonst zeigt der Button
  // weder Spinner noch Disable, bis User erneut klickt.
  async _rehydrateBlogJobs(bookId) {
    const probe = async (type) => {
      try {
        const { jobId, status } = await fetchJson(`/jobs/active?type=${type}&book_id=${bookId}`);
        return (jobId && (status === 'running' || status === 'queued')) ? jobId : null;
      } catch { return null; }
    };
    const [importId, pullId, reconcileId] = await Promise.all([
      probe('blog-import'), probe('blog-pull'), probe('blog-reconcile'),
    ]);
    this.blogImportJobId = importId;
    this.blogPullJobId = pullId;
    this.blogReconcileJobId = reconcileId;
  },

  blogStatusOptions() {
    const app = window.__app;
    return [
      { value: 'draft',   label: app.t('blog.status.draft') },
      { value: 'publish', label: app.t('blog.status.publish') },
      { value: 'private', label: app.t('blog.status.private') },
    ];
  },

  blogFormReady() {
    return !!(this.blogForm.baseUrl && this.blogForm.username
              && (this.blogForm.password || this.blogConnection));
  },

  _setBlogBusy(action) {
    this.blogBusy = !!action;
    this.blogAction = action || null;
    if (action) { this.blogMessage = ''; this.blogError = ''; }
  },

  async testBlogConnection() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || !this.blogFormReady()) return;
    this._setBlogBusy('test');
    try {
      const res = await fetch(`/blog/${bookId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: this.blogForm.baseUrl.trim(),
          username: this.blogForm.username.trim(),
          password: this.blogForm.password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_code || 'BLOG_TEST_FAILED');
      this.blogMessage = window.__app.t('blog.connect.testOk', { name: data.name || this.blogForm.username });
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    } finally {
      this._setBlogBusy(null);
    }
  },

  async saveBlogConnection() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || !this.blogFormReady()) return;
    this._setBlogBusy('save');
    try {
      const body = {
        baseUrl: this.blogForm.baseUrl.trim(),
        username: this.blogForm.username.trim(),
        defaultStatus: this.blogForm.defaultStatus || 'draft',
      };
      if (this.blogForm.password) body.password = this.blogForm.password;
      else if (this.blogConnection) body.password = '__keep__';
      const res = await fetch(`/blog/${bookId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_code || 'BLOG_SAVE_FAILED');
      this.blogConnection = data.connection;
      this.blogForm.password = '';
      this.blogMessage = window.__app.t('blog.connect.saved');
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    } finally {
      this._setBlogBusy(null);
    }
  },

  async disconnectBlog() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    if (!confirm(window.__app.t('blog.connect.disconnectConfirm'))) return;
    this._setBlogBusy('disconnect');
    try {
      const res = await fetch(`/blog/${bookId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('BLOG_DISCONNECT_FAILED');
      this.blogConnection = null;
      this.blogForm.password = '';
      this.blogMessage = window.__app.t('blog.connect.disconnected');
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    } finally {
      this._setBlogBusy(null);
    }
  },

  async startBlogImport() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.blogImportJobId) return;
    try {
      const res = await fetch('/jobs/blog-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'BLOG_IMPORT_FAILED');
      this.blogImportJobId = data.jobId;
      window.dispatchEvent(new CustomEvent('job:enqueued', { detail: { type: 'blog-import', jobId: data.jobId } }));
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    }
  },

  async startBlogPull() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.blogPullJobId) return;
    try {
      const res = await fetch('/jobs/blog-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'BLOG_PULL_FAILED');
      this.blogPullJobId = data.jobId;
      window.dispatchEvent(new CustomEvent('job:enqueued', { detail: { type: 'blog-pull', jobId: data.jobId } }));
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    }
  },

  async startBlogReconcile() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.blogReconcileJobId) return;
    if (!confirm(window.__app.t('blog.action.reconcileConfirm'))) return;
    try {
      const res = await fetch('/jobs/blog-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'BLOG_RECONCILE_FAILED');
      this.blogReconcileJobId = data.jobId;
      window.dispatchEvent(new CustomEvent('job:enqueued', { detail: { type: 'blog-reconcile', jobId: data.jobId } }));
    } catch (e) {
      this.blogError = window.__app.t('blog.error.' + e.message) || e.message;
    }
  },

  // ─── HubSpot-Sync ────────────────────────────────────────────────────────
  // Sichtbar nur bei buchtyp === 'blog'. State im Card-Init: hubspotConnection,
  // hubspotForm, hubspotBusy/Action/Message/Error, hubspotBlogs, hubspotAuthors,
  // hubspotImportJobId. Job-Status-Polling via job-queue events.

  async loadHubspotStatus() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    try {
      const data = await fetchJson(`/hubspot/${bookId}/status`);
      this.hubspotConnection = data.connection || null;
      if (this.hubspotConnection) {
        this.hubspotForm.blogId   = this.hubspotConnection.blogId || '';
        this.hubspotForm.authorId = this.hubspotConnection.authorId || '';
        // Listen mit dem gespeicherten Token nachladen, damit Combos den
        // aktuellen Wert anzeigen können (Label statt nur ID).
        this.loadHubspotLists().catch(() => { /* still OK ohne Listen */ });
      }
      await this._reattachHubspotJobs(bookId);
    } catch (e) {
      console.error('[hubspot] Status laden fehlgeschlagen:', e);
    }
  },

  async _reattachHubspotJobs(bookId) {
    const probe = async (type) => {
      try {
        const list = await fetchJson(`/jobs/active?book_id=${encodeURIComponent(bookId)}&type=${encodeURIComponent(type)}`);
        return Array.isArray(list) && list.length ? list[0].jobId : null;
      } catch { return null; }
    };
    const [importId, reconcileId] = await Promise.all([
      probe('hubspot-import'), probe('hubspot-reconcile'),
    ]);
    this.hubspotImportJobId = importId;
    this.hubspotReconcileJobId = reconcileId;
  },

  hubspotFormReady() {
    const hasToken = !!this.hubspotForm.token || !!this.hubspotConnection;
    return hasToken && !!this.hubspotForm.blogId && !!this.hubspotForm.authorId;
  },

  _setHubspotBusy(action) {
    this.hubspotBusy = !!action;
    this.hubspotAction = action || null;
    if (action) { this.hubspotMessage = ''; this.hubspotError = ''; }
  },

  hubspotBlogOptions() {
    return (this.hubspotBlogs || []).map(b => ({ value: b.id, label: b.name }));
  },

  hubspotAuthorOptions() {
    return (this.hubspotAuthors || []).map(a => ({
      value: a.id,
      label: a.email ? `${a.name} <${a.email}>` : a.name,
    }));
  },

  async testHubspotConnection() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    this._setHubspotBusy('test');
    try {
      const body = {};
      if (this.hubspotForm.token) body.token = this.hubspotForm.token;
      else if (this.hubspotConnection) body.token = '__keep__';
      const res = await fetch(`/hubspot/${bookId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_TEST_FAILED');
      this.hubspotMessage = window.__app.t('hubspot.connect.testOk');
      await this.loadHubspotLists();
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    } finally {
      this._setHubspotBusy(null);
    }
  },

  async loadHubspotLists() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    const tokenQ = this.hubspotForm.token
      ? `?token=${encodeURIComponent(this.hubspotForm.token)}`
      : '';
    try {
      const [blogs, authors] = await Promise.all([
        fetchJson(`/hubspot/${bookId}/blogs${tokenQ}`),
        fetchJson(`/hubspot/${bookId}/authors${tokenQ}`),
      ]);
      this.hubspotBlogs = blogs.blogs || [];
      this.hubspotAuthors = authors.authors || [];
    } catch (e) {
      console.error('[hubspot] Blogs/Authors laden fehlgeschlagen:', e);
    }
  },

  async saveHubspotConnection() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || !this.hubspotFormReady()) return;
    this._setHubspotBusy('save');
    try {
      const body = {
        blogId: this.hubspotForm.blogId,
        authorId: this.hubspotForm.authorId,
      };
      if (this.hubspotForm.token) body.token = this.hubspotForm.token;
      else if (this.hubspotConnection) body.token = '__keep__';
      const res = await fetch(`/hubspot/${bookId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_SAVE_FAILED');
      this.hubspotConnection = data.connection;
      this.hubspotForm.token = '';
      this.hubspotMessage = window.__app.t('hubspot.connect.saved');
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    } finally {
      this._setHubspotBusy(null);
    }
  },

  async disconnectHubspot() {
    const bookId = window.__app.selectedBookId;
    if (!bookId) return;
    if (!confirm(window.__app.t('hubspot.connect.disconnectConfirm'))) return;
    this._setHubspotBusy('disconnect');
    try {
      const res = await fetch(`/hubspot/${bookId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('HUBSPOT_DISCONNECT_FAILED');
      this.hubspotConnection = null;
      this.hubspotForm = { token: '', blogId: '', authorId: '' };
      this.hubspotBlogs = [];
      this.hubspotAuthors = [];
      this.hubspotMessage = window.__app.t('hubspot.connect.disconnected');
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    } finally {
      this._setHubspotBusy(null);
    }
  },

  async startHubspotImport() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.hubspotImportJobId) return;
    try {
      const res = await fetch('/jobs/hubspot-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_IMPORT_FAILED');
      this.hubspotImportJobId = data.jobId;
      window.dispatchEvent(new CustomEvent('job:enqueued', { detail: { type: 'hubspot-import', jobId: data.jobId } }));
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    }
  },

  async startHubspotReconcile() {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.hubspotReconcileJobId) return;
    if (!confirm(window.__app.t('hubspot.action.reconcileConfirm'))) return;
    try {
      const res = await fetch('/jobs/hubspot-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_code || 'HUBSPOT_RECONCILE_FAILED');
      this.hubspotReconcileJobId = data.jobId;
      window.dispatchEvent(new CustomEvent('job:enqueued', { detail: { type: 'hubspot-reconcile', jobId: data.jobId } }));
    } catch (e) {
      this.hubspotError = window.__app.t('hubspot.error.' + e.message) || e.message;
    }
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
