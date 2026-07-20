// Motiv-Werkstatt — Konstellations-Graph (vis-network, lazy). Themen sind Cluster-
// Anker, Motive die Naben (Grösse = Ist-Dichte aus motif_occurrences; „geplant aber
// fehlt" = Geist-Knoten). Kanten: Thema→Motiv, Motiv↔Motiv (Beziehungstyp) und
// optionale Soll-Layer (Figuren/Beats/Kapitel). Eigene Netzwerk-Instanz — teilt
// keinen State mit dem Figuren-Graph.

import { loadVis } from '../../lazy-libs.js';

// Themen-Palette (deterministisch nach Index; Motive erben die Farbe ihres Themas).
const THEME_PALETTE = ['#4a52a0', '#0f766e', '#b45309', '#9333ea', '#be123c', '#15803d', '#0369a1', '#a16207'];
const NEUTRAL = '#8a8f98';
const LAYER = { figure: '#0891b2', beat: '#7c3a48', chapter: '#65758b' };

function _themeColor(themeId, themes) {
  const ix = themes.findIndex(t => t.id === themeId);
  return ix >= 0 ? THEME_PALETTE[ix % THEME_PALETTE.length] : NEUTRAL;
}

export const graphMethods = {
  _graphSignature() {
    const m = this.motifs.map(x =>
      `${x.id}:${x.theme_id || 0}:${x.occurrenceCount || 0}:${(x.figures || []).length}:${(x.beats || []).length}:${(x.chapters || []).length}`
    ).join('|');
    const r = this.relations.map(x => `${x.from_motif_id}-${x.to_motif_id}:${x.typ}`).join('|');
    const t = this.themes.map(x => x.id).join(',');
    const layers = `${this.layerFigures}${this.layerBeats}${this.layerChapters}`;
    return [m, r, t, layers, this.$store.shell?.uiLocale].join('##');
  },

  async renderMotivGraph() {
    const container = document.getElementById('motiv-graph');
    if (!container) return;

    if (!window.vis?.Network) {
      const ph = document.createElement('span');
      ph.className = 'muted-msg muted-msg--block';
      ph.textContent = window.__app.t('graph.empty.visLoading');
      container.replaceChildren(ph);
      try { await loadVis(); }
      catch (e) { ph.textContent = e.message; return; }
    }

    const sig = this._graphSignature();
    if (this._motivNetwork && this._motivHash === sig) return;
    this._motivHash = sig;
    this._destroyGraph();

    if (!this.motifs.length && !this.themes.length) {
      const ph = document.createElement('span');
      ph.className = 'muted-msg muted-msg--block';
      ph.textContent = window.__app.t('motiv.empty.graph');
      container.replaceChildren(ph);
      return;
    }
    container.replaceChildren();

    // vis-network zeichnet auf Canvas → CSS-Custom-Properties werden NICHT
    // aufgelöst. Konkrete Theme-Farben zur Render-Zeit aus dem DOM lesen.
    const cs = getComputedStyle(container);
    const textColor = cs.color || '#333';
    const bgColor = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : '#fff';
    const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--color-muted').trim() || textColor;

    const nodes = [];
    const edges = [];

    // Themen-Anker.
    for (const t of this.themes) {
      nodes.push({
        id: `t${t.id}`, label: t.name, shape: 'dot', size: 24,
        color: { background: _themeColor(t.id, this.themes), border: _themeColor(t.id, this.themes) },
        font: { color: '#fff', size: 15, strokeWidth: 3, strokeColor: 'rgba(0,0,0,.45)' },
      });
    }

    // Motiv-Naben (Grösse = Ist-Dichte; Geist = geplant aber 0 Fundstellen).
    const figCatalog = this.$store.catalog.figuren || [];
    for (const m of this.motifs) {
      const col = _themeColor(m.theme_id, this.themes);
      const ghost = this.isGhost(m);
      const size = 10 + Math.min(28, (m.occurrenceCount || 0) * 3);
      nodes.push({
        id: `m${m.id}`, label: m.name, shape: 'dot', size,
        color: ghost
          ? { background: 'rgba(0,0,0,0)', border: col }
          : { background: col, border: col },
        borderWidth: ghost ? 2 : 1,
        shapeProperties: ghost ? { borderDashes: [4, 4] } : { borderDashes: false },
        font: { color: textColor, size: 13 },
      });
      if (m.theme_id) {
        edges.push({ from: `t${m.theme_id}`, to: `m${m.id}`, dashes: true, color: { color: col, opacity: 0.5 }, width: 1 });
      }

      // Soll-Layer (optional zuschaltbar).
      if (this.layerFigures) {
        for (const f of (m.figures || [])) {
          const nid = `f${f.figId}`;
          if (!nodes.some(n => n.id === nid)) {
            const cat = figCatalog.find(x => x.fig_id === f.figId);
            nodes.push({ id: nid, label: (cat?.name || f.name || '?'), shape: 'diamond', size: 9, color: LAYER.figure, font: { color: mutedColor, size: 11 } });
          }
          edges.push({ from: `m${m.id}`, to: nid, dashes: [2, 3], color: { color: LAYER.figure, opacity: 0.6 }, width: 1 });
        }
      }
      if (this.layerBeats) {
        for (const b of (m.beats || [])) {
          const nid = `b${b.id}`;
          if (!nodes.some(n => n.id === nid)) nodes.push({ id: nid, label: b.titel || '?', shape: 'square', size: 9, color: LAYER.beat, font: { color: mutedColor, size: 11 } });
          edges.push({ from: `m${m.id}`, to: nid, dashes: [2, 3], color: { color: LAYER.beat, opacity: 0.6 }, width: 1 });
        }
      }
      if (this.layerChapters) {
        for (const c of (m.chapters || [])) {
          const nid = `c${c.id}`;
          if (!nodes.some(n => n.id === nid)) nodes.push({ id: nid, label: c.name || '?', shape: 'triangle', size: 9, color: LAYER.chapter, font: { color: mutedColor, size: 11 } });
          edges.push({ from: `m${m.id}`, to: nid, dashes: [2, 3], color: { color: LAYER.chapter, opacity: 0.6 }, width: 1 });
        }
      }
    }

    // Motiv ↔ Motiv (Beziehungstyp als Kantenlabel).
    for (const r of this.relations) {
      edges.push({
        from: `m${r.from_motif_id}`, to: `m${r.to_motif_id}`, label: r.typ,
        arrows: 'to', color: { color: '#b45309' }, width: 2,
        font: { size: 11, color: mutedColor, strokeWidth: 3, strokeColor: bgColor },
        smooth: { type: 'curvedCW', roundness: 0.2 },
      });
    }

    this._motivNodes = new window.vis.DataSet(nodes);
    this._motivEdges = new window.vis.DataSet(edges);
    this._motivNetwork = new window.vis.Network(container, { nodes: this._motivNodes, edges: this._motivEdges }, {
      physics: { enabled: true, barnesHut: { gravitationalConstant: -6000, springLength: 130, springConstant: 0.04, damping: 0.5 }, stabilization: { iterations: 180 } },
      interaction: { hover: true, dragNodes: true, tooltipDelay: 120 },
      nodes: { borderWidthSelected: 3 },
      edges: { selectionWidth: 1 },
    });

    this._motivNetwork.on('click', (params) => {
      const nid = params.nodes?.[0];
      if (nid && /^m\d+$/.test(nid)) this.selectMotif(Number(nid.slice(1)));
    });
    // Nach der Stabilisierung Physik einfrieren (ruhiges Bild, weiter zieh-/zoombar).
    this._motivNetwork.once('stabilizationIterationsDone', () => {
      this._motivNetwork?.setOptions({ physics: { enabled: false } });
      if (this.selectedMotifId) this._highlightNode(this.selectedMotifId);
    });
  },

  _highlightNode(motifId) {
    if (!this._motivNetwork) return;
    try { this._motivNetwork.selectNodes([`m${motifId}`]); } catch (_) { /* Knoten evtl. (noch) nicht da */ }
  },

  _destroyGraph() {
    if (this._motivNetwork) { this._motivNetwork.destroy(); this._motivNetwork = null; }
    this._motivNodes = null;
    this._motivEdges = null;
  },

  toggleLayer(kind) {
    if (kind === 'figures') this.layerFigures = !this.layerFigures;
    else if (kind === 'beats') this.layerBeats = !this.layerBeats;
    else if (kind === 'chapters') this.layerChapters = !this.layerChapters;
    this.$nextTick(() => this.renderMotivGraph());
  },

  fitGraph() {
    this._motivNetwork?.fit({ animation: { duration: 400 } });
  },
};
