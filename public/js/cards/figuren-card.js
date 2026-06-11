// Alpine.data('figurenCard') — Sub-Komponente der Figurenübersicht.
//
// Eigener State:
//   - Graph-Modus (figurenGraphModus, figurenGraphKapitel, figurenGraphFullscreen)
//   - vis-network-Internals (_figurenNetwork, _figurenHash, _figurenNodes, _figurenEdges)
//   - figurenUpdatedAt (Render-Timestamp im Card-Header)
//
// Root behält:
//   - `figuren` (im Store, via $root-Proxy)
//   - `figurenFilters` (app-navigation schreibt darauf)
//   - `selectedFigurId` (Hash-Router)
//   - `figurenLoading/Progress/Status` (checkPendingJobs schreibt darauf)
//   - `loadFiguren`, `saveFiguren` (von vielen Modulen gerufen)

import { graphMethods } from '../graph.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { memoizeByIdentity } from '../utils.js';

const FIGUR_TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, randfigur: 4, andere: 5 };

const _memoFiguren = () => memoizeByIdentity(([figuren, chapterMap, suche, kapitel, seite]) => {
  let result = figuren;
  const q = (suche || '').toLowerCase();
  if (q) result = result.filter(f => (f.name ?? '').toLowerCase().includes(q));
  if (kapitel) result = result.filter(f => (f.kapitel ?? []).some(k => k.name === kapitel));
  if (seite) result = result.filter(f =>
    (f.seiten ?? []).some(s => s.kapitel === kapitel && s.seite === seite));

  // minChapterIdx pro Figur einmal vorab berechnen (kein Math.min(...spread) im Comparator).
  const minIdx = new Map();
  const idxOf = (f) => {
    let m = minIdx.get(f);
    if (m !== undefined) return m;
    m = 9999;
    const ks = f.kapitel;
    if (ks) for (let i = 0; i < ks.length; i++) {
      const v = chapterMap?.get(ks[i].name) ?? 9999;
      if (v < m) m = v;
    }
    minIdx.set(f, m);
    return m;
  };
  return [...result].sort((a, b) => {
    const aK = idxOf(a);
    const bK = idxOf(b);
    if (aK !== bK) return aK - bK;
    const aT = FIGUR_TYP_ORDER[a.typ] ?? 99;
    const bT = FIGUR_TYP_ORDER[b.typ] ?? 99;
    if (aT !== bT) return aT - bT;
    return (a.name ?? '').localeCompare(b.name ?? '', 'de');
  });
});

const _memoFigurenKapitel = () => memoizeByIdentity(([figuren]) =>
  window.__app._deriveKapitel(figuren, f => f.kapitel));

const _memoFigurenSeiten = () => memoizeByIdentity(([figuren, kapitel]) => {
  if (!kapitel) return [];
  const names = new Set();
  for (const f of (figuren || [])) {
    for (const s of (f.seiten || [])) {
      if (s.kapitel === kapitel && s.seite) names.add(s.seite);
    }
  }
  return window.__app._sortByPageOrder([...names]);
});

export function registerFigurenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('figurenCard', () => ({
    figurenUpdatedAt: null,
    figurenGraphModus: 'figur',
    figurenGraphKapitel: null,
    figurenGraphFullscreen: false,
    figurenLegendOpen: false,
    _figurenNetwork: null,
    _figurenHash: null,
    _figurenNodes: null,
    _figurenEdges: null,
    _memoFiltered: _memoFiguren(),
    _memoKapitel: _memoFigurenKapitel(),
    _memoSeiten: _memoFigurenSeiten(),
    _lifecycle: null,

    init() {
      const destroyNet = () => {
        if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
        // vis-network DataSets halten Referenzen aufs alte Buch; ohne null
        // bleiben sie bis zum nächsten view:reset im Speicher.
        this._figurenNodes = null;
        this._figurenEdges = null;
        this._figurenHash = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'figuren',
        showFlag: 'showFiguresCard',
        load: async (root) => {
          await root.loadFiguren(root.selectedBookId);
          await this.$nextTick();
          this.renderFigurGraph();
        },
        // book:changed: Netzwerk wegwerfen + Header-Timestamp + Kapitelfilter
        // resetten. loadFiguren läuft bereits aus _resetBookScopedState
        // (loadPages) — wir warten nur auf den Reactive-Update und rendern dann.
        onBookChanged: async (e, ctx, root) => {
          destroyNet();
          ctx.figurenUpdatedAt = null;
          ctx.figurenGraphKapitel = null;
          if (!root.showFiguresCard) return;
          if (!root.selectedBookId) return;
          await ctx.$nextTick();
          ctx.renderFigurGraph();
        },
        onViewReset: (e, ctx) => {
          destroyNet();
          ctx.figurenUpdatedAt = null;
          ctx.figurenGraphModus = 'figur';
          ctx.figurenGraphKapitel = null;
          ctx.figurenGraphFullscreen = false;
        },
      });

      // Sprachwechsel → Graph-Labels neu rendern (uiLocale Teil des Hash).
      this.$watch(() => window.__app.uiLocale, () => {
        if (window.__app.showFiguresCard && window.__app.figuren?.length) {
          this.renderFigurGraph();
        }
      });

      // Native Fullscreen-API: State spiegeln, Canvas neu fitten, beim Verlassen
      // (Esc / Browser-UI) Toggle-Flag sauber zurücksetzen.
      attachFullscreenSync({
        resolveWrap: () => document.getElementById('figuren-graph')?.closest('.figuren-graph-wrap'),
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.figurenGraphFullscreen = active;
          if (this._figurenNetwork) {
            // vis-network hört auf window.resize → Canvas an neuen Container anpassen.
            window.dispatchEvent(new Event('resize'));
            requestAnimationFrame(() => {
              this._figurenNetwork?.fit({ animation: { duration: 200, easingFunction: 'easeInOutQuad' } });
            });
          }
        },
      });
    },

    destroy() {
      // Falls Karte im Vollbild abgebaut wird (Buchwechsel etc.): zuerst Browser-Fullscreen verlassen.
      if (document.fullscreenElement?.classList?.contains?.('figuren-graph-wrap')) {
        try { document.exitFullscreen?.(); } catch {}
      }
      this._lifecycle?.destroy();
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
    },

    // UI-Helper: aus Comboboxen via x-effect mehrfach pro Render gerufen
    // (für _disabled + options). Memo auf Identität der Quell-Daten.
    figurenKapitelListe() {
      return this._memoKapitel([window.__app.figuren]);
    },

    figurenSeitenListe() {
      // seiten = Array {kapitel, seite} — eigener Iterator (keine 1:1-Relation).
      return this._memoSeiten([window.__app.figuren, window.__app.figurenFilters.kapitel]);
    },

    filteredFiguren() {
      const root = window.__app;
      const f = root.figurenFilters;
      return this._memoFiltered([
        root.figuren,
        root._chapterOrderMap,
        f.suche ?? '',
        f.kapitel ?? '',
        f.seite ?? '',
      ]);
    },

    ...graphMethods,
  }));
}
