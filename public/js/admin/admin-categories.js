// Admin-Karte fuer den Kategorien- + Tag-Pool. CRUD-Methoden werden in
// Alpine.data('adminCategoriesCard') gespreadet.

import { fetchJson } from '../utils.js';

export const adminCategoriesMethods = {
  async loadAll() {
    this.loading = true;
    this.error = '';
    try {
      const [c, t] = await Promise.all([
        fetchJson('/local/categories'),
        fetchJson('/local/tags'),
      ]);
      this.categories = c.categories || [];
      this.tags = t.tags || [];
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  },

  async createCategory() {
    const name = (this.newCategoryName || '').trim();
    if (!name) return;
    this.busy = true;
    try {
      const r = await fetch('/local/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      this.newCategoryName = '';
      await this.loadAll();
    } catch (e) {
      this.error = e.message;
    } finally {
      this.busy = false;
    }
  },

  async renameCategory(cat) {
    const next = window.prompt(window.__app.t('admin.cat.renamePrompt'), cat.name);
    if (!next || next.trim() === cat.name) return;
    try {
      const r = await fetch(`/local/categories/${cat.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadAll();
    } catch (e) {
      this.error = e.message;
    }
  },

  async deleteCategory(cat) {
    if (!await window.__app.appConfirm({
      message: window.__app.t('admin.cat.deleteConfirm', { name: cat.name }),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;
    try {
      const r = await fetch(`/local/categories/${cat.id}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadAll();
    } catch (e) {
      this.error = e.message;
    }
  },

  async createTag() {
    const name = (this.newTagName || '').trim();
    if (!name) return;
    this.busy = true;
    try {
      const r = await fetch('/local/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      this.newTagName = '';
      await this.loadAll();
    } catch (e) {
      this.error = e.message;
    } finally {
      this.busy = false;
    }
  },

  async renameTag(tag) {
    const next = window.prompt(window.__app.t('admin.tag.renamePrompt'), tag.name);
    if (!next || next.trim() === tag.name) return;
    try {
      const r = await fetch(`/local/tags/${tag.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadAll();
    } catch (e) {
      this.error = e.message;
    }
  },

  async deleteTag(tag) {
    if (!await window.__app.appConfirm({
      message: window.__app.t('admin.tag.deleteConfirm', { name: tag.name, n: tag.book_count || 0 }),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;
    try {
      const r = await fetch(`/local/tags/${tag.id}`, { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      await this.loadAll();
    } catch (e) {
      this.error = e.message;
    }
  },
};
