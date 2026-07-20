// Motiv-Werkstatt — Konstellations-Graph (vis-network, lazy). Themen sind Cluster-
// Anker, Motive die Naben (Grösse = Ist-Dichte aus motif_occurrences; „geplant aber
// fehlt" = Geist-Knoten). Kanten: Thema→Motiv, Motiv↔Motiv (Beziehungstyp) und
// optionale Soll-Layer (Figuren/Beats/Kapitel). Eigene Netzwerk-Instanz — teilt
// keinen State mit dem Figuren-Graph.

import { loadVis } from '../../lazy-libs.js';
import { fetchJson } from '../../utils.js';
import { toggleWrapFullscreen } from '../../fullscreen.js';

// Themen-Palette: primär die vom Autor gewählte Farbe (themes.farbe = Palette-
// Schlüssel, theme-aware --palette-*-Tokens wie in der Plot-Werkstatt); ohne Wahl
// deterministisch nach Index in dieselbe Palette. Motive erben die Farbe ihres
// Themas. Graph (Canvas) und Swatch-Leiste teilen defaultThemeColorKey als SSoT,
// damit die Farben nie auseinanderdriften.
export const THEME_COLOR_KEYS = ['blue', 'green', 'amber', 'orange', 'red', 'wine', 'pink', 'purple', 'brown', 'gray'];
const NEUTRAL = '#8a8f98';
const LAYER = { figure: '#0891b2', beat: '#7c3a48', chapter: '#65758b' };

// Auto-Farbe (Palette-Schlüssel) für ein Thema am gegebenen Listen-Index.
export function defaultThemeColorKey(ix) {
  return THEME_COLOR_KEYS[((ix % THEME_COLOR_KEYS.length) + THEME_COLOR_KEYS.length) % THEME_COLOR_KEYS.length];
}

// paletteVars: Palette-Schlüssel → konkreter Farbwert (vis-network zeichnet auf
// Canvas, CSS-Custom-Props werden dort NICHT aufgelöst → zur Render-Zeit gelesen).
function _themeColor(themeId, themes, paletteVars) {
  const ix = themes.findIndex(t => t.id === themeId);
  if (ix < 0) return NEUTRAL;
  const key = themes[ix].farbe || defaultThemeColorKey(ix);
  return (paletteVars && paletteVars[key]) || paletteVars[defaultThemeColorKey(ix)] || NEUTRAL;
}

