// Plot-Werkstatt: Strang-CRUD (Swimlanes) — Anlegen, Bearbeiten inkl.
// exklusiver Figuren-Bindung, Farb-Picker, Löschen, Reihenfolge.

import { fetchJson } from '../../utils.js';
import { ACT_PALETTE } from './constants.js';

export const threadsMethods = {
  async addThread() {
    const app = window.__app;
    const name = (this.newThreadName || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    this.busy = true;
    try {
      const thread = await fetchJson('/plot/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, name }),
      });
      this.threads = [...this.threads, thread];
      this._memos = {};
      this.newThreadName = '';
      this.addingThread = false;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  startEditThread(thread) {
    this.editingThreadId = thread.id;
    this.threadColorPickerId = null;
    this.threadDraft = {
      name: thread.name || '',
      farbe: thread.farbe || null,
      // Katalog-Bindung wird als TEXT-fig_id geführt (matcht $app.figuren),
      // Werkstatt-Bindung als INTEGER draft_figures.id.
      figure_id: thread.fig_id || '',
      draft_figure_id: thread.draft_figure_id || '',
      chapter_id: thread.chapter_id || '',
    };
    this.$nextTick(() => { this.$root?.querySelector('.plot-thread-name-input')?.focus(); });
  },
  cancelEditThread() { this.editingThreadId = null; },

  // Bindung ist exklusiv: eine Strang-Zeile gehört zu höchstens einer Figur.
  setThreadDraftFigure(figId) {
    this.threadDraft.figure_id = (this.threadDraft.figure_id === figId) ? '' : figId;
    if (this.threadDraft.figure_id) this.threadDraft.draft_figure_id = '';
  },
  setThreadDraftDraftFigure(draftId) {
    this.threadDraft.draft_figure_id = (this.threadDraft.draft_figure_id === draftId) ? '' : draftId;
    if (this.threadDraft.draft_figure_id) this.threadDraft.figure_id = '';
  },

  async saveEditThread(thread) {
    const app = window.__app;
    const name = (this.threadDraft.name || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/threads/${thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          farbe: this.threadDraft.farbe || null,
          figure_id: this.threadDraft.figure_id || null,
          draft_figure_id: this.threadDraft.draft_figure_id || null,
          chapter_id: this.threadDraft.chapter_id ? parseInt(this.threadDraft.chapter_id) : null,
        }),
      });
      this.threads = this.threads.map(t => (t.id === updated.id ? updated : t));
      this._memos = {};
      this.editingThreadId = null;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  toggleThreadColorPicker(threadId) {
    this.threadColorPickerId = this.threadColorPickerId === threadId ? null : threadId;
  },

  // Mobile-Kebab: Lane-Aktionen auf-/zuklappen (Single-Select). Desktop blendet
  // den Toggle aus und zeigt die Aktionen permanent (CSS).
  toggleThreadActions(threadId) {
    this.threadActionsOpenId = this.threadActionsOpenId === threadId ? null : threadId;
  },

  async setThreadColor(thread, key) {
    const app = window.__app;
    this.threadColorPickerId = null;
    const farbe = ACT_PALETTE.includes(key) ? key : null;
    if (farbe === (thread.farbe || null)) return;
    try {
      const updated = await fetchJson(`/plot/threads/${thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farbe }),
      });
      this.threads = this.threads.map(t => (t.id === updated.id ? updated : t));
      this._memos = {};
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    }
  },

  async deleteThread(thread) {
    const app = window.__app;
    const beatCount = (this.beats || []).filter(b => b.thread_id === thread.id).length;
    if (!await app.appConfirm({
      message: app.t('plot.thread.confirmDelete', { name: thread.name, n: beatCount }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/plot/threads/${thread.id}`, { method: 'DELETE' });
      this.threads = this.threads.filter(t => t.id !== thread.id);
      // Server setzt thread_id der Beats auf NULL (SET NULL) — lokal spiegeln,
      // die Beats fallen in die „ohne Strang"-Lane.
      this.beats = this.beats.map(b => (b.thread_id === thread.id ? { ...b, thread_id: null } : b));
      this._memos = {};
      if (this.editingThreadId === thread.id) this.editingThreadId = null;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
    } finally { this.busy = false; }
  },

  // Strang-Reihenfolge per Pfeil-Button (a11y, analog moveAct).
  async moveThread(thread, dir) {
    const app = window.__app;
    const ordered = [...this.threads].sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex(t => t.id === thread.id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ordered.length) return;
    [ordered[idx], ordered[swap]] = [ordered[swap], ordered[idx]];
    ordered.forEach((t, i) => { t.position = i; });
    this.threads = ordered;
    this._memos = {};
    try {
      await fetchJson('/plot/threads/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, order: ordered.map(t => t.id) }),
      });
    } catch (e) { this.errorMessage = app.t('plot.error.save'); }
  },
};
