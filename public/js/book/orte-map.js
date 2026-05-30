// Geo-Karten-Methoden der Orte-Karte (View-Mode 'map'). Nur aktiv, wenn das
// Buch auf "Orte real" (book_settings.orte_real) steht. Leaflet laedt lazy.
// Wird in Alpine.data('orteCard') gespreadet; Root-Zugriffe via window.__app.
//
// Marker-Koordinaten leben auf den Orten selbst (o.lat/o.lng) und werden ueber
// den bestehenden saveOrte-Pfad persistiert. _map/_markers sind transiente
// Leaflet-Runtime-Handles (wie Timer), kein fachlicher State.

import { fetchJson, escHtml } from '../utils.js';
import { loadLeaflet } from '../lazy-libs.js';
import { countryLabel } from '../country-codes.js';

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
      this._bookLand = s?.schauplatz_land || null;
    } catch {
      this.orteRealEnabled = false;
    }
    if (!this.orteRealEnabled && this.viewMode === 'map') this.viewMode = 'list';
  },

  // Lokalisiertes Land-Label für einen ISO-2-Code (Badge in Liste/Grid).
  landLabel(code) {
    return countryLabel(code, this._geoLang || 'de');
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
      // zoomAnimation aus: der Karten-Tab lebt in einem x-show-Container, der
      // beim Tab-/Buchwechsel auf display:none geht. Eine laufende Zoom-Anim
      // feuert dann ihr zoomanim-rAF auf Marker, deren Map-Panes schon weg sind
      // (_animateZoom liest null) → Crash. Instant-Zoom umgeht den Pfad ganz.
      this._map = L.map(el, { scrollWheelZoom: true, zoomAnimation: false }).setView([20, 0], 2);
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
      // Länder-Bias: pro-Ort-Land schlägt Buch-Hauptland; biast Nominatim auf
      // das richtige Land (verhindert „Bern → USA"-Fehltreffer bei mehrdeutigen
      // Ortsnamen). Ohne Land → kein Bias (globale Suche wie bisher).
      const land = o.land || this._bookLand || '';
      const regionQ = /^[A-Za-z]{2}$/.test(land) ? `&region=${land.toLowerCase()}` : '';
      const data = await fetchJson(`/geocode?q=${q}&lang=${this._geoLang || 'de'}${regionQ}`);
      const c = data?.candidates?.[0];
      const target = app.orte.find(x => x.id === o.id);
      if (!c) {
        // Kein Treffer → Pin in Karten-Mitte droppen. User schiebt ihn zurecht,
        // dragend speichert. Ohne Map (Liste) Buch-Center bzw. globaler Default.
        const center = this._map ? this._map.getCenter() : { lat: 20, lng: 0 };
        if (target) { target.lat = center.lat; target.lng = center.lng; await app.saveOrte(); }
        this.orteMapStatus = app.t('orte.map.pinDropped', { name: o.name });
      } else {
        if (target) { target.lat = c.lat; target.lng = c.lng; await app.saveOrte(); }
      }
      if (this.viewMode === 'map') {
        const L = await loadLeaflet();
        this._renderOrteMarkers(L);
        if (!c && target) this._map?.setView([target.lat, target.lng], Math.max(this._map.getZoom(), 6));
      }
    } catch (e) {
      console.error('[geocodeOrt]', e);
    } finally {
      this.geocodingId = null;
    }
  },

  // Falsch gesetzte Georeferenz löschen — Schauplatz bleibt, nur lat/lng raus.
  // Marker verschwindet, Ort wird wieder geocodierbar.
  async clearGeoref(o) {
    const app = window.__app;
    const target = app.orte.find(x => x.id === o.id);
    if (!target || (target.lat == null && target.lng == null)) return;
    target.lat = null;
    target.lng = null;
    await app.saveOrte();
    this.orteMapStatus = app.t('orte.map.georefCleared', { name: o.name });
    if (this.viewMode === 'map') {
      const L = await loadLeaflet();
      this._renderOrteMarkers(L);
    }
  },

  _teardownMap() {
    if (this._map) {
      // Laufende Pan/Zoom-Anim hart stoppen + Marker abräumen, bevor remove()
      // die Panes nullt — sonst feuert ein queued Anim-Callback ins Leere.
      this._map.stop();
      this._markers?.clearLayers();
      this._map.remove();
      this._map = null;
      this._markers = null;
    }
  },
};
