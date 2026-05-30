// Geo-Karten-Methoden der Orte-Karte (View-Mode 'map'). Nur aktiv, wenn das
// Buch auf "Orte real" (book_settings.orte_real) steht. Leaflet laedt lazy.
// Wird in Alpine.data('orteCard') gespreadet; Root-Zugriffe via window.__app.
//
// Marker-Koordinaten leben auf den Orten selbst (o.lat/o.lng) und werden ueber
// den bestehenden saveOrte-Pfad persistiert. _map/_markers sind transiente
// Leaflet-Runtime-Handles (wie Timer), kein fachlicher State.

import { fetchJson, escHtml } from '../utils.js';
import { loadLeaflet } from '../lazy-libs.js';

const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

export const orteMapMethods = {
  // Liest orte_real + Sprache aus den Buch-Einstellungen. Schaltet bei
  // deaktiviertem Feature einen evtl. offenen Karten-Tab zurueck auf Liste.
  async loadOrteReal() {
    const id = window.__app.selectedBookId;
    if (!id) { this.orteRealEnabled = false; return; }
    try {
      const s = await fetchJson('/booksettings/' + id);
      this.orteRealEnabled = !!s?.orte_real;
      this._geoLang = s?.language || 'de';
    } catch {
      this.orteRealEnabled = false;
    }
    if (!this.orteRealEnabled && this.viewMode === 'map') this.viewMode = 'list';
  },

  // Gefilterte Orte mit gesetzten Koordinaten (Marker-Quelle).
  orteMapped() {
    return window.__app.orteFiltered.filter(o => o.lat != null && o.lng != null);
  },

  // Map lazy aufbauen + Marker rendern. Idempotent — mehrfaches Aufrufen
  // (Tab-Wechsel) erzeugt genau eine Instanz.
  async ensureOrteMap() {
    if (!this.orteRealEnabled) return;
    const L = await loadLeaflet();
    const el = this.$refs.orteMapEl;
    if (!el) return;
    if (!this._map) {
      this._map = L.map(el, { scrollWheelZoom: true }).setView([20, 0], 2);
      L.tileLayer(OSM_TILES, {
        maxZoom: 19,
        attribution: window.__app.t('orte.map.attribution'),
      }).addTo(this._map);
      this._markers = L.layerGroup().addTo(this._map);
    }
    this._renderOrteMarkers(L);
    // Container wird erst mit dem Tab sichtbar → Groesse nach Layout neu messen.
    setTimeout(() => this._map?.invalidateSize(), 0);
  },

  _renderOrteMarkers(L) {
    if (!this._map || !this._markers) return;
    this._markers.clearLayers();
    const pts = [];
    for (const o of this.orteMapped()) {
      const marker = L.marker([o.lat, o.lng], { draggable: true });
      const html = `<strong>${escHtml(o.name || '')}</strong>` + (o.typ ? `<br>${escHtml(o.typ)}` : '');
      marker.bindPopup(html);
      marker.on('dragend', async () => {
        const ll = marker.getLatLng();
        const target = window.__app.orte.find(x => x.id === o.id);
        if (target) { target.lat = ll.lat; target.lng = ll.lng; await window.__app.saveOrte(); }
      });
      marker.addTo(this._markers);
      pts.push([o.lat, o.lng]);
    }
    if (pts.length) this._map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
  },

  // Nominatim-Vorschlag fuer einen Ort holen + ersten Treffer uebernehmen.
  // User korrigiert danach per Marker-Drag.
  async geocodeOrt(o) {
    if (this.geocodingId) return;
    const app = window.__app;
    this.geocodingId = o.id;
    this.orteMapStatus = '';
    try {
      const q = encodeURIComponent((o.name || '').trim());
      if (!q) return;
      const data = await fetchJson(`/geocode?q=${q}&lang=${this._geoLang || 'de'}`);
      const c = data?.candidates?.[0];
      if (!c) { this.orteMapStatus = app.t('orte.map.noResult', { name: o.name }); return; }
      const target = app.orte.find(x => x.id === o.id);
      if (target) { target.lat = c.lat; target.lng = c.lng; await app.saveOrte(); }
      if (this.viewMode === 'map') {
        const L = await loadLeaflet();
        this._renderOrteMarkers(L);
      }
    } catch (e) {
      console.error('[geocodeOrt]', e);
    } finally {
      this.geocodingId = null;
    }
  },

  _teardownMap() {
    if (this._map) {
      this._map.remove();
      this._map = null;
      this._markers = null;
    }
  },
};
