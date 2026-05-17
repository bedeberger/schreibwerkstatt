// Buch/Kapitel/Seite-Export. Methoden in Alpine.data('exportCard') gespreadet;
// Root-Zugriffe via window.__app.

export const exportMethods = {
  async bookExport(fmt) {
    const ref = this._exportEntity();
    if (!ref || this.bookExportLoading) return;
    this.bookExportLoading = fmt;
    this.bookExportError = '';
    try {
      const url = `/export/${encodeURIComponent(ref.scope)}/${encodeURIComponent(ref.id)}/${encodeURIComponent(fmt)}`;
      const r = await fetch(url);
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch (_) {}
        throw new Error(data ? window.__app.tError(data) : `HTTP ${r.status}`);
      }
      const cd = r.headers.get('content-disposition') || '';
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const filename = m ? m[1] : `${ref.scope}.${fmt}`;
      const blob = await r.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    } catch (e) {
      this.bookExportError = e.message || String(e);
    } finally {
      this.bookExportLoading = null;
    }
  },

  _exportEntity() {
    const app = window.__app;
    if (!app) return null;
    const scope = this.exportScope || 'book';
    if (scope === 'page') {
      const pid = app.currentPage?.id;
      if (pid) return { scope: 'page', id: pid };
    }
    if (scope === 'chapter') {
      const cid = app.currentPage?.chapter_id;
      if (cid) return { scope: 'chapter', id: cid };
    }
    const bid = app.selectedBookId;
    if (bid) return { scope: 'book', id: parseInt(bid) };
    return null;
  },

  exportScopeOptions() {
    const app = window.__app;
    const opts = [{ value: 'book', label: app?.t?.('export.scope.book') || 'Buch' }];
    if (app?.currentPage?.chapter_id) opts.push({ value: 'chapter', label: app.t('export.scope.chapter') });
    if (app?.currentPage?.id)         opts.push({ value: 'page',    label: app.t('export.scope.page') });
    return opts;
  },
};
