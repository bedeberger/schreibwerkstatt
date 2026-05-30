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
import { startPoll } from '../cards/job-helpers.js';

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
    this._markerById = {};
    const pts = [];
    for (const o of this.orteMapped()) {
      this._addOrtMarker(L, o, [o.lat, o.lng], false);
      pts.push([o.lat, o.lng]);
    }
    // Verortete Marker zuerst einpassen → getCenter() liefert danach die
    // sichtbare Kartenmitte, auf die wir die Orte ohne Georeferenz legen.
    if (pts.length) this._map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
    const center = this._map.getCenter();
    for (const o of this.unlocatedOrte()) {
      this._addOrtMarker(L, o, [center.lat, center.lng], true);
    }
  },

  // Einen Marker bauen + verdrahten. `unlocated` → roter Pin in der Kartenmitte
  // (kein lat/lng am Ort); Dragend setzt echte Koordinaten → wird blau.
  _addOrtMarker(L, o, latlng, unlocated) {
    const opts = { draggable: true };
    if (unlocated) {
      opts.icon = L.divIcon({ className: 'ort-marker-pin ort-marker-pin--unlocated', iconSize: [18, 18] });
    }
    const marker = L.marker(latlng, opts);
    marker.bindPopup(this._buildPopupHtml(o), { minWidth: 160, maxWidth: 240, maxHeight: 300 });
    // Popup-Inhalt lebt als statisches HTML in Leaflet; interne Links erst beim
    // Öffnen an die App-Navigation binden (Alpine-Bindings greifen hier nicht).
    marker.on('popupopen', (e) => this._bindPopupLinks(e.popup.getElement(), o));
    // Marker-Klick spiegelt die Selektion in die Locate-Liste (Cross-Highlight).
    marker.on('click', () => this._selectFromMap(o.id));
    marker.on('dragend', async () => {
      const ll = marker.getLatLng();
      const target = window.__app.orte.find(x => x.id === o.id);
      if (target) {
        target.lat = ll.lat;
        target.lng = ll.lng;
        await window.__app.saveOrte();
        // War der Pin „unlocated" (rot), wird er durch das Speichern verortet →
        // neu rendern, damit er als regulärer (blauer) Marker erscheint.
        if (unlocated) this._renderOrteMarkers(L);
      }
    });
    marker.addTo(this._markers);
    this._markerById[o.id] = marker;
  },

  // Reicher Marker-Popup: Stammdaten + klickbare Querverweise (Seite/Figuren/
  // Kapitel). Alle KI-/User-Felder via escHtml — Popup ist ein x-html-Sink.
  _buildPopupHtml(o) {
    const app = window.__app;
    const esc = (v) => escHtml(v == null ? '' : String(v));
    let h = `<div class="ort-popup"><strong class="ort-popup__name">${esc(o.name)}</strong>`;
    const sub = [o.typ, o.stimmung].filter(Boolean).map(esc).join(' · ');
    if (sub) h += `<div class="ort-popup__sub">${sub}</div>`;
    if (o.beschreibung) {
      const t = o.beschreibung.length > 160 ? o.beschreibung.slice(0, 160) + '…' : o.beschreibung;
      h += `<p class="ort-popup__desc">${esc(t)}</p>`;
    }
    const figIds = [...new Set((o.figuren || []).filter(Boolean))];
    if (figIds.length) {
      h += `<div class="ort-popup__row">` + figIds.map((id) => {
        const f = app.figurenById.get(id);
        const label = f?.kurzname || f?.name || id;
        return `<button type="button" class="ort-popup__chip" data-fig="${esc(id)}">${esc(label)}</button>`;
      }).join('') + `</div>`;
    }
    const kapNames = [...new Set((o.kapitel || []).map((k) => (k.name || '').trim()).filter(Boolean))];
    if (kapNames.length) {
      h += `<div class="ort-popup__row">` + kapNames.map((name) =>
        `<button type="button" class="ort-popup__chip" data-kap="${esc(name)}">${esc(name)}</button>`
      ).join('') + `</div>`;
    }
    if (o.erste_erwaehnung && o.erste_erwaehnung_page_id) {
      h += `<button type="button" class="ort-popup__page" data-page="${esc(o.erste_erwaehnung_page_id)}">${esc(o.erste_erwaehnung)}</button>`;
    }
    return h + `</div>`;
  },

  // Klick-Handler an die statischen Popup-Buttons hängen → App-Navigation.
  _bindPopupLinks(root, o) {
    if (!root) return;
    const app = window.__app;
    root.querySelector('.ort-popup__page')?.addEventListener('click', () => {
      app.gotoPageById(Number(o.erste_erwaehnung_page_id));
    });
    root.querySelectorAll('.ort-popup__chip[data-fig]').forEach((b) =>
      b.addEventListener('click', () => app.openFigurById(b.dataset.fig)));
    root.querySelectorAll('.ort-popup__chip[data-kap]').forEach((b) =>
      b.addEventListener('click', () => app.openKapitelByName(b.dataset.kap)));
  },

  // Marker-Klick → Locate-Row markieren (kein Scroll).
  _selectFromMap(id) {
    this.highlightOrtId = id;
  },

  // Locate-Row-Hover → Marker zentrieren + Popup öffnen (Gegenrichtung).
  focusMapMarker(id) {
    this.highlightOrtId = id;
    const marker = this._markerById?.[id];
    if (!marker || !this._map) return;
    this._map.panTo(marker.getLatLng(), { animate: true });
    marker.openPopup();
  },

  // Orte ohne Koordinaten (im aktuellen Filter) — Quelle für Batch-Geocode + Zähler.
  unlocatedOrte() {
    return window.__app.orteFiltered.filter(o => o.lat == null || o.lng == null);
  },

  // Koordinaten auf einen Ort im Speicher schreiben + persistieren. Gibt true,
  // wenn der Ort noch existiert (sonst no-op → false).
  async _applyCoords(id, lat, lng) {
    const target = window.__app.orte.find(x => x.id === id);
    if (!target) return false;
    target.lat = lat;
    target.lng = lng;
    await window.__app.saveOrte();
    return true;
  },

  // KI-first-Verortung für eine Liste von Orten. Der Server normalisiert jedes
  // Label zuerst auf eine präzise reale Anfrage („Badi Olten" → „Olten") und
  // geocodet sie dann — verhindert, dass der tolerante Geocoder das rohe Label
  // auf einen falschen Treffer (z.B. in DE) zieht. Resolved → Set der ids mit
  // Treffer (Koordinaten bereits gesetzt + gespeichert). Misses bleiben
  // unverortet (roter Pin, User schiebt zurecht).
  async _geocodeViaAI(items) {
    const app = window.__app;
    const hitIds = new Set();
    if (!items.length || !app.selectedBookId) return hitIds;
    let resp;
    try {
      resp = await fetchJson('/jobs/geocode-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: app.selectedBookId,
          items: items.map(o => ({ id: o.id, name: (o.name || '').trim() })),
        }),
      });
    } catch (e) { console.error('[geocodeViaAI]', e); return hitIds; }
    if (!resp?.jobId) return hitIds;

    const results = await new Promise((resolve) => {
      startPoll(this, {
        timerProp: '_geocodeJobTimer',
        jobId: resp.jobId,
        onDone: (job) => resolve(Array.isArray(job?.result?.results) ? job.result.results : []),
        onError: () => resolve([]),
        onNotFound: () => resolve([]),
      });
    });

    for (const r of results) {
      if (r && r.lat != null && r.lng != null && await this._applyCoords(r.id, r.lat, r.lng)) hitIds.add(r.id);
    }
    return hitIds;
  },

  // Einen Ort verorten (KI-first): das Label wird serverseitig auf eine präzise
  // reale Anfrage normalisiert und dann geocodet. Bleibt der Ort danach
  // unverortet (rein fiktiv / kein Treffer), zeigt der Render-Pfad einen roten
  // Pin in der Kartenmitte (User korrigiert per Drag).
  async geocodeOrt(o) {
    if (this.geocodingId || this.geocodingAll) return;
    const app = window.__app;
    this.geocodingId = o.id;
    this.orteMapStatus = app.t('orte.map.aiResolving', { name: o.name });
    try {
      const hit = (await this._geocodeViaAI([o])).has(o.id);
      this.orteMapStatus = app.t(hit ? 'orte.map.geocoded' : 'orte.map.unresolved', { name: o.name });
      if (this.viewMode === 'map') {
        const L = await loadLeaflet();
        this._renderOrteMarkers(L);
        // Treffer → auf die neue Position zoomen. Kein Treffer → der rote
        // Mitte-Pin liegt bereits sichtbar in der Kartenmitte, kein setView.
        const target = app.orte.find(x => x.id === o.id);
        if (hit && target) this._map?.setView([target.lat, target.lng], Math.max(this._map.getZoom(), 6));
      }
    } catch (e) {
      console.error('[geocodeOrt]', e);
    } finally {
      this.geocodingId = null;
    }
  },

  // Batch (KI-first): alle gefilterten Orte ohne Koordinaten gehen in EINEN
  // KI-Job, der jedes Label normalisiert + geocodet. Rest bleibt unverortet.
  async geocodeAllUnlocated() {
    if (this.geocodingId || this.geocodingAll) return;
    const app = window.__app;
    const todo = this.unlocatedOrte();
    if (!todo.length) return;
    this.geocodingAll = true;
    this.orteMapStatus = app.t('orte.map.batchAi', { n: todo.length });
    try {
      const hits = (await this._geocodeViaAI(todo)).size;
      if (this.viewMode === 'map') {
        const L = await loadLeaflet();
        this._renderOrteMarkers(L);
      }
      this.orteMapStatus = app.t('orte.map.batchDone', { hits, total: todo.length });
    } finally {
      this.geocodingAll = false;
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

  // Alle Georeferenzen des Buchs auf einmal entfernen (lat/lng raus, Schauplätze
  // bleiben). Operiert auf allen Orten, nicht nur dem aktuellen Filter. Marker
  // verschwinden, alles wird wieder geocodierbar. Destruktiv → Bestätigung.
  async clearAllGeorefs() {
    if (this.geocodingId || this.geocodingAll) return;
    const app = window.__app;
    const located = app.orte.filter(o => o.lat != null || o.lng != null);
    if (!located.length) return;
    const ok = await app.appConfirm({
      message: app.t('orte.map.clearAllConfirm', { n: located.length }),
      confirmLabel: app.t('orte.map.clearAll'),
      danger: true,
    });
    if (!ok) return;
    for (const o of located) { o.lat = null; o.lng = null; }
    await app.saveOrte();
    this.orteMapStatus = app.t('orte.map.allGeorefsCleared', { n: located.length });
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
      this._markerById = {};
    }
  },
};
