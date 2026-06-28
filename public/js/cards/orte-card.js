// Alpine.data('orteCard') — Sub-Komponente der Schauplatz-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Root behält:
//   - `orte` (im Store, als $root-Getter verfügbar)
//   - `orteFilters` (app-navigation.js schreibt darauf)
//   - `selectedOrtId` (Hash-Router)
//   - `loadOrte`, `saveOrte`, `orteFiltered` (Root-Spread; von komplett-Job,
//     Szenen-Trigger und _reloadVisibleBookCards genutzt)
import { setupCardLifecycle } from './card-lifecycle.js';
import { orteMapMethods } from '../book/orte-map.js';

export function registerOrteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('orteCard', () => ({
    orteLoading: false,
    orteProgress: 0,
    orteStatus: '',
    viewMode: localStorage.getItem('orte.viewMode') === 'grid' ? 'grid' : 'list', // 'list' | 'grid' | 'map'
    // Geo-Karte (View-Mode 'map') — siehe book/orte-map.js.
    orteRealEnabled: false,   // book_settings.orte_real → blendet Karten-Tab ein
    geocodingId: null,        // loc-id, fuer die gerade ein Geocode laeuft
    geocodingAll: false,      // Batch-Geocode laeuft (sperrt Einzel-Buttons)
    highlightOrtId: null,     // Cross-Highlight Marker ↔ Locate-Liste
    orteMapStatus: '',
    geoLocked: localStorage.getItem('orte.geoLocked') !== '0', // verortete Marker gegen versehentliches Ziehen sperren (Default an)
    _geoUndoStack: [],        // Pin-Positions-History (max 10) — siehe orte-map.js
    _geoRedoStack: [],
    _geoLang: 'de',
    _bookLand: null,          // book_settings.schauplatz_land → Geocode-Länder-Bias
    _map: null,               // Leaflet-Instanz (transienter Runtime-Handle)
    _markers: null,           // Leaflet-LayerGroup
    _markerById: {},          // ort-id → Leaflet-Marker (Cross-Highlight-Lookup)
    _ortePollTimer: null,
    _geocodeJobTimer: null,   // transienter Poll-Timer fuer den KI-Geocode-Fallback-Job
    _lifecycle: null,

    init() {
      this.$watch('viewMode', (v) => {
        // 'map' nicht persistieren — Tab existiert nur bei orte_real.
        if (v === 'list' || v === 'grid') localStorage.setItem('orte.viewMode', v);
        if (v === 'map') this.ensureOrteMap();
      });
      // Karten-Marker reaktiv an den Filter koppeln. orteFiltered ist die
      // Marker-Quelle, aber Leaflet zeichnet imperativ — ohne Watch bleiben die
      // Marker nach Such-/Filteraenderung (inkl. Reset) stehen, waehrend die
      // Locate-Liste schon gefiltert ist. Signatur ueber die gefilterten ids
      // feuert nur bei echter Mengenaenderung (Drag/Geocode rendern selbst).
      this.$watch(
        () => window.__app.orteFiltered.map(o => o.id).join(','),
        () => this.refreshOrteMarkersForFilter(),
      );
      this._lifecycle = setupCardLifecycle(this, {
        name: 'orte',
        showFlag: 'showOrteCard',
        timerKeys: ['_ortePollTimer', '_geocodeJobTimer'],
        resetState: { orteLoading: false, orteProgress: 0, orteStatus: '', orteRealEnabled: false, geocodingId: null, geocodingAll: false, highlightOrtId: null, orteMapStatus: '' },
        load: (root) => root.loadOrte(root.selectedBookId),
        onShow: async (root) => {
          const tasks = [root.loadOrte(root.selectedBookId), this.loadOrteReal()];
          if (!root.szenen.length) tasks.push(root.loadSzenen(root.selectedBookId));
          await Promise.all(tasks);
        },
        extraListeners: [
          // Buchwechsel: Map verwerfen + auf Liste zuruecksetzen — neues Buch ist
          // evtl. nicht orte_real, und Marker-Daten stammen vom alten Buch.
          { type: 'book:changed', handler: () => { this._teardownMap(); if (this.viewMode === 'map') this.viewMode = 'list'; } },
          { type: 'view:reset', handler: () => { this._teardownMap(); if (this.viewMode === 'map') this.viewMode = 'list'; } },
        ],
      });
    },

    destroy() {
      this._teardownMap();
      this._lifecycle?.destroy();
    },

    ...orteMapMethods,
  }));
}
