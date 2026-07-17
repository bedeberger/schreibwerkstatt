'use strict';
// Lesetiefe-Beacon für den Share-Reader. Eigenständiges Modul (kein Alpine),
// liest #share-config selbst — analog dwell.js. Misst, wie weit der Leser durch
// den geteilten Inhalt gescrollt ist: gesamt (0-100 %) und — bei Buch-Shares —
// pro Kapitel. Meldung an POST /share/:token/read-depth beim Wechsel in den
// Hintergrund (visibilitychange/pagehide); der Server nimmt jeweils den grössten
// gemeldeten Wert (MAX-Merge), darum darf mehrfach gesendet werden.
//
// Metrik: der tiefste je erreichte Punkt der Viewport-Unterkante im Dokument
// (maxBottomY). Daraus leitet sich zum Sendezeitpunkt sowohl der Gesamtanteil als
// auch die pro-Kapitel-Tiefe ab (Kapitelgrenzen = aufeinanderfolgende Kapitel-
// Überschriften). Element-Offsets werden erst beim Senden gemessen (Live-Inhalt).

(function () {
  const cfgEl = document.getElementById('share-config');
  if (!cfgEl) return;
  let CFG;
  try { CFG = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
  const TOKEN = CFG.token;
  const VIEW_ID = CFG.viewId;
  if (!TOKEN || !VIEW_ID) return; // ohne view_id kann der Server nichts zuordnen

  const CHAPTERS = (CFG.readDepth && Array.isArray(CFG.readDepth.chapters)) ? CFG.readDepth.chapters : [];

  // Tiefster erreichter Punkt der Viewport-Unterkante im Dokument.
  let maxBottomY = 0;
  function track() {
    const bottom = (window.scrollY || 0) + (document.documentElement.clientHeight || window.innerHeight || 0);
    if (bottom > maxBottomY) maxBottomY = bottom;
  }
  track();
  window.addEventListener('scroll', track, { passive: true });
  window.addEventListener('resize', track);

  function docHeight() {
    return Math.max(1, document.documentElement.scrollHeight || 0);
  }
  function anchorTop(anchor) {
    const el = document.getElementById(anchor);
    if (!el) return null;
    return (window.scrollY || 0) + el.getBoundingClientRect().top;
  }

  function computeChapterDepths() {
    if (!CHAPTERS.length) return [];
    // Kapitelgrenzen: Oberkante dieses Kapitels bis Oberkante des nächsten
    // (letztes Kapitel bis Dokumentende). Tops in Dokument-Koordinaten.
    const tops = CHAPTERS.map(c => ({ id: c.id, top: anchorTop(c.anchor) }))
      .filter(c => c.top != null && Number.isInteger(c.id) && c.id > 0);
    const out = [];
    const end = docHeight();
    for (let i = 0; i < tops.length; i++) {
      const start = tops[i].top;
      const stop = i + 1 < tops.length ? tops[i + 1].top : end;
      const span = Math.max(1, stop - start);
      const pct = Math.round(Math.min(1, Math.max(0, (maxBottomY - start) / span)) * 100);
      out.push({ chapterId: tops[i].id, pct });
    }
    return out;
  }

  function send() {
    track();
    const maxScrollPct = Math.min(100, Math.round((maxBottomY / docHeight()) * 100));
    if (maxScrollPct <= 0) return;
    const payload = JSON.stringify({ viewId: VIEW_ID, maxScrollPct, chapters: computeChapterDepths() });
    const url = `/share/${encodeURIComponent(TOKEN)}/read-depth`;
    let ok = false;
    try {
      if (navigator.sendBeacon) ok = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    } catch { ok = false; }
    if (!ok) {
      try { fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json' }, keepalive: true }); } catch { /* best effort */ }
    }
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(); });
  window.addEventListener('pagehide', send);
})();
