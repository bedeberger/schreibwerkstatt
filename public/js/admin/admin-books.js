// Admin-Karte: Buecher-Uebersicht + Owner-Zuweisung fuer ownerless Buecher.
// Methoden werden in Alpine.data('adminBooksCard') gespreadet.

import { fetchJson } from '../utils.js';

export const adminBooksMethods = {
  async loadAll() {
    this.loading = true;
    this.error = '';
    try {
      const [b, u] = await Promise.all([
        fetchJson('/admin/books'),
        fetchJson('/admin/users'),
      ]);
      this.books = b.books || [];
      this.users = (u.users || []).filter(usr => usr.status === 'active');
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  },

  ownerlessBooks() {
    return this.books.filter(b => !b.owner_email);
  },

  ownedBooks() {
    return this.books.filter(b => b.owner_email);
  },

  setAssignTarget(bookId, email) {
    this.assignTarget = { ...this.assignTarget, [bookId]: email };
  },

  async assignOwner(book) {
    const email = (this.assignTarget?.[book.book_id] || '').trim().toLowerCase();
    if (!email) {
      this.error = window.__app.t('admin.books.error.emailRequired');
      return;
    }
    if (!await window.__app.appConfirm({
      message: window.__app.t('admin.books.assignConfirm', { name: book.name, email }),
      confirmLabel: window.__app.t('admin.books.assignBtn'),
    })) return;

    this.busy = true;
    this.error = '';
    try {
      const r = await fetch(`/admin/books/${book.book_id}/assign-owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadAll();
    } catch (e) {
      this.error = e.message;
    } finally {
      this.busy = false;
    }
  },
};
