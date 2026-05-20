// AdminLogsCard-Methods. Wird im adminLogsCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Liest aus /admin/logs/{tail,search,files,
// stream,download}.

export const adminLogsMethods = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async adminLogsEnter() {
    if (this.adminLogsInitialized) return;
    this.adminLogsInitialized = true;
    await this._adminLogsLoadTail();
    await this._adminLogsLoadFiles();
    if (this.adminLogsLiveTail) this._adminLogsStartStream();
  },

  _adminLogsLeave() {
    this._adminLogsStopStream();
  },

  // ── Filter ─────────────────────────────────────────────────────────────────
  adminLogsResetFilters() {
    this.adminLogsFilter = { level: '', scope: '', user: '', book: '', q: '' };
  },

  adminLogsHasFilter() {
    const f = this.adminLogsFilter;
    return !!(f.level || f.scope || f.user || f.book || f.q);
  },

  async adminLogsApplyFilter() {
    this._adminLogsStopStream();
    this.adminLogsEntries = [];
    this.adminLogsOldestTs = null;
    this.adminLogsHasMore = true;
    await this._adminLogsSearch({ append: false });
  },

  async adminLogsClearAndLive() {
    this.adminLogsResetFilters();
    this.adminLogsEntries = [];
    this.adminLogsOldestTs = null;
    this.adminLogsHasMore = true;
    await this._adminLogsLoadTail();
    if (this.adminLogsLiveTail) this._adminLogsStartStream();
  },

  // ── Tail / Search ──────────────────────────────────────────────────────────
  async _adminLogsLoadTail() {
    this.adminLogsLoading = true;
    this.adminLogsError = '';
    try {
      const r = await fetch('/admin/logs/tail?lines=500', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      // Server liefert chronologisch (alt → neu). UI zeigt neueste oben.
      const entries = (data.entries || []).reverse();
      this.adminLogsEntries = entries;
      const oldest = entries[entries.length - 1];
      this.adminLogsOldestTs = oldest?.ts || null;
      this.adminLogsHasMore = entries.length >= 500;
    } catch (e) {
      this.adminLogsError = e.message;
    } finally {
      this.adminLogsLoading = false;
    }
  },

  async _adminLogsSearch({ append }) {
    this.adminLogsLoading = true;
    this.adminLogsError = '';
    try {
      const qs = new URLSearchParams();
      const f = this.adminLogsFilter;
      if (f.level) qs.set('level', f.level);
      if (f.scope) qs.set('scope', f.scope);
      if (f.user)  qs.set('user',  f.user);
      if (f.book)  qs.set('book',  f.book);
      if (f.q)     qs.set('q',     f.q);
      qs.set('limit', '200');
      if (append && this.adminLogsOldestTs) qs.set('before', this.adminLogsOldestTs);
      const r = await fetch('/admin/logs/search?' + qs.toString(), { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      // Server liefert neueste zuerst (matched.push war reverse-iter).
      const next = data.entries || [];
      this.adminLogsEntries = append ? this.adminLogsEntries.concat(next) : next;
      const oldest = next[next.length - 1];
      if (oldest) this.adminLogsOldestTs = oldest.ts;
      this.adminLogsHasMore = !!data.hasMore;
    } catch (e) {
      this.adminLogsError = e.message;
    } finally {
      this.adminLogsLoading = false;
    }
  },

  async adminLogsLoadMore() {
    if (!this.adminLogsHasMore || this.adminLogsLoading) return;
    if (this.adminLogsHasFilter()) {
      await this._adminLogsSearch({ append: true });
    } else {
      // Ohne Filter: tail + alle aelteren rueckwaerts via search ohne Filter.
      await this._adminLogsSearch({ append: true });
    }
  },

  // ── Files ──────────────────────────────────────────────────────────────────
  async _adminLogsLoadFiles() {
    try {
      const r = await fetch('/admin/logs/files', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      this.adminLogsFiles = data.files || [];
    } catch { /* noop */ }
  },

  adminLogsDownload(file) {
    const key = encodeURIComponent(file?.key || 'current');
    window.location.href = `/admin/logs/download?file=${key}`;
  },

  // ── SSE-Stream ─────────────────────────────────────────────────────────────
  _adminLogsStartStream() {
    if (this.adminLogsEventSource) return;
    if (this.adminLogsHasFilter()) return; // Live-Tail nur ohne Filter
    try {
      const es = new EventSource('/admin/logs/stream', { withCredentials: true });
      this.adminLogsEventSource = es;
      es.onmessage = (ev) => {
        try {
          const entry = JSON.parse(ev.data);
          // Vorne anhaengen; Cap auf 5000 (FIFO).
          this.adminLogsEntries.unshift(entry);
          if (this.adminLogsEntries.length > 5000) {
            this.adminLogsEntries.length = 5000;
          }
        } catch { /* noop */ }
      };
      es.addEventListener('rotated', () => { this.adminLogsRotatedHint = true; });
      es.onerror = () => {
        // Nach Disconnect haengt SSE haeufig — Browser reconnected automatisch.
        // Nur error-Flag setzen, kein close.
        this.adminLogsStreamError = true;
      };
    } catch (e) {
      this.adminLogsStreamError = true;
    }
  },

  _adminLogsStopStream() {
    try { this.adminLogsEventSource?.close?.(); } catch {}
    this.adminLogsEventSource = null;
  },

  adminLogsToggleLiveTail() {
    this.adminLogsLiveTail = !this.adminLogsLiveTail;
    if (this.adminLogsLiveTail) {
      this.adminLogsRotatedHint = false;
      this.adminLogsStreamError = false;
      this._adminLogsStartStream();
    } else {
      this._adminLogsStopStream();
    }
  },

  // ── Row-State ──────────────────────────────────────────────────────────────
  adminLogsToggleStack(idx) {
    const k = String(idx);
    if (this.adminLogsExpanded[k]) delete this.adminLogsExpanded[k];
    else this.adminLogsExpanded[k] = true;
  },

  adminLogsRowKey(entry, idx) {
    return `${idx}:${entry.ts}`;
  },

  adminLogsFmtTs(ts) {
    if (!ts) return '';
    // ts ist "YYYY-MM-DD HH:MM:SS" lokale-Server-Zeit aus winston-Formatter.
    // Wir zeigen es 1:1 — Timezone-Anzeige im Header-Hinweis.
    return ts;
  },

  // Liefert eindeutige Liste vorhandener Scopes aus den geladenen Entries.
  adminLogsScopeOptions() {
    const set = new Set();
    for (const e of this.adminLogsEntries) {
      if (e.scope) set.add(e.scope);
    }
    return [...set].sort().map(s => ({ value: s, label: s }));
  },
};

export const ADMIN_LOGS_LEVELS = [
  { value: 'info',  label: 'INFO' },
  { value: 'warn',  label: 'WARN' },
  { value: 'error', label: 'ERROR' },
  { value: 'debug', label: 'DEBUG' },
];
