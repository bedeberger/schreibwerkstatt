// Schauplatz-Methoden am Root-Spread (von app-view, Szenen-Trigger, toggleOrteCard gerufen).

import { fetchJson } from '../utils.js';

export const orteMethods = {
  async loadOrte(bookId) {
    try {
      const data = await fetchJson('/locations/' + bookId);
      this.$store.catalog.orte = data?.orte || [];
      this.$store.catalogUi.orteUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadOrte]', e);
    }
  },

  async saveOrte() {
    try {
      const r = await fetch('/locations/' + this.$store.nav.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orte: this.$store.catalog.orte }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return true;
    } catch (e) {
      console.error('[saveOrte]', e);
      return false;
    }
  },

  // Stale-Ort ("nicht mehr im Text") endgültig löschen. Nur für stale-Einträge —
  // aktive Orte werden bei der nächsten Komplettanalyse ohnehin neu abgeglichen. CASCADE
  // räumt location_figures/-chapters/scene_locations + evtl. research_item_links mit.
  async deleteStaleOrt(o) {
    if (!o?.stale) return;
    if (!await this.appConfirm({
      message: this.t('orte.confirmDeleteStale', { name: o.name }),
      confirmLabel: this.t('common.delete'), danger: true,
    })) return;
    try {
      const r = await fetch(`/locations/${this.$store.nav.selectedBookId}/${o.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.$store.catalog.orte = this.$store.catalog.orte.filter(x => x.id !== o.id);
    } catch (e) {
      console.error('[deleteStaleOrt]', e);
    }
  },

  // Nur Koordinaten patchen (Marker-Drag, Undo/Redo, Georef löschen) — leichter
  // und race-frei gegenüber dem Full-Replace von saveOrte. patches: [{id,lat,lng}].
  // Liefert true/false; Caller spiegeln optimistisch und rollen bei false zurück.
  async patchOrtCoords(patches) {
    if (!Array.isArray(patches) || !patches.length) return true;
    try {
      const r = await fetch('/locations/' + this.$store.nav.selectedBookId + '/coords', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patches }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return true;
    } catch (e) {
      console.error('[patchOrtCoords]', e);
      return false;
    }
  },
};
