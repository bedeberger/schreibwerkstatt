// AdminParseFailsCard-Methods. Wird im adminParseFailsCard-Alpine-Scope
// gespreaded. Root-Zugriffe via window.__app. Liest aus
// /admin/parse-fails/{files,file} + DELETE.

import { tzOpts } from '../utils.js';

export const adminParseFailsMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async parseFailsEnter() {
    if (this.parseFailsInitialized) return;
    this.parseFailsInitialized = true;
    await this._parseFailsLoadFiles();
  },

  _parseFailsLeave() { /* nichts zu raeumen */ },

  // ── Laden ────────────────────────────────────────────────────────────────
  async _parseFailsLoadFiles() {
    this.parseFailsLoading = true;
    this.parseFailsError = '';
    try {
      const r = await fetch('/admin/parse-fails/files', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.parseFailsFiles = data.files || [];
      this.parseFailsContent = {};
      this.parseFailsExpanded = {};
    } catch (e) {
      this.parseFailsError = e.message;
    } finally {
      this.parseFailsLoading = false;
    }
  },

  parseFailsRefresh() {
    this.parseFailsInitialized = false;
    return this.parseFailsEnter();
  },

  // ── Content anzeigen ─────────────────────────────────────────────────────
  async parseFailsToggle(name) {
    if (this.parseFailsExpanded[name]) {
      this.parseFailsExpanded = { ...this.parseFailsExpanded, [name]: false };
      return;
    }
    if (this.parseFailsContent[name] === undefined) {
      try {
        const r = await fetch('/admin/parse-fails/file?name=' + encodeURIComponent(name), { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const txt = data.truncated
          ? data.content + '\n\n[…' + window.__app.t('admin.parseFails.truncated') + ']'
          : data.content;
        this.parseFailsContent = { ...this.parseFailsContent, [name]: txt };
      } catch (e) {
        this.parseFailsError = e.message;
        return;
      }
    }
    this.parseFailsExpanded = { ...this.parseFailsExpanded, [name]: true };
  },

  // ── Loeschen ─────────────────────────────────────────────────────────────
  async parseFailsDelete(name) {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.parseFails.confirmDelete'),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await fetch('/admin/parse-fails/file?name=' + encodeURIComponent(name), {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._parseFailsLoadFiles();
    } catch (e) {
      this.parseFailsError = e.message;
    }
  },

  async parseFailsClearAll() {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.parseFails.confirmClear'),
      confirmLabel: window.__app.t('admin.parseFails.clearAll'),
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await fetch('/admin/parse-fails', { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._parseFailsLoadFiles();
    } catch (e) {
      this.parseFailsError = e.message;
    }
  },

  // ── Format ───────────────────────────────────────────────────────────────
  parseFailsFmtTs(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH',
      tzOpts({ dateStyle: 'medium', timeStyle: 'medium' }));
  },

  parseFailsFmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  },
};
