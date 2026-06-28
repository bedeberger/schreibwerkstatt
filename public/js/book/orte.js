// Schauplatz-Methoden am Root-Spread (von app-view, Szenen-Trigger, toggleOrteCard gerufen).

import { fetchJson } from '../utils.js';

export const orteMethods = {
  async loadOrte(bookId) {
    try {
      const data = await fetchJson('/locations/' + bookId);
      this.$store.catalog.orte = data?.orte || [];
      this.orteUpdatedAt = data?.updated_at || null;
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
