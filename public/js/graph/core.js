import { escHtml } from '../utils.js';
import { loadVis } from '../lazy-libs.js';
import { toggleWrapFullscreen } from '../fullscreen.js';

// Entry-Points: Mode-Switch, Fullscreen, Render-Dispatcher.
// innerHTML mit escHtml() — Escape-Invariante eingehalten.
export const coreMethods = {
  setFigurenGraphModus(mode) {
    if (mode === this.figurenGraphModus) return;
    this.figurenGraphModus = mode;
    this._figurenHash = null;
    this.$nextTick(() => this.renderFigurGraph());
  },

  figurenHasFamilyEdges() {
    for (const f of this._graphFiguren()) {
      for (const bz of (f.beziehungen || [])) {
        if (['elternteil', 'kind', 'geschwister'].includes(bz.typ)) return true;
      }
    }
    return false;
  },

  async toggleFigurenGraphFullscreen() {
    const wrap = document.getElementById('figuren-graph')?.closest('.figuren-graph-wrap');
    if (!wrap) return;
    try {
      await toggleWrapFullscreen(wrap);
    } catch {
      this.figurenGraphFullscreen = !this.figurenGraphFullscreen;
      this.$nextTick(() => {
        window.dispatchEvent(new Event('resize'));
        if (this.figurenGraphFullscreen && this._figurenNetwork) {
          this._figurenNetwork.fit({ animation: { duration: 200, easingFunction: 'easeInOutQuad' } });
        }
      });
    }
  },

  async renderFigurGraph() {
    const container = document.getElementById('figuren-graph');
    if (!container) return;
    const figuren = this._graphFiguren();

    // .Network statt nur window.vis prüfen: erst wenn das vis-network-Bundle
    // wirklich geladen ist, lässt sich `new vis.Network` aufrufen.
    if (!window.vis?.Network) {
      const ph = document.createElement('span');
      ph.className = 'muted-msg muted-msg--block';
      ph.textContent = window.__app.t('graph.empty.visLoading');
      container.replaceChildren(ph);
      try { await loadVis(); }
      catch (e) {
        ph.textContent = e.message;
        return;
      }
    }

    // Render-Signatur deckt ALLE layout-/edge-relevanten Felder ab: typ (Tier),
    // sozialschicht (Soziogramm-Band), Kapitel (X-Achse + Presence) und Beziehungen
    // inkl. Machtverhältnis (Edges + Macht-Sortierung). Nur Kapitel zu prüfen würde
    // nach einem Beziehungs-/Typ-/Schicht-Edit den alten Stand zeigen (Hash matcht
    // trotz Datenänderung → No-op).
    const sig = figuren.map(f => {
      const kap = (f.kapitel || []).map(k => k.name + k.haeufigkeit).join(',');
      const bz  = (f.beziehungen || []).map(b => b.figur_id + b.typ + (b.machtverhaltnis ?? '')).join(',');
      return [f.id, f.typ || '', f.sozialschicht || '', kap, bz].join('::');
    }).join('|');
    const hash = sig + '|' + this.figurenGraphModus + '|' + window.__app.uiLocale;
    if (this._figurenNetwork && this._figurenHash === hash) return;
    this._figurenHash = hash;

    if (this._figurenNetwork) {
      this._figurenNetwork.destroy();
      this._figurenNetwork = null;
    }
    if (!figuren.length) {
      container.innerHTML = `<span class="muted-msg muted-msg--block">${escHtml(window.__app.t('graph.empty.figuren'))}</span>`;
      return;
    }
    if (this.figurenGraphModus === 'soziogramm')      this._renderSoziogramm(container);
    else if (this.figurenGraphModus === 'familie')    this._renderFamiliengraph(container);
    else                                              this._renderFigurengraph(container);

    if (this.figurenGraphKapitel && this._figurenNodes && this._figurenEdges) {
      requestAnimationFrame(() => this._figurenGraphSetKapitel(this.figurenGraphKapitel));
    }
  },
};
