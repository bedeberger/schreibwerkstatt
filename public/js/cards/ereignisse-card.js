// Alpine.data('ereignisseCard') — Sub-Komponente der Zeitstrahl-Karte.
//
// Eigener State: Meta-Flags (Loading/Status/Progress/PollTimer) + UI-Helper.
// Root behält:
//   - `globalZeitstrahl` (im Store, via $root-Getter auch am Root sichtbar)
//   - `ereignisseFilters` (app-navigation.js schreibt darauf)
//   - `_buildGlobalZeitstrahl` (wird aus figuren.js / loadFiguren gerufen)
//   - `_reloadZeitstrahl` (wird aus app-komplett.js gerufen)
import { setupCardLifecycle } from './card-lifecycle.js';
import { memoizeByIdentity } from '../utils.js';

const _memoEreignisse = () => memoizeByIdentity(([events, suche, figurId, kapitel, seite]) => {
  let result = events;
  if (suche) {
    const q = suche.toLowerCase();
    result = result.filter(ev => (ev.ereignis || '').toLowerCase().includes(q));
  }
  if (figurId) result = result.filter(ev => ev.figuren.some(f => f.id === figurId));
  if (kapitel) {
    result = result.filter(ev => {
      const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
      return kap.includes(kapitel);
    });
  }
  if (seite && kapitel) {
    result = result.filter(ev => {
      const seiten = Array.isArray(ev.seiten) ? ev.seiten : (ev.seite ? [ev.seite] : []);
      return seiten.includes(seite);
    });
  }
  return result;
});

export function registerEreignisseCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ereignisseCard', () => ({
    ereignisseLoading: false,
    ereignisseProgress: 0,
    ereignisseStatus: '',
    zeitstrahlConsolidating: false,
    zeitstrahlProgress: 0,
    zeitstrahlStatus: '',
    _consolidatePollTimer: null,
    _ereignisseExtractPollTimer: null,
    _lifecycle: null,
    _memoFiltered: _memoEreignisse(),

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'ereignisse',
        showFlag: 'showEreignisseCard',
        timerKeys: ['_consolidatePollTimer', '_ereignisseExtractPollTimer'],
        resetState: {
          ereignisseLoading: false,
          ereignisseProgress: 0,
          ereignisseStatus: '',
          zeitstrahlConsolidating: false,
          zeitstrahlProgress: 0,
          zeitstrahlStatus: '',
        },
        load: (root) => root._reloadZeitstrahl(),
        refreshNeedsBookId: false,
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    // UI-Helper. Lesen $root-Filter + -Daten.
    ereignisseKapitelListe() {
      return window.__app._deriveKapitel(window.__app.globalZeitstrahl, ev => ev.kapitel);
    },

    ereignisseSeitenListe() {
      return window.__app._deriveSeiten(
        window.__app.globalZeitstrahl,
        window.__app.ereignisseFilters.kapitel,
        ev => ev.kapitel,
        ev => Array.isArray(ev.seiten) ? ev.seiten : ev.seite,
      );
    },

    filteredEreignisse() {
      const root = window.__app;
      const f = root.ereignisseFilters;
      return this._memoFiltered([
        root.globalZeitstrahl,
        f.suche ?? '',
        f.figurId ?? '',
        f.kapitel ?? '',
        f.seite ?? '',
      ]);
    },
  }));
}
