// Alpine.data('songsCard') — Sub-Komponente der Musik-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Root behält:
//   - `songs` (im Store)
//   - `songsFilters` (app-navigation.js schreibt darauf)
//   - `selectedSongId` (Hash-Router)
//   - `loadSongs`, `saveSongs`, `songsFiltered` (Root-Spread)
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerSongsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('songsCard', () => ({
    songsLoading: false,
    songsProgress: 0,
    songsStatus: '',
    _songsPollTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'songs',
        showFlag: 'showSongsCard',
        timerKeys: ['_songsPollTimer'],
        resetState: { songsLoading: false, songsProgress: 0, songsStatus: '' },
        load: (root) => root.loadSongs(root.selectedBookId),
        onShow: async (root) => {
          const tasks = [root.loadSongs(root.selectedBookId)];
          if (!root.figuren.length) tasks.push(root.loadFiguren(root.selectedBookId));
          await Promise.all(tasks);
        },
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },
  }));
}
