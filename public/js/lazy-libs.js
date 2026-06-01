// On-demand-Loader für vis-network und Chart.js. Beide Libs laden nur bei Bedarf
// (Figuren-Graph- bzw. BookStats-Karte geöffnet) — vorher blockten sie als
// Eager-Script-Tags den initialen Page-Load mit ~800 KB unbenutzter JS.
//
// Self-hosted unter public/vendor/ — externe CDNs (unpkg, jsdelivr) entfallen,
// damit offline (Zug-Szenario) Karten weiter funktionieren und kein Third-Party-
// Roundtrip beim Erstöffnen anfällt. Versionen sind im Dateinamen gepinnt;
// Update = neue Datei + alte löschen + SHELL_CACHE in public/sw.js bumpen.

let _visPromise = null;
let _visTimelinePromise = null;
let _chartPromise = null;
let _jsMindPromise = null;
let _sortablePromise = null;
let _diffPromise = null;
let _leafletPromise = null;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Script konnte nicht geladen werden: ' + src));
    document.head.appendChild(s);
  });
}

function _ensureCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

export function loadVis() {
  // .Network statt nur window.vis prüfen — vis-timeline mergt ebenfalls in
  // window.vis (ohne Network), darf den Graph-Loader also nicht kurzschliessen.
  if (window.vis?.Network) return Promise.resolve(window.vis);
  if (!_visPromise) {
    _visPromise = _loadScript('vendor/vis-network-10.0.2.min.js')
      .then(() => window.vis)
      .catch(err => { _visPromise = null; throw err; });
  }
  return _visPromise;
}

// vis-timeline (Ereignisse-Zeitstrahl). Eigenes Standalone-Bundle aus derselben
// vis.js-Familie wie vis-network; beide mergen in window.vis (`.vis = vis||{}`)
// und koexistieren. CSS via _ensureCss (analog Leaflet), Theme-Overrides in
// public/css/analysis/ereignisse-timeline.css.
export function loadVisTimeline() {
  _ensureCss('vendor/vis-timeline-7.7.3/vis-timeline-graph2d.min.css');
  if (window.vis?.Timeline) return Promise.resolve(window.vis);
  if (!_visTimelinePromise) {
    _visTimelinePromise = _loadScript('vendor/vis-timeline-7.7.3/vis-timeline-graph2d.min.js')
      .then(() => window.vis)
      .catch(err => { _visTimelinePromise = null; throw err; });
  }
  return _visTimelinePromise;
}

export function loadChart() {
  if (typeof window.Chart !== 'undefined') return Promise.resolve(window.Chart);
  if (!_chartPromise) {
    _chartPromise = _loadScript('vendor/chart-4.5.1.umd.min.js')
      .then(() => window.Chart)
      .catch(err => { _chartPromise = null; throw err; });
  }
  return _chartPromise;
}

export function loadJsMind() {
  if (typeof window.jsMind !== 'undefined') return Promise.resolve(window.jsMind);
  if (!_jsMindPromise) {
    _jsMindPromise = _loadScript('vendor/jsmind-0.8.7.js')
      .then(() => window.jsMind)
      .catch(err => { _jsMindPromise = null; throw err; });
  }
  return _jsMindPromise;
}

export function loadSortable() {
  if (typeof window.Sortable !== 'undefined') return Promise.resolve(window.Sortable);
  if (!_sortablePromise) {
    _sortablePromise = _loadScript('vendor/sortable-1.15.6.min.js')
      .then(() => window.Sortable)
      .catch(err => { _sortablePromise = null; throw err; });
  }
  return _sortablePromise;
}

export function loadDiff() {
  if (typeof window.Diff !== 'undefined') return Promise.resolve(window.Diff);
  if (!_diffPromise) {
    _diffPromise = _loadScript('vendor/diff-9.0.0.min.js')
      .then(() => window.Diff)
      .catch(err => { _diffPromise = null; throw err; });
  }
  return _diffPromise;
}

export function loadLeaflet() {
  // CSS muss vor dem Skript da sein (Marker-Image-Pfade relativ zur leaflet.css).
  _ensureCss('vendor/leaflet-1.9.4/leaflet.css');
  if (typeof window.L !== 'undefined') return Promise.resolve(window.L);
  if (!_leafletPromise) {
    _leafletPromise = _loadScript('vendor/leaflet-1.9.4/leaflet.js')
      .then(() => {
        // Auto-Detect der Image-Pfade scheitert bei manchen Setups → explizit setzen.
        if (window.L?.Icon?.Default) window.L.Icon.Default.imagePath = 'vendor/leaflet-1.9.4/images/';
        return window.L;
      })
      .catch(err => { _leafletPromise = null; throw err; });
  }
  return _leafletPromise;
}
