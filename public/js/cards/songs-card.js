// Alpine.data('songsCard') — Sub-Komponente der Musik-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Geteilt:
//   - `songs` (Alpine.store('catalog'))
//   - `songsFilters`/`selectedSongId` (Alpine.store('catalogUi') —
//     app-navigation/Hash-Router schreiben darauf)
// Root behält:
//   - `loadSongs`, `saveSongs` (Root-Spread)
import { setupCardLifecycle } from './card-lifecycle.js';
import { applySongsFilters } from '../app/app-ui.js';

export function registerSongsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('songsCard', () => ({
    songsLoading: false,
    songsProgress: 0,
    songsStatus: '',
    _songsPollTimer: null,
    _lifecycle: null,

    // Gefilterte + sortierte Songs für Liste/Grid. Filter-State + Kapitel-Order
    // leben am Root (app-navigation schreibt die Filter, der Tree liefert die
    // Order-Map), darum via window.__app gelesen.
    get songsFiltered() {
      const root = window.__app;
      return applySongsFilters(root.$store.catalog.songs, Alpine.store('catalogUi').songsFilters).sort((a, b) => {
        const aK = Math.min(...(a.kapitel || []).map(k => root._chapterIdx(k.name)), 9999);
        const bK = Math.min(...(b.kapitel || []).map(k => root._chapterIdx(k.name)), 9999);
        if (aK !== bK) return aK - bK;
        return (a.titel || '').localeCompare(b.titel || '', 'de');
      });
    },

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'songs',
        showFlag: 'showSongsCard',
        timerKeys: ['_songsPollTimer'],
        resetState: { songsLoading: false, songsProgress: 0, songsStatus: '' },
        load: (root) => root.loadSongs(Alpine.store('nav').selectedBookId),
        onShow: async (root) => {
          const tasks = [root.loadSongs(Alpine.store('nav').selectedBookId)];
          if (!root.$store.catalog.figuren.length) tasks.push(root.loadFiguren(Alpine.store('nav').selectedBookId));
          await Promise.all(tasks);
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },
  }));
}
