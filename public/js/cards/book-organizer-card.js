// Alpine.data('bookOrganizerCard') — Sub-Komponente Buchorganizer.
//
// Reorder/Move (DnD via SortableJS, lazy), Create/Rename/Delete für Kapitel +
// Seiten + Undo/Redo (max 10 Aktionen). Keine KI, keine Job-Queue — direkter
// Storage-Zugriff via contentRepo (Domain-Repository, /content/*).
//
// Speicher-Strategie: nach jeder erfolgreichen Mutation patchen wir den
// Root-Tree IN-PLACE. Kein `loadPages()` (würde root.pages + root.tree
// reassignen → ganze App-UI re-rendert, sichtbarer Flicker). Sidebar liest
// dieselben Items, die wir mutieren, und re-rendert nur die betroffenen Stellen
// via Alpine-Deep-Reactivity.
//
// Re-Snapshot der Card-Visualisierung passiert ausschliesslich über das
// `pages:loaded`-Event aus tree.js (echte Server-Reloads, z.B. Buchwechsel) —
// nicht über einen $watch der Tree-Identität, sonst würden eigene
// Reassignments im Tree zur Selbst-Reentry führen.
//
// Methoden-Pool kommt aus ../book-organizer.js (Slices: dnd, persist, mirror,
// crud, history).

import { setupCardLifecycle } from './card-lifecycle.js';
import { loadSortable } from '../lazy-libs.js';
import { bookOrganizerMethods } from '../book-organizer.js';

export function registerBookOrganizerCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookOrganizerCard', () => ({
    organizerSaving: false,
    organizerStatus: '',
    organizerProgress: 0,
    workTree: [],      // [{ id, name, pages: [{ id, name, chapter_id }] }]
    soloPages: [],     // [{ id, name, chapter_id: 0 }]
    _sortables: [],
    _lifecycle: null,
    _undoStack: [],
    _redoStack: [],
    _inHistoryFlight: false,
    _onHistoryKeydown: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'bookOrganizer',
        showFlag: 'showBookOrganizerCard',
        resetState: {
          workTree: [], soloPages: [],
          organizerStatus: '', organizerProgress: 0, organizerSaving: false,
          _undoStack: [], _redoStack: [], _inHistoryFlight: false,
        },
        onShow: async () => {
          await loadSortable();
          await this._rerender();
        },
        // book:changed feuert VOR loadPages — Sortable cleanen + State leeren,
        // der pages:loaded-Listener unten greift, sobald loadPages fertig ist.
        onBookChanged: (e, ctx) => {
          ctx._destroySortables();
          Object.assign(ctx, {
            workTree: [], soloPages: [],
            organizerStatus: '', organizerProgress: 0, organizerSaving: false,
            _undoStack: [], _redoStack: [], _inHistoryFlight: false,
          });
        },
        onCardRefresh: async (e, ctx, root) => {
          await root.loadPages(); // pages:loaded triggert _rerender
        },
        onViewReset: (e, ctx) => {
          ctx._destroySortables();
          Object.assign(ctx, {
            workTree: [], soloPages: [],
            _undoStack: [], _redoStack: [], _inHistoryFlight: false,
          });
        },
        extraListeners: [
          { type: 'pages:loaded', handler: async () => {
            if (!window.__app.showBookOrganizerCard) return;
            await loadSortable();
            await this._rerender();
          } },
        ],
      });

      // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z + Cmd/Ctrl+Y. Nur wenn Karte sichtbar
      // und Fokus nicht in einem Input/Textarea (sonst greift die native
      // Edit-Undo-Funktion der Rename-Felder).
      this._onHistoryKeydown = (e) => {
        if (!window.__app?.showBookOrganizerCard) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const cmd = e.metaKey || e.ctrlKey;
        if (!cmd) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          this.historyUndo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          this.historyRedo();
        }
      };
      window.addEventListener('keydown', this._onHistoryKeydown, { signal: this._lifecycle.signal });
    },

    destroy() {
      this._destroySortables();
      this._lifecycle?.destroy();
    },

    ...bookOrganizerMethods,
  }));
}
