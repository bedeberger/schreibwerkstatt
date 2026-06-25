import { escHtml } from '../utils.js';
import {
  DEFAULT_FONT,
  TYP_COLOR,
  SCHICHT_COLOR,
  BZ,
  BZ_SOZIO_COLOR,
  BZ_SOZIO_CAT,
  DIRECTED_TYPES,
  nodeLabel,
} from './constants.js';

// Gemeinsame Methoden: Typ-Color, Node-Basis, Edge-Bau, Tooltip, Kapitel-Filter.
// Werden in graphMethods gespreaded und nutzen `this`-Refs aus Card.
export const sharedMethods = {
  // Figuren-Quelle für alle Graph-Ansichten: verwaiste (stale) Figuren werden
  // ausgeblendet. Sie stehen nicht mehr im Text und würden sonst als
  // beziehungslose Geister-Knoten den Graph verschmutzen (ihre kapitel-Belege
  // bleiben erhalten). Im Figuren-Katalog bleiben sie — mit Badge — sichtbar.
  _graphFiguren() {
    return (window.__app.figuren || []).filter(f => !f.stale);
  },

  _figTypColor(typ) {
    return TYP_COLOR[typ] || TYP_COLOR.andere;
  },

  // Gemeinsame vis-Node-Basis. Familiengraph nutzt sie direkt; Figurengraph
  // ergänzt borderWidth + x/y, Soziogramm überschreibt color/font und ergänzt
  // x/y + fixed (spätere Keys gewinnen beim Spread).
  _baseNode(f) {
    return {
      id: f.id,
      label: nodeLabel(f),
      color: this._figTypColor(f.typ),
      font: DEFAULT_FONT,
      shape: 'box',
      margin: 10,
      widthConstraint: { maximum: 160 },
    };
  },

  _figurenGraphSetKapitel(ch) {
    this.figurenGraphKapitel = ch;
    if (!this._figurenNodes || !this._figurenEdges) return;

    const figuren = this._graphFiguren();
    const existingIds = new Set(this._figurenNodes.getIds());
    const activeIds = new Set(
      ch ? figuren.filter(f => (f.kapitel || []).some(k => k.name === ch)).map(f => f.id)
         : figuren.map(f => f.id)
    );
    const soziogrammModus = this.figurenGraphModus === 'soziogramm';

    this._figurenNodes.update(figuren.filter(f => existingIds.has(f.id)).map(f => {
      if (!ch || activeIds.has(f.id)) {
        const schichtStyle = soziogrammModus
          ? (SCHICHT_COLOR[f.sozialschicht] || SCHICHT_COLOR.andere)
          : null;
        const color = soziogrammModus
          ? { background: schichtStyle.background, border: schichtStyle.border, highlight: schichtStyle.highlight }
          : this._figTypColor(f.typ);
        const font = soziogrammModus ? (schichtStyle.font || DEFAULT_FONT) : { ...DEFAULT_FONT, color: '#333' };
        return { id: f.id, color, font };
      }
      return {
        id: f.id,
        color: { background: '#efefef', border: '#ccc', highlight: { background: '#efefef', border: '#ccc' } },
        font: { ...DEFAULT_FONT, color: '#bbb' },
      };
    }));

    this._figurenEdges.update(this._figurenEdges.get().map(e => {
      if (!ch || activeIds.has(e.from) || activeIds.has(e.to)) {
        if (soziogrammModus) {
          const cat   = BZ_SOZIO_CAT[e.typ] || 'sozial';
          const color = BZ_SOZIO_COLOR[cat];
          return { id: e.id, color: { color, highlight: color } };
        }
        const s = BZ[e.typ] || BZ.andere;
        return { id: e.id, color: { color: s.color, highlight: s.highlight } };
      }
      return { id: e.id, color: { color: '#ddd', highlight: '#ddd' } };
    }));
  },

  _buildEdges(soziogrammModus) {
    const figuren = this._graphFiguren();
    // id→Figur einmal indizieren (String-Keys: bz.figur_id und f.id sind beide der
    // TEXT-fig_id, die Normalisierung deckt Alt-Daten mit Zahl-IDs mit ab).
    const byId = new Map(figuren.map(f => [String(f.id), f]));
    const edgeList = [];
    const addedPairs = new Set();

    for (const f of figuren) {
      for (const bz of (f.beziehungen || [])) {
        const targetFigur = byId.get(String(bz.figur_id));
        if (!targetFigur) continue;
        const toId = targetFigur.id;

        const dedupeKey = DIRECTED_TYPES.includes(bz.typ)
          ? [f.id, toId, bz.typ].join('|')
          : [[f.id, toId].sort().join('-'), bz.typ].join('|');
        if (addedPairs.has(dedupeKey)) continue;
        addedPairs.add(dedupeKey);

        if (soziogrammModus) {
          const cat    = BZ_SOZIO_CAT[bz.typ] || 'sozial';
          const color  = BZ_SOZIO_COLOR[cat];
          const macht  = bz.machtverhaltnis ?? 0;
          const width  = 1 + Math.abs(macht) * 1.5;
          let arrows = '';
          if (macht > 0)       arrows = 'to';
          else if (macht < 0)  arrows = 'from';
          else if (DIRECTED_TYPES.includes(bz.typ)) arrows = BZ[bz.typ]?.arrows || '';

          edgeList.push({
            from: f.id, to: toId,
            label: '',
            typ: bz.typ,
            beschreibung: bz.beschreibung || '',
            color: { color, highlight: color },
            arrows,
            dashes: false,
            width,
          });
        } else {
          const s = BZ[bz.typ] || BZ.andere;
          edgeList.push({
            from: f.id, to: toId,
            label: '',
            typ: bz.typ,
            beschreibung: bz.beschreibung || '',
            color: { color: s.color, highlight: s.highlight },
            arrows: s.arrows,
            dashes: s.dashes,
          });
        }
      }
    }
    return { edgeList };
  },

  // Tooltip: HTML aus escHtml()-Atomen — XSS-Escape-Invariante eingehalten.
  _attachTooltip(container) {
    const tip = document.getElementById('figur-tooltip');
    if (!tip) return;
    // id→Figur einmal pro Render indizieren (Hover-Handler statt O(F)-find).
    const byId = new Map(this._graphFiguren().map(f => [f.id, f]));

    const showTipAt = (html, clientX, clientY) => {
      tip.innerHTML = html;
      tip.style.left = '0px';
      tip.style.top  = '0px';
      tip.classList.add('visible');
      const rect = container.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const cW   = container.offsetWidth;
      const cH   = container.offsetHeight;
      const cx   = clientX - rect.left;
      const cy   = clientY - rect.top;
      let left = cx + 14;
      let top  = cy + 14;
      if (left + tipW > cW) left = Math.max(0, cx - tipW - 14);
      if (top  + tipH > cH) top  = Math.max(0, cy - tipH - 14);
      if (left < 0) left = 0;
      if (top  < 0) top  = 0;
      tip.style.left = left + 'px';
      tip.style.top  = top  + 'px';
    };
    const hideTip = () => tip.classList.remove('visible');

    this._figurenNetwork.on('hoverNode', ({ node, event }) => {
      const f = byId.get(node);
      if (!f) return;
      const schichtLabel = f.sozialschicht && f.sozialschicht !== 'andere'
        ? window.__app.t('figuren.schicht.' + f.sozialschicht) : '';
      const typLabel = f.typ ? window.__app.t('figuren.type.' + f.typ) : '';
      const html = `<strong>${escHtml(f.name)}</strong>`
        + `<em>${escHtml(typLabel)}${schichtLabel ? ' · ' + escHtml(schichtLabel) : ''}</em>`
        + (f.beschreibung ? `<p>${escHtml(f.beschreibung)}</p>` : '');
      showTipAt(html, event.clientX, event.clientY);
    });
    this._figurenNetwork.on('blurNode', hideTip);

    this._figurenNetwork.on('hoverEdge', ({ edge, event }) => {
      const e = this._figurenEdges?.get(edge);
      if (!e) return;
      const fromF = byId.get(e.from);
      const toF   = byId.get(e.to);
      const typLabel = window.__app.t('figuren.bz.' + e.typ);
      const arrow = e.arrows === 'to' ? '→' : e.arrows === 'from' ? '←' : '↔';
      const pair = fromF && toF
        ? `${escHtml(fromF.kurzname || fromF.name)} ${arrow} ${escHtml(toF.kurzname || toF.name)}`
        : '';
      const html = `<strong>${escHtml(typLabel)}</strong>`
        + (pair ? `<em>${pair}</em>` : '')
        + (e.beschreibung ? `<p>${escHtml(e.beschreibung)}</p>` : '');
      showTipAt(html, event.clientX, event.clientY);
    });
    this._figurenNetwork.on('blurEdge', hideTip);
  },
};
