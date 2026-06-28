// Teil von bookSettingsMethods (siehe Facade book-settings.js).
import { EVT, contentRepo, fetchJson } from './_shared.js';

export const adminMethods = {

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
        window.dispatchEvent(new CustomEvent(EVT.CHAT_RESET));
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
