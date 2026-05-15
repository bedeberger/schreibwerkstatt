import { DEFAULT_FONT, nodeLabel } from './constants.js';

// Figurengraph: Kapitel-Swimlane (deterministisch).
// Layout-Idee:
//   X = narrative Kapitel-Achse (Kapitel 1 links, letztes Kapitel rechts);
//       jede Figur landet auf dem gewichteten Mittel ihrer Kapitel-Indizes.
//   Y = Figurentyp-Tier (Hauptfigur oben → Andere unten); innerhalb des Tiers
//       wird per Slot-Allokation eine vertikale Unterreihe gewählt, sobald
//       zwei Figuren am selben x dicht beieinanderliegen.
//   Presence-Bar unter jeder Figur zeigt Kapitel-für-Kapitel die Auftrittsdichte.
//   Keine Physics, keine Zufälligkeit – jede Position ist aus den Daten ableitbar.
export const figurengraphMethods = {
  _renderFigurengraph(container) {
    const figuren = window.__app.figuren;
    const chapterOrder = this.figurenKapitelListe();
    const N = chapterOrder.length;
    const chapIdx = {};
    chapterOrder.forEach((c, i) => { chapIdx[c] = i; });

    // Spaltenbreite skaliert mit Container-Breite / Kapitelzahl. Bei vielen Kapiteln
    // (z.B. 37 Spalten in 900 px Container) würde 440 px/Spalte eine 16k-Canvas erzeugen,
    // in die fit() winzige Nodes hineinzoomt. Floor 160 hält Presence-Bar lesbar.
    const containerW      = container.offsetWidth || 900;
    const COL_W           = Math.max(160, Math.min(440, containerW / Math.max(N, 4)));
    const ROW_H           = 50;   // Vertikaler Abstand zwischen zwei Stapelzeilen innerhalb eines Tiers
    const TIER_BASE_GAP   = 80;   // Zusatz-Luft zwischen zwei Tiers
    const MIN_DX          = 130;  // Minimaler horizontaler Abstand zwischen zwei Figuren derselben Zeile
    const TIER_ORDER      = ['hauptfigur', 'antagonist', 'mentor', 'nebenfigur', 'randfigur', 'andere'];
    const TIER_COLOR = {
      hauptfigur: '#2d6a9f', antagonist: '#E24B4A',
      mentor:     '#639922', nebenfigur: '#666',    randfigur: '#999', andere: '#c4a55a',
    };
    const tierOf = f => TIER_ORDER.includes(f.typ) ? f.typ : 'andere';

    // Pro Figur: gewichteter x-Index, Ersterscheinung, Tier, Wichtigkeit
    const weight = k => Math.pow(k.haeufigkeit || 1, 1.5);
    const info = {};
    for (const f of figuren) {
      const kaps = (f.kapitel || []).filter(k => chapIdx[k.name] !== undefined);
      let xIdx = N > 1 ? (N - 1) / 2 : 0;
      let firstCh = Number.POSITIVE_INFINITY;
      if (kaps.length) {
        const total = kaps.reduce((s, k) => s + weight(k), 0);
        let sum = 0;
        for (const k of kaps) {
          sum += chapIdx[k.name] * (weight(k) / total);
          if (chapIdx[k.name] < firstCh) firstCh = chapIdx[k.name];
        }
        xIdx = sum;
      }
      const importance = (f.kapitel || []).reduce((s, k) => s + (k.haeufigkeit || 0), 0);
      info[f.id] = { xIdx, firstCh, tier: tierOf(f), importance };
    }

    // Tier-Buckets in fester Reihenfolge; nur belegte Tiers werden gerendert.
    const byTier = {};
    for (const t of TIER_ORDER) byTier[t] = [];
    for (const f of figuren) byTier[info[f.id].tier].push(f);
    const tiersUsed = TIER_ORDER.filter(t => byTier[t].length > 0);

    // Layout pro Tier: Figuren sitzen an ihrem tatsächlichen narrativen Schwerpunkt
    // (xIdx * COL_W). Greedy-Stapelung: jede Figur kommt in die oberste Zeile, in
    // der sie zur zuletzt platzierten Figur dieser Zeile mindestens MIN_DX Abstand
    // hat. So gibt es kein Binning mehr → keine Clumps an Kapitelrändern.
    const sortFigs = arr => arr.slice().sort((a, b) => {
      const ax = info[a.id].xIdx, bx = info[b.id].xIdx;
      if (ax !== bx) return ax - bx;
      const af = info[a.id].firstCh, bf = info[b.id].firstCh;
      if (af !== bf) return af - bf;
      return (a.name || '').localeCompare(b.name || '');
    });
    const layoutPerTier = {};
    for (const t of tiersUsed) {
      const rowLastX = []; // row → x der zuletzt platzierten Figur
      const items = [];
      for (const f of sortFigs(byTier[t])) {
        const x = info[f.id].xIdx * COL_W;
        let row = 0;
        while (row < rowLastX.length && x - rowLastX[row] < MIN_DX) row++;
        rowLastX[row] = x;
        items.push({ f, x, row });
      }
      layoutPerTier[t] = { items, maxRows: Math.max(1, rowLastX.length) };
    }

    // Y-Koordinaten kumulativ: jedes Tier nimmt so viel Platz, wie es Stapelzeilen
    // gibt. Damit ragen Nebenfiguren-Stapel nicht ins nächste Tier.
    const TIER_Y = {};
    let yCursor = 0;
    for (const t of tiersUsed) {
      TIER_Y[t] = yCursor;
      yCursor += (layoutPerTier[t].maxRows - 1) * ROW_H + TIER_BASE_GAP;
    }

    const nodePositions = [];
    for (const t of tiersUsed) {
      for (const { f, x, row } of layoutPerTier[t].items) {
        nodePositions.push({ f, x, y: TIER_Y[t] + row * ROW_H });
      }
    }

    // Startpositionen deterministisch; Physics bleibt aus, damit Nodes ohne
    // Rückzug dort bleiben, wohin der Nutzer sie zieht.
    this._figurenNodes = new vis.DataSet(nodePositions.map(({ f, x, y }) => {
      const borderWidth = Math.min(4, 1 + Math.round(Math.log2(Math.max(1, info[f.id].importance))));
      return {
        id: f.id,
        label: nodeLabel(f),
        color: this._figTypColor(f.typ),
        font: DEFAULT_FONT,
        shape: 'box',
        margin: 10,
        widthConstraint: { maximum: 160 },
        borderWidth,
        x, y,
      };
    }));
    const nodes = this._figurenNodes;

    const { edgeList } = this._buildEdges(/* soziogrammModus */ false);
    this._figurenEdges = new vis.DataSet(edgeList);
    const edges = this._figurenEdges;

    this._figurenNetwork = new vis.Network(container, { nodes, edges }, {
      physics: false,
      layout: { improvedLayout: false },
      interaction: { hover: true, tooltipDelay: 100, dragNodes: true },
      edges: { smooth: { type: 'curvedCW', roundness: 0.15 } },
    });
    const network = this._figurenNetwork;

    // Vertikale Ausdehnung für Kapitel-Spalten (genug Luft über/unter den Tier-Bändern)
    const lastTier   = tiersUsed[tiersUsed.length - 1];
    const lastTierY  = lastTier
      ? TIER_Y[lastTier] + (layoutPerTier[lastTier].maxRows - 1) * ROW_H
      : 0;
    const PAD_Y      = 200;
    const Y_TOP      = -PAD_Y;
    const Y_BOT      = lastTierY + PAD_Y;

    network.on('beforeDrawing', ctx => {
      // 1) Kapitel-Spalten (Netzwerk-Koordinaten → skalieren mit Zoom)
      if (N > 0) {
        ctx.save();
        for (let i = 0; i < N; i++) {
          const cx = i * COL_W;
          ctx.fillStyle = (i % 2 === 0) ? 'rgba(0,0,0,0.028)' : 'rgba(0,0,0,0)';
          ctx.fillRect(cx - COL_W / 2, Y_TOP, COL_W, Y_BOT - Y_TOP);
          ctx.strokeStyle = 'rgba(0,0,0,0.06)';
          ctx.lineWidth   = 0.5;
          ctx.beginPath();
          ctx.moveTo(cx - COL_W / 2, Y_TOP);
          ctx.lineTo(cx - COL_W / 2, Y_BOT);
          ctx.stroke();
        }
        const edgeX = (N - 1) * COL_W + COL_W / 2;
        ctx.beginPath();
        ctx.moveTo(edgeX, Y_TOP); ctx.lineTo(edgeX, Y_BOT); ctx.stroke();
        ctx.restore();
      }

      const dpr = window.devicePixelRatio || 1;
      // Adaptive Schriftgrösse: bei kleinem Container (600 px) bleiben 11/10 px,
      // im Fullscreen (Canvas wächst auf >1000 px Höhe) skalieren Header/Tier
      // proportional bis 18/15 — sonst sind die Kapitel im Vollbild unlesbar.
      const cHeightCss  = ctx.canvas.height / dpr;
      const cWidthCss   = ctx.canvas.width / dpr;
      const headerFs    = Math.max(11, Math.min(18, cHeightCss / 55));
      const tierFs      = Math.max(10, Math.min(15, cHeightCss / 65));
      const lblMaxChars = cHeightCss > 700 ? 60 : 34;

      // 2) Kapitel-Header oben (Screen-Koordinaten → feste Lesegrösse, folgen dem Pan).
      // Header-Stride hängt vom aktuellen Zoom ab: bei dichten Spalten (viele Kapitel
      // oder rausgezoomt) wird nur jeder n-te Header gezeichnet, sonst überlappen die
      // Labels. Letzte Spalte immer gezeichnet (Orientierung).
      if (N > 0) {
        const scale    = network.getScale();
        const pxPerCol = COL_W * scale;
        const step     = Math.max(1, Math.ceil(70 / Math.max(1, pxPerCol)));
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.font = `600 ${headerFs * dpr}px system-ui,-apple-system,sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = '#555';
        for (let i = 0; i < N; i++) {
          if (i % step !== 0 && i !== N - 1) continue;
          const dom = network.canvasToDOM({ x: i * COL_W, y: Y_TOP });
          if (dom.x < -120 || dom.x > cWidthCss + 120) continue;
          const raw = `${i + 1}. ${chapterOrder[i]}`;
          const lbl = raw.length > lblMaxChars ? raw.slice(0, lblMaxChars - 2) + '…' : raw;
          ctx.fillText(lbl, dom.x * dpr, 8 * dpr);
        }
        ctx.restore();
      }

      // 3) Tier-Labels links am Canvas-Rand (Screen-Koordinaten)
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `600 ${tierFs * dpr}px system-ui,-apple-system,sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      const padY = (tierFs * 0.9) * dpr;
      const pillH = (tierFs * 1.6) * dpr;
      for (const t of tiersUsed) {
        const midY = TIER_Y[t] + ((layoutPerTier[t].maxRows - 1) * ROW_H) / 2;
        const dom = network.canvasToDOM({ x: 0, y: midY });
        if (dom.y < -16 || dom.y > cHeightCss + 16) continue;
        const label = window.__app.t('figuren.type.' + t);
        const tw    = ctx.measureText(label).width;
        const px = 6 * dpr, py = dom.y * dpr - padY, pw = tw + 12 * dpr, pr = 4 * dpr;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px, py, pw, pillH, pr);
        else ctx.rect(px, py, pw, pillH);
        ctx.fill();
        ctx.fillStyle = TIER_COLOR[t] || '#555';
        ctx.fillText(label, 12 * dpr, dom.y * dpr);
      }
      ctx.restore();
    });

    // 4) Presence-Bar unter jeder Node (Netzwerk-Koordinaten, skaliert mit Zoom).
    // Bei vielen Kapiteln (N=37) wären 70 px / Segmentbreite ~1.9 px → unsichtbar;
    // Min-Breite skaliert mit N (min 3 px pro Segment), Cap bei 220 px gegen Overlap.
    if (N > 0) {
      const minBarW = Math.min(220, Math.max(70, N * 3));
      network.on('afterDrawing', ctx => {
        ctx.save();
        for (const f of figuren) {
          const bb = network.getBoundingBox(f.id);
          if (!bb) continue;
          const barW    = Math.max(bb.right - bb.left, minBarW);
          const barLeft = (bb.left + bb.right) / 2 - barW / 2;
          const barY    = bb.bottom + 4;
          const barH    = 4;
          const segW    = barW / N;
          const kapsByName = {};
          for (const k of (f.kapitel || [])) kapsByName[k.name] = k.haeufigkeit || 1;
          // Hintergrund
          ctx.fillStyle = 'rgba(0,0,0,0.07)';
          ctx.fillRect(barLeft, barY, barW, barH);
          // Gefüllte Segmente pro Kapitel mit Auftritt
          const tier = info[f.id].tier;
          const col  = TIER_COLOR[tier] || '#2d6a9f';
          const [r, g, b] = col.startsWith('#') ? [parseInt(col.slice(1,3),16), parseInt(col.slice(3,5),16), parseInt(col.slice(5,7),16)] : [45,106,159];
          for (let i = 0; i < N; i++) {
            const h = kapsByName[chapterOrder[i]];
            if (!h) continue;
            const alpha = Math.min(1, 0.35 + h / 5);
            ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
            ctx.fillRect(barLeft + i * segW + 0.5, barY, Math.max(0.5, segW - 1), barH);
          }
        }
        ctx.restore();
      });
    }

    // Klick auf Kapitel-Header → Filter setzen
    network.on('click', ({ pointer, event }) => {
      if (N === 0) return;
      // pointer.canvas = Netzwerk-Koordinaten; Header-Band liegt über Y_TOP.
      if (pointer.canvas.y > Y_TOP + 60) return;
      const idx = Math.round(pointer.canvas.x / COL_W);
      if (idx < 0 || idx >= N) return;
      const ch = chapterOrder[idx];
      this._figurenGraphSetKapitel(this.figurenGraphKapitel === ch ? null : ch);
      event?.preventDefault?.();
    });

    // Sofort fitten (keine Stabilisierung nötig, Physics ist aus).
    // fit() auf Node-IDs statt Canvas: leere Kapitel-Spalten würden sonst die
    // Bounding-Box aufblähen → Nodes mikroskopisch im Viewport.
    const fitIds = figuren.map(f => f.id);
    requestAnimationFrame(() => {
      network.fit({ nodes: fitIds, animation: { duration: 250, easingFunction: 'easeInOutQuad' } });
      if (this.figurenGraphKapitel) this._figurenGraphSetKapitel(this.figurenGraphKapitel);
    });

    this._attachTooltip(container);
  },
};
