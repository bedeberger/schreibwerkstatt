// Motiv-Werkstatt — Konstellations-Graph (vis-network, lazy). Themen sind Cluster-
// Anker, Motive die Naben (Grösse = Ist-Dichte aus motif_occurrences; „geplant aber
// fehlt" = Geist-Knoten). Kanten: Thema→Motiv, Motiv↔Motiv (Beziehungstyp) und
// optionale Soll-Layer (Figuren/Beats/Kapitel). Eigene Netzwerk-Instanz — teilt
// keinen State mit dem Figuren-Graph.

import { loadVis } from '../../lazy-libs.js';
import { sendJson } from '../../utils.js';
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

// Knoten-ID-Namespace: jeder Graph-Knoten trägt ein Typ-Präfix vor der DB-ID
// (t=Thema, m=Motiv, f=Figur, df=Werkstatt-Figur, b=Beat, c=Kapitel). Encode/Decode
// als SSoT, damit die Konvention nicht über Render/Click/Hover/Kontextmenü verstreut
// re-implementiert wird — ein neuer Layer-Typ wird nur hier eingetragen.
const NODE_PREFIX = { theme: 't', motif: 'm', figure: 'f', draftFigure: 'df', beat: 'b', chapter: 'c' };
export function nodeId(kind, id) { return `${NODE_PREFIX[kind]}${id}`; }
// Rohe Knoten-ID → { kind, id } oder null. `df` vor den Einzelbuchstaben matchen.
export function parseNode(id) {
  const m = /^(df|[tmfbc])(\d+)$/.exec(id || '');
  if (!m) return null;
  const kind = Object.keys(NODE_PREFIX).find(k => NODE_PREFIX[k] === m[1]);
  return { kind, id: Number(m[2]) };
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
        id: nodeId('theme', t.id), label: t.name, shape: 'circle', margin: 10, widthConstraint: { maximum: 140 },
        // highlight/hover explizit auf die Thema-Farbe: sonst kippt vis-network die
        // Blase bei Selektion/Hover auf seine hellblaue Default-Farbe → weisse
        // Schrift wird unlesbar. Selektion signalisiert stattdessen borderWidthSelected.
        color: { background: tc, border: tc, highlight: { background: tc, border: tc }, hover: { background: tc, border: tc } },
        font: { color: '#fff', size: 14 },
      });
    }

    // Motiv-Naben (Grösse = Ist-Dichte; Geist = geplant aber 0 Fundstellen).
    // Grösse dynamisch gegen die reale Fundstellen-Spanne des Datensatzes
    // normalisiert (nicht feste Absolut-Skala): kleinstes reales Motiv = MIN,
    // grösstes = MAX, √-interpoliert (Fläche ∝ Fundstellen, dämpft Ausreisser).
    // Geist-Knoten (0 Treffer, aber geplant) bleiben fix klein.
    const MOTIF_SIZE_MIN = 14, MOTIF_SIZE_MAX = 46, MOTIF_SIZE_GHOST = 10;
    const _occCounts = this.motifs.filter(m => !this.isGhost(m)).map(m => m.occurrenceCount || 0);
    const _occMin = _occCounts.length ? Math.min(..._occCounts) : 0;
    const _occMax = _occCounts.length ? Math.max(..._occCounts) : 0;
    const _motifSize = (m) => {
      if (this.isGhost(m)) return MOTIF_SIZE_GHOST;
      if (_occMax === _occMin) return (MOTIF_SIZE_MIN + MOTIF_SIZE_MAX) / 2;
      const t = (Math.sqrt(m.occurrenceCount || 0) - Math.sqrt(_occMin)) / (Math.sqrt(_occMax) - Math.sqrt(_occMin));
      return MOTIF_SIZE_MIN + t * (MOTIF_SIZE_MAX - MOTIF_SIZE_MIN);
    };
    const figCatalog = this.$store.catalog.figuren || [];
    // Layer-Knoten (Figur/Beat/Kapitel) können von mehreren Motiven geteilt werden →
    // ID-Set gegen Doppel-Push (statt O(n²)-`nodes.some` je Layer-Eintrag).
    const layerSeen = new Set();
    for (const m of this.motifs) {
      const col = _themeColor(m.theme_id, this.themes, paletteVars);
      const ghost = this.isGhost(m);
      const size = _motifSize(m);
      // highlight/hover explizit auf die Motiv-Farbe (wie bei den Thema-Knoten):
      // sonst kippt vis-network den Punkt bei Selektion/Hover auf seine hellblaue
      // Default-Farbe (Klick selektiert via _highlightNode) und die Thema-Farbe geht
      // verloren — Geist-Knoten würden dabei sogar solide gefüllt. Selektion
      // signalisiert stattdessen borderWidthSelected.
      const mBg = ghost ? 'rgba(0,0,0,0)' : col;
      const mid = nodeId('motif', m.id);
      nodes.push({
        id: mid, label: m.name, shape: 'dot', size,
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
        edges.push({ from: nodeId('theme', m.theme_id), to: mid, dashes: true, color: { color: col, opacity: 0.5 }, width: 1 });
      }

      // Soll-Layer (optional zuschaltbar).
      if (this.layerFigures) {
        for (const f of (m.figures || [])) {
          const nid = nodeId('figure', f.figId);
          if (!layerSeen.has(nid)) {
            layerSeen.add(nid);
            const cat = figCatalog.find(x => String(x.id) === String(f.figId));
            nodes.push({ id: nid, label: (cat?.name || f.name || '?'), shape: 'diamond', size: 9, color: LAYER.figure, font: { color: mutedColor, size: 11 } });
          }
          edges.push({ from: mid, to: nid, dashes: [2, 3], color: { color: LAYER.figure, opacity: 0.6 }, width: 1 });
        }
        // Werkstatt-Figuren (draft_figures) — gleiche Ebene, eigener Knoten-Namespace.
        for (const f of (m.draftFigures || [])) {
          const nid = nodeId('draftFigure', f.id);
          if (!layerSeen.has(nid)) {
            layerSeen.add(nid);
            nodes.push({ id: nid, label: (f.name || '?'), shape: 'diamond', size: 9, color: LAYER.figure, font: { color: mutedColor, size: 11 } });
          }
          edges.push({ from: mid, to: nid, dashes: [2, 3], color: { color: LAYER.figure, opacity: 0.6 }, width: 1 });
        }
      }
      if (this.layerBeats) {
        for (const b of (m.beats || [])) {
          const nid = nodeId('beat', b.id);
          if (!layerSeen.has(nid)) { layerSeen.add(nid); nodes.push({ id: nid, label: b.titel || '?', shape: 'square', size: 9, color: LAYER.beat, font: { color: mutedColor, size: 11 } }); }
          edges.push({ from: mid, to: nid, dashes: [2, 3], color: { color: LAYER.beat, opacity: 0.6 }, width: 1 });
        }
      }
      if (this.layerChapters) {
        for (const c of (m.chapters || [])) {
          const nid = nodeId('chapter', c.id);
          if (!layerSeen.has(nid)) { layerSeen.add(nid); nodes.push({ id: nid, label: c.name || '?', shape: 'triangle', size: 9, color: LAYER.chapter, font: { color: mutedColor, size: 11 } }); }
          edges.push({ from: mid, to: nid, dashes: [2, 3], color: { color: LAYER.chapter, opacity: 0.6 }, width: 1 });
        }
      }
    }

    // Motiv ↔ Motiv (Beziehungstyp als Kantenlabel).
    for (const r of this.relations) {
      edges.push({
        from: nodeId('motif', r.from_motif_id), to: nodeId('motif', r.to_motif_id), label: r.typ,
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
      const ref = parseNode(params.nodes?.[0]);
      this.closeGraphMenu();
      this._closeMotifOccPopover();
      if (ref?.kind === 'motif') this.selectMotif(ref.id);
      else if (ref?.kind === 'theme') this.selectTheme(ref.id);
    });
    // Hover über einen Motiv-Knoten öffnet das Fundstellen-Peek-Popover (occTop);
    // blur schliesst verzögert (Grace-Timer), damit der Cursor aufs Popover wandern
    // kann. Ziehen/Zoomen schliesst sofort (Position würde sonst wegdriften).
    this._motivNetwork.on('hoverNode', (params) => {
      if (parseNode(params.node)?.kind === 'motif') this._openMotifOccPopover(params.node);
    });
    this._motivNetwork.on('blurNode', () => this._scheduleCloseOccPopover());
    this._motivNetwork.on('dragStart', () => this._closeMotifOccPopover());
    this._motivNetwork.on('zoom', () => this._closeMotifOccPopover());
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
      await sendJson('/motifs/layout', 'PUT', { book_id: bookId, positions });
    } catch (e) { /* Layout ist reine Ansicht — Fehler nicht hart melden */ }
  },

  _highlightNode(motifId) {
    if (!this._motivNetwork) return;
    try { this._motivNetwork.selectNodes([nodeId('motif', motifId)]); } catch (_) { /* Knoten evtl. (noch) nicht da */ }
  },

  _destroyGraph() {
    this._closeMotifOccPopover();
    if (this._motivNetwork) { this._motivNetwork.destroy(); this._motivNetwork = null; }
    this._motivNodes = null;
    this._motivEdges = null;
  },

  // ── Fundstellen-Peek am Graph-Knoten (Hover) ──────────────────────────────
  // Hover über einen Motiv-Knoten zeigt seine Top-N Fundstellen (occTop aus dem
  // Graph-Payload) — Peek in den Text, ohne das volle Seitenpanel zu öffnen (das
  // bleibt Klick vorbehalten). Nach <body> teleportiert, JS-positioniert am
  // Knotenzentrum (canvasToDOM); Zeilen springen an die belegende Textstelle.
  // Bleibt offen, solange der Cursor über Knoten ODER Popover ist: blur startet
  // einen Grace-Timer, den mouseenter aufs Popover (keepOccPopover) abbricht.
  _openMotifOccPopover(nid) {
    clearTimeout(this._occHoverCloseTimer);
    const id = parseNode(nid)?.id;
    const m = id != null ? this.motifById(id) : null;
    if (!m || !(m.occTop || []).length) { this._closeMotifOccPopover(); return; }
    const container = document.getElementById('motiv-graph');
    if (!container || !this._motivNetwork) return;
    const pos = this._motivNetwork.getPositions([nid])[nid];
    if (!pos) return;
    const dom = this._motivNetwork.canvasToDOM(pos);
    const rect = container.getBoundingClientRect();
    // Pseudo-Trigger-Rect am Knotenzentrum → gleiche Positionslogik wie Plot
    // (rechts neben den Knoten, nach oben klappen wenn unten kein Platz ist).
    const cx = rect.left + dom.x, cy = rect.top + dom.y;
    this._occTrigRect = { right: cx + 10, left: cx - 10, top: cy - 10, bottom: cy + 10 };
    this.occHoverPos = this._computeOccPopoverPos(this._occTrigRect, 260, 200);
    this.occHoverMotifId = id;
    this.$nextTick(() => {
      const el = this.$refs.motivOccPopover;
      if (!el || !this._occTrigRect) return;
      this.occHoverPos = this._computeOccPopoverPos(this._occTrigRect, el.offsetWidth, el.offsetHeight);
    });
  },

  _computeOccPopoverPos(r, pw, ph) {
    const left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.right));
    const top = (r.bottom + ph + 8 > window.innerHeight)
      ? Math.max(8, r.top - ph - 4)
      : r.bottom + 4;
    return { top, left };
  },

  _scheduleCloseOccPopover() {
    clearTimeout(this._occHoverCloseTimer);
    this._occHoverCloseTimer = setTimeout(() => this._closeMotifOccPopover(), 180);
  },
  keepOccPopover() { clearTimeout(this._occHoverCloseTimer); },
  _closeMotifOccPopover() {
    clearTimeout(this._occHoverCloseTimer);
    this.occHoverMotifId = null;
  },

  // Das gerade gehoverte Motiv (fürs teleportierte Popover ausserhalb des Graphs).
  occHoverMotif() {
    return this.occHoverMotifId != null ? this.motifById(this.occHoverMotifId) : null;
  },

  // Aus dem Peek-Popover an eine Fundstelle springen (Seite + Passage-Highlight,
  // gleiche Mechanik wie die Panel-Liste); Popover vorher schliessen.
  jumpFromPeek(occ) {
    this._closeMotifOccPopover();
    this.gotoOccurrence(occ);
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
        await sendJson('/motifs/layout', 'PUT', { book_id: bookId, positions: {} });
      } catch (e) { /* Layout ist reine Ansicht — Fehler nicht hart melden */ }
    }
    this._motivHash = ''; // Signatur-Guard umgehen → Neu-Layout erzwingen
    this.renderMotivGraph();
  },

  // ── Graph-Kontextmenü (Rechtsklick auf Knoten / leere Fläche) ────────────
  // Cursor-verankert: an der Klickposition öffnen, nur an den Viewport-Rand
  // clampen (kein Flip nötig, siehe Harte Regel „Flip-up-Popover").
  openGraphMenu(ev, nodeId) {
    this._closeMotifOccPopover();
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

  // Knoten-Typ für den offenen Menü-Kontext: 'theme' | 'motif' | 'canvas' | 'other'.
  graphMenuKind() {
    if (!this.graphMenuNodeId) return 'canvas';
    const kind = parseNode(this.graphMenuNodeId)?.kind;
    return (kind === 'theme' || kind === 'motif') ? kind : 'other';
  },
  graphMenuTheme() {
    const ref = parseNode(this.graphMenuNodeId);
    return ref?.kind === 'theme' ? (this.themes.find(t => t.id === ref.id) || null) : null;
  },
  graphMenuMotif() {
    const ref = parseNode(this.graphMenuNodeId);
    return ref?.kind === 'motif' ? this.motifById(ref.id) : null;
  },
};
