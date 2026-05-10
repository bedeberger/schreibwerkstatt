// Methoden für die Figuren-Werkstatt-Karte (Sub-Komponente).
// CRUD über /draft-figures; KI-Brainstorm + Konsistenz-Check kommen in Phase 4.
// Mindmap-Inhalt wird hier read-only als verschachtelte Liste angezeigt;
// interaktiver Editor (jsMind) in Phase 4.

import { fetchJson } from './utils.js';

// Server persistiert Default-Knoten-Labels als `__i18n:werkstatt.tree.foo__`.
// Frontend löst beim Render via t() in die User-Locale auf.
const I18N_MARKER = /^__i18n:([a-zA-Z0-9_.-]+)__$/;
function resolveTopic(topic) {
  const m = I18N_MARKER.exec(topic || '');
  return m ? window.__app.t(m[1]) : (topic || '');
}

export const figurWerkstattMethods = {
  async loadDrafts() {
    const app = window.__app;
    const bookId = app?.selectedBookId;
    if (!bookId) { this.drafts = []; return; }
    this.loading = true;
    try {
      const rows = await fetchJson(`/draft-figures/${bookId}`);
      this.drafts = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      if (this.selectedDraftId && !this.drafts.find(d => d.id === this.selectedDraftId)) {
        this.selectedDraftId = null;
      }
      if (!this.selectedDraftId && this.drafts.length > 0) {
        this.selectDraft(this.drafts[0].id);
      }
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.load') || app.t('common.error');
      this.drafts = [];
    } finally {
      this.loading = false;
    }
  },

  resetDrafts() {
    this.drafts = [];
    this.selectedDraftId = null;
    this.editName = '';
    this.editArchetype = '';
    this.editNotes = '';
    this.creating = false;
    this.newName = '';
    this.errorMessage = '';
    this.busy = false;
  },

  selectDraft(id) {
    const d = this.drafts.find(x => x.id === id);
    if (!d) { this.selectedDraftId = null; return; }
    this.selectedDraftId = id;
    this.editName = d.name;
    this.editArchetype = d.archetype || '';
    this.editNotes = d.notes || '';
    this.creating = false;
  },

  selectedDraft() {
    if (!this.selectedDraftId) return null;
    return this.drafts.find(d => d.id === this.selectedDraftId) || null;
  },

  startCreate() {
    this.creating = true;
    this.newName = '';
    this.errorMessage = '';
    this.$nextTick(() => {
      const input = this.$el?.querySelector('.werkstatt-new-name');
      input?.focus();
    });
  },

  cancelCreate() {
    this.creating = false;
    this.newName = '';
  },

  async createDraft() {
    const app = window.__app;
    const name = (this.newName || '').trim();
    if (!name) { this.errorMessage = app.t('werkstatt.error.nameRequired') || app.t('common.error'); return; }
    const bookId = app.selectedBookId;
    if (!bookId) return;
    this.busy = true;
    try {
      const row = await fetchJson(`/draft-figures/${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.drafts = [row, ...this.drafts];
      this.creating = false;
      this.newName = '';
      this.selectDraft(row.id);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.create') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  async saveDraft() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) return;
    const name = (this.editName || '').trim();
    if (!name) { this.errorMessage = app.t('werkstatt.error.nameRequired') || app.t('common.error'); return; }
    this.busy = true;
    try {
      const updated = await fetchJson(`/draft-figures/${sel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          archetype: this.editArchetype || null,
          notes: this.editNotes || null,
          mindmap: sel.mindmap,
        }),
      });
      this.drafts = this.drafts.map(d => d.id === updated.id ? updated : d);
      this.errorMessage = '';
      this.savedAt = Date.now();
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.save') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  async requestDelete() {
    const sel = this.selectedDraft();
    if (!sel) return;
    const app = window.__app;
    const ok = await app.appConfirm({
      message: app.t('werkstatt.confirmDelete'),
      danger: true,
    });
    if (!ok) return;
    await this._doDelete(sel.id);
  },

  async _doDelete(id) {
    const app = window.__app;
    this.busy = true;
    try {
      await fetchJson(`/draft-figures/${id}`, { method: 'DELETE' });
      this.drafts = this.drafts.filter(d => d.id !== id);
      if (this.selectedDraftId === id) {
        this.selectedDraftId = null;
        this.editName = '';
        this.editArchetype = '';
        this.editNotes = '';
        if (this.drafts.length > 0) this.selectDraft(this.drafts[0].id);
      }
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.delete') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  mindmapNodes() {
    const sel = this.selectedDraft();
    if (!sel?.mindmap?.data) return [];
    const flat = [];
    const walk = (node, depth) => {
      flat.push({ id: node.id, topic: resolveTopic(node.topic), depth });
      for (const c of node.children || []) walk(c, depth + 1);
    };
    walk(sel.mindmap.data, 0);
    return flat;
  },
};

export { resolveTopic };
