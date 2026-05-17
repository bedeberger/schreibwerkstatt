// AdminUsageCard-Methods.
// Wird im adminUsageCard-Alpine-Scope gespreaded. Root-Zugriffe ueber
// `window.__app`. Privacy: Admin sieht USD/Tokens + book_id (anonym), keine
// Buchtitel.

import { loadChart } from '../lazy-libs.js';

function _fmt(n, locale, opts) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale, opts).format(n);
}

function _money(n, locale) {
  return _fmt(n, locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _int(n, locale) {
  return _fmt(n, locale, { maximumFractionDigits: 0 });
}

function _hhmm(seconds) {
  if (!seconds || seconds < 60) return seconds ? '< 1 min' : '0 min';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h <= 0) return `${m} min`;
  return `${h}h ${m}m`;
}

export const adminUsageMethods = {
  // ── Locale-Helper (Templates rufen so) ────────────────────────────────────
  adminUsageMoney(n) { return _money(n, this._adminUsageLocale()); },
  adminUsageInt(n)   { return _int(n,   this._adminUsageLocale()); },
  adminUsageHhmm(seconds) { return _hhmm(seconds); },
  _adminUsageLocale() {
    return (window.__app?.uiLocale === 'en') ? 'en-US' : 'de-CH';
  },

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async adminUsageEnter() {
    if (!this.adminUsageInitialized) {
      this.adminUsageInitialized = true;
      // Default: aktueller Monat (firstOfMonth UTC → now)
      this.adminUsageFrom = this._adminUsageMonthStart();
      this.adminUsageTo = '';
    }
    await this.adminUsageLoadTab();
  },

  _adminUsageMonthStart() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString().slice(0, 10);
  },

  async adminUsageSelectTab(tab) {
    if (this.adminUsageTab === tab) return;
    this.adminUsageTab = tab;
    await this.adminUsageLoadTab();
  },

  async adminUsageLoadTab() {
    this.adminUsageError = '';
    const tab = this.adminUsageTab;
    if (tab === 'users')    return this.adminUsageLoadUsers();
    if (tab === 'summary')  return this.adminUsageLoadSummary();
    if (tab === 'jobs')     return this.adminUsageLoadJobs();
    if (tab === 'chat')     return this.adminUsageLoadChat();
    if (tab === 'features') return this.adminUsageLoadFeatures();
    if (tab === 'time')     return this.adminUsageLoadTime();
  },

  _adminUsageQuery() {
    const qs = new URLSearchParams();
    if (this.adminUsageFrom) qs.set('from', this.adminUsageFrom);
    if (this.adminUsageTo)   qs.set('to',   this.adminUsageTo);
    return qs.toString();
  },

  async _adminUsageFetch(path) {
    const qs = this._adminUsageQuery();
    const url = path + (qs ? (path.includes('?') ? '&' : '?') + qs : '');
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_code || `HTTP ${r.status}`);
    }
    return r.json();
  },

  // ── Tab: Users (Liste + Budget-Edit) ───────────────────────────────────────
  async adminUsageLoadUsers() {
    if (this.adminUsageLoading) return;
    this.adminUsageLoading = true;
    try {
      const data = await this._adminUsageFetch('/admin/usage/users');
      this.adminUsageUsersList = (data.users || []).map(u => ({
        ...u,
        _draftBudget: u.monthlyBudgetUsd ?? '',
        _draftMode: u.budgetMode || 'none',
        _saving: false,
        _savedAt: 0,
      }));
    } catch (e) { this.adminUsageError = e.message; }
    finally { this.adminUsageLoading = false; }
  },

  async adminUsageSaveBudget(row) {
    row._saving = true;
    this.adminUsageError = '';
    try {
      const usd = row._draftBudget === '' ? null : Number(row._draftBudget);
      const body = { monthly_budget_usd: usd, budget_mode: row._draftMode };
      const r = await fetch(`/admin/users/${encodeURIComponent(row.email)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      row.monthlyBudgetUsd = j.user.monthly_budget_usd;
      row.budgetMode = j.user.budget_mode || 'none';
      row.overrun = !!(row.monthlyBudgetUsd && row.budgetMode !== 'none' && row.usd >= row.monthlyBudgetUsd);
      row._savedAt = Date.now();
    } catch (e) { this.adminUsageError = e.message; }
    finally { row._saving = false; }
  },

  // ── Tab: Jobs ──────────────────────────────────────────────────────────────
  async adminUsageLoadJobs() {
    if (this.adminUsageLoading) return;
    this.adminUsageLoading = true;
    try {
      const qs = new URLSearchParams();
      if (this.adminUsageFilterUser) qs.set('user', this.adminUsageFilterUser);
      qs.set('limit', '50');
      qs.set('offset', String(this.adminUsageJobsOffset || 0));
      const data = await this._adminUsageFetch(`/admin/usage/jobs?${qs.toString()}`);
      this.adminUsageJobsList = data.rows || [];
      this.adminUsageJobsTotal = data.total || 0;
    } catch (e) { this.adminUsageError = e.message; }
    finally { this.adminUsageLoading = false; }
  },

  // ── Tab: Chat ──────────────────────────────────────────────────────────────
  async adminUsageLoadChat() {
    if (this.adminUsageLoading) return;
    this.adminUsageLoading = true;
    try {
      const qs = new URLSearchParams();
      if (this.adminUsageFilterUser) qs.set('user', this.adminUsageFilterUser);
      qs.set('limit', '50');
      qs.set('offset', String(this.adminUsageChatOffset || 0));
      const data = await this._adminUsageFetch(`/admin/usage/chat?${qs.toString()}`);
      this.adminUsageChatList = data.rows || [];
      this.adminUsageChatTotal = data.total || 0;
    } catch (e) { this.adminUsageError = e.message; }
    finally { this.adminUsageLoading = false; }
  },

  // ── Tab: Summary (mit Charts) ──────────────────────────────────────────────
  async adminUsageLoadSummary() {
    if (this.adminUsageLoading) return;
    this.adminUsageLoading = true;
    try {
      const data = await this._adminUsageFetch('/admin/usage/summary');
      this.adminUsageSummary = data;
      this.$nextTick(() => this._adminUsageRenderCharts(data));
    } catch (e) { this.adminUsageError = e.message; }
    finally { this.adminUsageLoading = false; }
  },

  async _adminUsageRenderCharts(data) {
    let Chart;
    try { Chart = await loadChart(); } catch { return; }
    const palette = ['#5b8def', '#23bf81', '#f0a23a', '#e85c79', '#9b7ce3', '#23b0bf'];

    const destroy = (key) => {
      if (this._adminUsageCharts?.[key]) {
        try { this._adminUsageCharts[key].destroy(); } catch {}
      }
    };
    if (!this._adminUsageCharts) this._adminUsageCharts = {};

    // Top-User-Bar
    const topUsers = (data.topUsers || []).slice(0, 10);
    const elUsers = this.$refs?.chartUsers;
    if (elUsers && topUsers.length) {
      destroy('users');
      this._adminUsageCharts.users = new Chart(elUsers.getContext('2d'), {
        type: 'bar',
        data: {
          labels: topUsers.map(u => u.email),
          datasets: [{
            label: 'USD',
            data: topUsers.map(u => Number(u.usd?.toFixed?.(4) || u.usd || 0)),
            backgroundColor: palette[0],
          }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    }
    // Pro-Modell-Pie
    const byModel = data.byModel || [];
    const elModel = this.$refs?.chartModel;
    if (elModel && byModel.length) {
      destroy('model');
      this._adminUsageCharts.model = new Chart(elModel.getContext('2d'), {
        type: 'doughnut',
        data: {
          labels: byModel.map(m => m.model),
          datasets: [{ data: byModel.map(m => Number(m.usd?.toFixed?.(4) || m.usd || 0)), backgroundColor: palette }],
        },
        options: { responsive: true, maintainAspectRatio: false },
      });
    }
    // Pro-Job-Typ-Bar
    const byType = data.byType || [];
    const elType = this.$refs?.chartType;
    if (elType && byType.length) {
      destroy('type');
      this._adminUsageCharts.type = new Chart(elType.getContext('2d'), {
        type: 'bar',
        data: {
          labels: byType.map(t => t.type),
          datasets: [{ label: 'USD', data: byType.map(t => Number(t.usd?.toFixed?.(4) || t.usd || 0)), backgroundColor: palette[2] }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
    }
  },

  // ── Tab: Features ──────────────────────────────────────────────────────────
  async adminUsageLoadFeatures() {
    if (this.adminUsageLoading) return;
    this.adminUsageLoading = true;
    try {
      const data = await this._adminUsageFetch('/admin/usage/features');
      this.adminUsageFeatureItems  = data.items  || [];
      this.adminUsageFeatureTotals = data.totals || [];
    } catch (e) { this.adminUsageError = e.message; }
    finally { this.adminUsageLoading = false; }
  },

  // ── Tab: Zeit ──────────────────────────────────────────────────────────────
  async adminUsageLoadTime() {
    if (this.adminUsageLoading) return;
    this.adminUsageLoading = true;
    try {
      const data = await this._adminUsageFetch('/admin/usage/time');
      this.adminUsageTimeItems = data.items || [];
      this.adminUsageTimeSeries = [];
      this.adminUsageTimeSeriesKey = '';
    } catch (e) { this.adminUsageError = e.message; }
    finally { this.adminUsageLoading = false; }
  },

  async adminUsageLoadTimeSeries(row) {
    const key = `${row.email}:${row.bookId}`;
    if (this.adminUsageTimeSeriesKey === key) {
      this.adminUsageTimeSeriesKey = '';
      this.adminUsageTimeSeries = [];
      return;
    }
    try {
      const data = await this._adminUsageFetch(
        `/admin/usage/time/${encodeURIComponent(row.email)}/${row.bookId}/series`
      );
      this.adminUsageTimeSeries = data.series || [];
      this.adminUsageTimeSeriesKey = key;
    } catch (e) { this.adminUsageError = e.message; }
  },
};
