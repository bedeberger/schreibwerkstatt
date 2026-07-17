'use strict';
// Verweildauer-Beacon für die Share-Leseansicht. Eigenständiges Modul (kein
// Alpine), liest #share-config selbst — analog tts.js. Misst die sichtbar
// verbrachte Zeit auf der Seite und meldet sie an POST /share/:token/view-duration.
//
// Nur die aktiv sichtbare Zeit zählt: bei Wechsel in den Hintergrund
// (visibilitychange → hidden) wird der laufende Abschnitt aufsummiert und der
// bisherige Gesamtwert gesendet; bei Rückkehr läuft die Messung weiter. Der
// Server nimmt jeweils den grössten gemeldeten Wert (siehe db/share-links.js),
// darum darf mehrfach gesendet werden. pagehide deckt den finalen Abgang ab.

(function () {
  const cfgEl = document.getElementById('share-config');
  if (!cfgEl) return;
  let CFG;
  try { CFG = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
  const TOKEN = CFG.token;
  const VIEW_ID = CFG.viewId;
  if (!TOKEN || !VIEW_ID) return;

  let accumulatedMs = 0;
  let segmentStart = document.visibilityState === 'visible' ? Date.now() : null;

  function totalMs() {
    const running = segmentStart != null ? Date.now() - segmentStart : 0;
    return accumulatedMs + running;
  }

  function send() {
    const durationMs = totalMs();
    if (durationMs <= 0) return;
    const payload = JSON.stringify({ viewId: VIEW_ID, durationMs });
    const url = `/share/${encodeURIComponent(TOKEN)}/view-duration`;
    // sendBeacon überlebt das Entladen der Seite; Blob mit JSON-Typ, damit
    // express.json() auf dem Server greift. Fallback keepalive-fetch, falls
    // sendBeacon fehlt/abgelehnt wird.
    let ok = false;
    try {
      if (navigator.sendBeacon) {
        ok = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      }
    } catch { ok = false; }
    if (!ok) {
      try {
        fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true });
      } catch { /* best effort */ }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (segmentStart != null) { accumulatedMs += Date.now() - segmentStart; segmentStart = null; }
      send();
    } else if (segmentStart == null) {
      segmentStart = Date.now();
    }
  });

  // pagehide feuert beim endgültigen Verlassen (auch wenn kein visibilitychange
  // vorausging, z. B. direkte Navigation auf Desktop).
  window.addEventListener('pagehide', () => {
    if (segmentStart != null) { accumulatedMs += Date.now() - segmentStart; segmentStart = null; }
    send();
  });
})();