export const graphMethods = {
  _graphSignature() {
    const m = this.motifs.map(x =>
      `${x.id}:${x.name || ''}:${x.theme_id || 0}:${x.occurrenceCount || 0}:${(x.figures || []).length}:${(x.draftFigures || []).length}:${(x.beats || []).length}:${(x.chapters || []).length}`
    ).join('|');
    const r = this.relations.map(x => `${x.from_motif_id}-${x.to_motif_id}:${x.typ}`).join('|');
    const t = this.themes.map(x => `${x.id}:${x.name || ''}:${x.farbe || ''}`).join(',');
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
    // Gewählte Theme-Farben (Palette-Schlüssel → konkreter Wert) einmal aus den
    // --palette-*-Tokens auflösen (theme-aware; Canvas löst CSS-Vars nicht auf).
    const rootCS = getComputedStyle(document.documentElement);
    const paletteVars = {};
    for (const k of THEME_COLOR_KEYS) paletteVars[k] = rootCS.getPropertyValue(`--palette-${k}`).trim();

    const nodes = [];
    const edges = [];

    // Themen-Anker. shape:'circle' rendert das Label INNERHALB der farbigen
    // Blase (wächst mit dem Text) — dafür ist die weisse Schrift gedacht.
    for (const t of this.themes) {
      const tc = _themeColor(t.id, this.themes, paletteVars);
      nodes.push({
        id: `t${t.id}`, label: t.name, shape: 'circle', margin: 10, widthConstraint: { maximum: 140 },
        // highlight/hover explizit auf die Thema-Farbe: sonst kippt vis-network die
        // Blase bei Selektion/Hover auf seine hellblaue Default-Farbe → weisse
        // Schrift wird unlesbar. Selektion signalisiert stattdessen borderWidthSelected.
        color: { background: tc, border: tc, highlight: { background: tc, border: tc }, hover: { background: tc, border: tc } },
        font: { color: '#fff', size: 14 },
      });
    }

    // Motiv-Naben (Grösse = Ist-Dichte; Geist = geplant aber 0 Fundstellen).
    const figCatalog = this.$store.catalog.figuren || [];
    for (const m of this.motifs) {
      const col = _themeColor(m.theme_id, this.themes, paletteVars);
      const ghost = this.isGhost(m);
      const size = 10 + Math.min(28, (m.occurrenceCount || 0) * 3);
      // highlight/hover explizit auf die Motiv-Farbe (wie bei den Thema-Knoten):
      // sonst kippt vis-network den Punkt bei Selektion/Hover auf seine hellblaue
      // Default-Farbe (Klick selektiert via _highlightNode) und die Thema-Farbe geht
      // verloren — Geist-Knoten würden dabei sogar solide gefüllt. Selektion
      // signalisiert stattdessen borderWidthSelected.
      const mBg = ghost ? 'rgba(0,0,0,0)' : col;
      nodes.push({
        id: `m${m.id}`, label: m.name, shape: 'dot', size,
        color: {
          background: mBg, border: col,
          highlight: { background: mBg, border: col },
          hover: { background: mBg, border: col },
        },
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
            const cat = figCatalog.find(x => String(x.id) === String(f.figId));
            nodes.push({ id: nid, label: (cat?.name || f.name || '?'), shape: 'diamond', size: 9, color: LAYER.figure, font: { color: mutedColor, size: 11 } });
          }
          edges.push({ from: `m${m.id}`, to: nid, dashes: [2, 3], color: { color: LAYER.figure, opacity: 0.6 }, width: 1 });
        }
        // Werkstatt-Figuren (draft_figures) — gleiche Ebene, eigener Knoten-Namespace.
        for (const f of (m.draftFigures || [])) {
          const nid = `df${f.id}`;
          if (!nodes.some(n => n.id === nid)) {
            nodes.push({ id: nid, label: (f.name || '?'), shape: 'diamond', size: 9, color: LAYER.figure, font: { color: mutedColor, size: 11 } });
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

    // Persistierte Anordnung anwenden: Knoten mit gespeicherter Position starten dort
    // und werden während der Stabilisierung fixiert (Physik ordnet nur die neuen/noch
    // unplatzierten Knoten drumherum). Sind alle Knoten platziert → Physik gar nicht
    // erst starten. Nach Stabilisierung werden die Pins gelöst (Ziehen bleibt frei).
    const saved = this._savedPositions || {};
    for (const n of nodes) {
      const p = saved[n.id];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { n.x = p.x; n.y = p.y; n.fixed = true; }
    }
    const allPlaced = nodes.length > 0 && nodes.every(n => n.fixed);

    this._motivNodes = new window.vis.DataSet(nodes);
    this._motivEdges = new window.vis.DataSet(edges);
    this._motivNetwork = new window.vis.Network(container, { nodes: this._motivNodes, edges: this._motivEdges }, {
      physics: { enabled: !allPlaced, barnesHut: { gravitationalConstant: -6000, springLength: 130, springConstant: 0.04, damping: 0.5 }, stabilization: { iterations: 180 } },
      interaction: { hover: true, dragNodes: true, tooltipDelay: 120 },
      nodes: { borderWidthSelected: 3 },
      edges: { selectionWidth: 1 },
    });

    this._motivNetwork.on('click', (params) => {
      const nid = params.nodes?.[0];
      this.closeGraphMenu();
      if (nid && /^m\d+$/.test(nid)) this.selectMotif(Number(nid.slice(1)));
    });
    // Rechtsklick auf einen Knoten (oder die leere Fläche) öffnet das Kontextmenü —
    // Thema-Knoten → Motiv anlegen, Motiv-Knoten → bearbeiten/anlegen/löschen.
    this._motivNetwork.on('oncontext', (params) => {
      params.event.preventDefault();
      const nid = this._motivNetwork?.getNodeAt(params.pointer.DOM);
      this.openGraphMenu(params.event, nid);
    });
    // Nach dem Ziehen eines Knotens die Anordnung persistieren (debounced).
    this._motivNetwork.on('dragEnd', (params) => {
      if (params.nodes?.length) this._scheduleLayoutSave();
    });

    // Nach der Stabilisierung Physik einfrieren (ruhiges Bild, weiter zieh-/zoombar)
    // und die Start-Pins der gespeicherten Knoten lösen. Sind alle Knoten bereits
    // platziert, lief keine Stabilisierung → direkt nachziehen.
    const afterStable = () => {
      this._motivNetwork?.setOptions({ physics: { enabled: false } });
      const release = nodes.filter(n => n.fixed).map(n => ({ id: n.id, fixed: false }));
      if (release.length) this._motivNodes?.update(release);
      if (this.selectedMotifId) this._highlightNode(this.selectedMotifId);
    };
    if (allPlaced) afterStable();
    else this._motivNetwork.once('stabilizationIterationsDone', afterStable);
  },

  // Knoten-Positionen debounced speichern (mehrere Drags koaleszieren).
  _scheduleLayoutSave() {
    clearTimeout(this._layoutSaveTimer);
    this._layoutSaveTimer = setTimeout(() => this._saveLayout(), 500);
  },

  async _saveLayout() {
    if (!this._motivNetwork) return;
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    const positions = this._motivNetwork.getPositions();
    this._savedPositions = positions; // lokal spiegeln, damit Re-Render die Anordnung hält
    try {
      await fetchJson('/motifs/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, positions }),
      });
    } catch (e) { /* Layout ist reine Ansicht — Fehler nicht hart melden */ }
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

  // Ganze Motiv-Karte ins Native-Vollbild — mehr Platz für die Konstellation.
  // Status-Sync via fullscreenchange-Listener in motiv-card.js (motivFullscreen),
  // der den Graph auf die neue Containergrösse neu zeichnet.
  async toggleMotivFullscreen() {
    try {
      await toggleWrapFullscreen(this.$root);
    } catch {
      this.errorMessage = window.__app.t('motiv.error.fullscreen');
    }
  },

  // Gespeicherte Anordnung verwerfen → Physik-Layout frisch berechnen. Persistiert
  // das leere Layout sofort (kein ausstehender Drag-Save überschreibt es wieder).
  async resetLayout() {
    clearTimeout(this._layoutSaveTimer);
    this._layoutSaveTimer = null;
    this._savedPositions = {};
    const bookId = this.$store.nav.selectedBookId;
    if (bookId) {
      try {
        await fetchJson('/motifs/layout', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: bookId, positions: {} }),
        });
      } catch (e) { /* Layout ist reine Ansicht — Fehler nicht hart melden */ }
    }
    this._motivHash = ''; // Signatur-Guard umgehen → Neu-Layout erzwingen
    this.renderMotivGraph();
  },

  // ── Graph-Kontextmenü (Rechtsklick auf Knoten / leere Fläche) ────────────
  // Cursor-verankert: an der Klickposition öffnen, nur an den Viewport-Rand
  // clampen (kein Flip nötig, siehe Harte Regel „Flip-up-Popover").
  openGraphMenu(ev, nodeId) {
    this.graphMenuNodeId = nodeId || null;
    this.graphMenuPos = this._computeGraphMenuPos(ev.clientX, ev.clientY, 220, 180);
    this.graphMenuOpen = true;
    this._attachGraphMenuListeners();
    this.$nextTick(() => {
      const el = this.$refs.graphMenu;
      if (!el) return;
      this.graphMenuPos = this._computeGraphMenuPos(ev.clientX, ev.clientY, el.offsetWidth, el.offsetHeight);
    });
  },

  _computeGraphMenuPos(x, y, pw, ph) {
    const left = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
    const top = Math.max(8, Math.min(window.innerHeight - ph - 8, y));
    return { top, left };
  },

  closeGraphMenu() {
    this.graphMenuOpen = false;
    this.graphMenuNodeId = null;
    this._detachGraphMenuListeners();
  },

  _attachGraphMenuListeners() {
    if (this._graphMenuCloseHandler) return;
    this._graphMenuCloseHandler = () => this.closeGraphMenu();
    window.addEventListener('scroll', this._graphMenuCloseHandler, true);
    window.addEventListener('resize', this._graphMenuCloseHandler);
  },

  _detachGraphMenuListeners() {
    if (!this._graphMenuCloseHandler) return;
    window.removeEventListener('scroll', this._graphMenuCloseHandler, true);
    window.removeEventListener('resize', this._graphMenuCloseHandler);
    this._graphMenuCloseHandler = null;
  },

  // Knoten-Typ für den offenen Menü-Kontext: 'theme' | 'motif' | 'canvas'.
  graphMenuKind() {
    const id = this.graphMenuNodeId;
    if (!id) return 'canvas';
    if (/^t\d+$/.test(id)) return 'theme';
    if (/^m\d+$/.test(id)) return 'motif';
    return 'other';
  },
  graphMenuTheme() {
    const id = this.graphMenuNodeId;
    return (id && /^t\d+$/.test(id)) ? (this.themes.find(t => t.id === Number(id.slice(1))) || null) : null;
  },
  graphMenuMotif() {
    const id = this.graphMenuNodeId;
    return (id && /^m\d+$/.test(id)) ? this.motifById(Number(id.slice(1))) : null;
  },
};
