// Alpine.data('myStatsCard') — Sub-Komponente „Meine Statistik": aggregierte
// Schreib-Kennzahlen ueber ALLE eigenen Buecher (role='owner'). User-bound,
// nicht buch-bound — `showMyStatsCard` + `toggleMyStatsCard` leben im Root
// (generiert aus EXCLUSIVE_CARDS). Daten kommen vom Endpunkt
// `GET /me/profile-stats`; Reload bei jedem Oeffnen (frisch genug, billig).

export function registerMyStatsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('myStatsCard', () => ({
    myStatsData: null,
    myStatsLoading: false,
    myStatsError: '',

    init() {
      this.$watch(() => window.__app.showMyStatsCard, (visible) => {
        if (visible) this.loadMyStats();
      });
      // Re-Klick auf offene Karte / Wake-Refresh.
      this._onRefresh = (ev) => {
        if (ev?.detail?.name === 'myStats') this.loadMyStats();
      };
      window.addEventListener('card:refresh', this._onRefresh);
    },

    destroy() {
      if (this._onRefresh) window.removeEventListener('card:refresh', this._onRefresh);
    },

    async loadMyStats() {
      this.myStatsLoading = true;
      this.myStatsError = '';
      try {
        const r = await fetch('/me/profile-stats', { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        this.myStatsData = await r.json();
      } catch (e) {
        console.error('[myStats load]', e);
        this.myStatsError = window.__app.t('mystats.loadError');
        this.myStatsData = null;
      } finally {
        this.myStatsLoading = false;
      }
    },

    // Locale-aware Tausender-Trennung (Swiss: de-CH = Apostroph).
    _myStatsFmt(n) {
      const loc = window.__app.uiLocale === 'de' ? 'de-CH' : 'en-US';
      return Number(n || 0).toLocaleString(loc);
    },

    // Normseite = 1500 Zeichen (primaere Umfangs-Kennzahl).
    myStatsNormpages() {
      return this._myStatsFmt(Math.round((this.myStatsData?.chars || 0) / 1500));
    },

    // Schreibzeit kompakt: „12 h 30 min" bzw. „45 min".
    myStatsWritingTime() {
      const total = Math.max(0, Math.round((this.myStatsData?.writing_seconds || 0) / 60));
      const h = Math.floor(total / 60);
      const m = total % 60;
      const t = window.__app.t;
      if (h > 0) return t('mystats.hm', { h: this._myStatsFmt(h), m });
      return t('mystats.m', { m });
    },

    get myStatsIsEmpty() {
      return !this.myStatsLoading && !this.myStatsError && (!this.myStatsData || this.myStatsData.books === 0);
    },
  }));
}
