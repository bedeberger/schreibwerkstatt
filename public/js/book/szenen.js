// Szenenanalyse-Methoden am Root-Spread (von komplett-Job, app-view, orteCard gerufen).

import { fetchJson } from '../utils.js';

export const szenenMethods = {
  async loadSzenen(bookId) {
    try {
      const data = await fetchJson('/figures/scenes/' + bookId);
      this.$store.catalog.szenen = data?.szenen || [];
      this.$store.catalogUi.szenenUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadSzenen]', e);
    }
  },

  // Stale-Szene ("nicht mehr im Text") endgültig löschen. Nur für stale-Einträge.
  // CASCADE räumt scene_figures/scene_locations/song_scenes + evtl. research_item_links mit.
  async deleteStaleSzene(s) {
    if (!s?.stale) return;
    if (!await this.appConfirm({
      message: this.t('szenen.confirmDeleteStale', { name: s.titel }),
      confirmLabel: this.t('common.delete'), danger: true,
    })) return;
    try {
      const r = await fetch(`/figures/scenes/${this.$store.nav.selectedBookId}/${s.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.$store.catalog.szenen = this.$store.catalog.szenen.filter(x => x.id !== s.id);
    } catch (e) {
      console.error('[deleteStaleSzene]', e);
    }
  },
};
