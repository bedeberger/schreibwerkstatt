// redundanzMethods — Redundanz-Radar (buchweite Doppelungs-Suche über dem
// Embedding-Index). Rein rückwärtsgewandt: findet quasi-doppelte Seiten-
// Passagen, schreibt nie in den Buchtext. Der Vergleich läuft server-seitig als
// Job (POST /jobs/redundancy); diese Methoden triggern ihn, pollen und rendern
// die Paar-Liste. Gespreadet in cards/redundanz-card.js.

// Schwelle-Bänder (bge-m3-Cosinus) → Zahl. Server clamped zusätzlich.
const THRESHOLDS = { strict: 0.88, medium: 0.82, loose: 0.76 };

// Kein `get x()` in diesem gespreadeten Modul — Spread würde Getter beim Mount
// sofort mit falschem `this` auslösen (Karte mountet nicht). Reine Getter
// (redundanzAvailable, redundanzHasIndex) leben inline im Karten-Literal.
export const redundanzMethods = {
  redundanzThresholdValue() {
    return THRESHOLDS[this.redundanzThreshold] ?? THRESHOLDS.medium;
  },

  setRedundanzThreshold(band) {
    if (!THRESHOLDS[band] || band === this.redundanzThreshold) return;
    this.redundanzThreshold = band;
  },

  // Index-Frische fürs aktuelle Buch (ob überhaupt ein Semantik-Index existiert).
  async loadRedundanzIndexStatus() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.$store.config?.semanticSearchEnabled) { this.redundanzIndexInfo = null; return; }
    try {
      const r = await fetch('/search/semantic/status?book_id=' + encodeURIComponent(bookId), { credentials: 'same-origin' });
      if (!r.ok) { this.redundanzIndexInfo = null; return; }
      const j = await r.json();
      this.redundanzIndexInfo = j.enabled ? j : null;
    } catch { this.redundanzIndexInfo = null; }
  },

  // Analyse starten: Job anstossen + pollen. Kein Auto-Run beim Öffnen (teuer).
  async runRedundanz() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.redundanzLoading) return;
    this.redundanzLoading = true;
    this.redundanzProgress = 0;
    this.redundanzResult = null;
    this.redundanzStatus = window.__app?.t?.('redundanz.running') || '';
    try {
      const r = await fetch('/jobs/redundancy', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, threshold: this.redundanzThresholdValue() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) {
        this.redundanzLoading = false;
        this.redundanzStatus = j.error_code === 'EMBED_DISABLED'
          ? (window.__app?.t?.('redundanz.needBackend') || '')
          : (window.__app?.t?.('redundanz.error') || 'Fehler');
        return;
      }
      this._pollRedundanz(j.jobId);
    } catch (e) {
      this.redundanzLoading = false;
      this.redundanzStatus = e.message || 'error';
    }
  },

  _pollRedundanz(jobId) {
    const tick = async () => {
      try {
        const r = await fetch('/jobs/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        if (j.status === 'done') {
          this.redundanzLoading = false;
          this.redundanzProgress = 100;
          this.redundanzResult = j.result || { pairs: [] };
          this.redundanzStatus = '';
          return;
        }
        if (j.status === 'error' || j.status === 'cancelled') {
          this.redundanzLoading = false;
          this.redundanzStatus = window.__app?.t?.('redundanz.error') || 'Fehler';
          return;
        }
        this.redundanzProgress = j.progress || 0;
        this._redundanzPollTimer = setTimeout(tick, 1000);
      } catch {
        this._redundanzPollTimer = setTimeout(tick, 2000);
      }
    };
    tick();
  },

  // Aktuellen Seitennamen zur page_id aus dem Nav-Store auflösen (drift-frei,
  // keine Snapshot-Namen im Job-Ergebnis). Fallback: „Seite #id".
  redundanzPageName(pageId) {
    const p = (Alpine.store('nav').pages || []).find(x => String(x.id) === String(pageId));
    if (p) return p.name || p.page_name || ('#' + pageId);
    return (window.__app?.t?.('redundanz.pageFallback', { id: pageId })) || ('#' + pageId);
  },

  // Score-Band für die Badge-Färbung (hoch = kräftiger).
  redundanzScoreClass(score) {
    if (score >= 0.9) return 'redundanz-score--high';
    if (score >= 0.83) return 'redundanz-score--mid';
    return 'redundanz-score--low';
  },

  redundanzGotoPage(pageId) {
    window.__app?.gotoPageById?.(Number(pageId));
  },
};
