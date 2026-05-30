// AdminJsErrorsCard-Methods. Wird im adminJsErrorsCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Liest aus /admin/js-errors/list + DELETE.

import { tzOpts } from '../utils.js';

export const adminJsErrorsMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async jsErrorsEnter() {
    if (this.jsErrorsInitialized) return;
    this.jsErrorsInitialized = true;
    await this._jsErrorsLoad();
  },

  _jsErrorsLeave() { /* nichts zu raeumen */ },

  // ── Laden ────────────────────────────────────────────────────────────────
  async _jsErrorsLoad() {
    this.jsErrorsLoading = true;
    this.jsErrorsError = '';
    try {
      const r = await fetch('/admin/js-errors/list', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.jsErrorsList = data.errors || [];
      this.jsErrorsExpanded = {};
    } catch (e) {
      this.jsErrorsError = e.message;
    } finally {
      this.jsErrorsLoading = false;
    }
  },

  jsErrorsRefresh() {
    this.jsErrorsInitialized = false;
    return this.jsErrorsEnter();
  },

  jsErrorsToggle(id) {
    this.jsErrorsExpanded = { ...this.jsErrorsExpanded, [id]: !this.jsErrorsExpanded[id] };
  },

  // ── Loeschen ─────────────────────────────────────────────────────────────
  async jsErrorsDelete(id) {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.jsErrors.confirmDelete'),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await fetch('/admin/js-errors/' + encodeURIComponent(id), {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._jsErrorsLoad();
    } catch (e) {
      this.jsErrorsError = e.message;
    }
  },

  async jsErrorsClearAll() {
    const ok = await window.__app.appConfirm({
      message: window.__app.t('admin.jsErrors.confirmClear'),
      confirmLabel: window.__app.t('admin.jsErrors.clearAll'),
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await fetch('/admin/js-errors', { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this._jsErrorsLoad();
    } catch (e) {
      this.jsErrorsError = e.message;
    }
  },

  // ── Format ───────────────────────────────────────────────────────────────
  jsErrorsFmtTs(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(window.__app.uiLocale === 'en' ? 'en-US' : 'de-CH',
      tzOpts({ dateStyle: 'medium', timeStyle: 'medium' }));
  },

  // Quelle kompakt: nur Dateiname + Zeile (voller Pfad steht im Detail).
  jsErrorsLoc(e) {
    if (!e || !e.source) return '';
    let name = e.source;
    try { name = new URL(e.source).pathname.split('/').pop() || e.source; } catch { /* keep */ }
    return e.line ? `${name}:${e.line}` : name;
  },
};
