// Alpine.data('ideenBoardCard') — Ideen-Board: alle Notizen und Pendenzen eines
// Buches auf einem Brett.
//
// Verhaeltnis zur Ideen-Karte (`ideenCard`): dieselben Zeilen, zwei Fragen. Die
// Ideen-Karte steht neben dem Editor und beantwortet „was ist an DIESER Stelle
// offen"; das Board steht fuer sich und beantwortet „was ist im ganzen Buch
// offen und wie weit ist es". Darum ist es eine eigene Hauptkarte (exklusiv,
// Buch-skopiert) und nicht ein zweiter Modus der Ideen-Karte, die parallel zum
// Editor lebt.
//
// User-privat wie die Ideen selbst: `ideen.user_email` ist Sichtbarkeits-Scope,
// nicht Attribution — auf einem geteilten Buch sieht jeder sein eigenes Brett.

import { setupCardLifecycle } from './card-lifecycle.js';
import { ideenBoardMethods } from '../book/ideen-board.js';
import { buildLaneOrder } from '../book/ideen-board/model.js';

// Filterleiste pro Buch im localStorage. `showVerworfen` steht bewusst per
// Default auf false: das Board ist eine Pendenzenliste, und was man verworfen
// hat, soll beim Oeffnen nicht mitarbeiten. Die Spalte bleibt sichtbar (mit
// ihrem Zaehler), nur ihre Karten sind eingeklappt — verworfen ist eine Stufe,
// kein Loeschen.
//
// Im selben Scope liegt die KLAPPUNG (`collapsedLanes`, `collapsedChapters` —
// je eine Liste von Bahn-Keys): sie ist wie der Filter eine Sicht auf dasselbe
// Buch und soll den Kartenwechsel ueberleben — wer ein Buch mit dreissig
// Kapiteln einmal zusammengeklappt hat, will das nicht bei jedem Oeffnen
// wiederholen. Ein eigener Scope waere ein zweiter Schluessel fuer dieselbe
// Frage „wie sieht dieses Board fuer mich aus".
const IDEEN_BOARD_FILTER_SCOPES = [
  {
    scope: 'ideenBoard',
    defaults: { filterChapterId: '', showVerworfen: false, query: '', collapsedLanes: [], collapsedChapters: [] },
  },
];

export function registerIdeenBoardCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ideenBoardCard', () => ({
    ideen: [],
    laneOrder: [],

    // Filterleiste + Klappung (Besitz: IDEEN_BOARD_FILTER_SCOPES).
    filterChapterId: '',
    showVerworfen: false,
    query: '',
    // Bahn-Keys. Immer als NEUE Liste schreiben (toggleLaneFold/toggleChapterFold
    // in ideen-board/actions.js) — die Defaults oben sind ein geteiltes Objekt,
    // und der Board-Memo vergleicht seine Deps per Identitaet.
    collapsedLanes: [],
    collapsedChapters: [],

    newContent: '',
    newLaneKey: '',
    editingId: null,
    editingDraft: '',

    // Verknuepfungs-Picker (ideen-links.js).
    linkTargets: {},
    _linkTargetsBookId: null,
    linkPickerIdeeId: null,
    linkPickerKind: 'research',
    linkPickerTargetId: '',
    // Popover-Geometrie des Pickers (nach <body> teleportiert, am Trigger
    // verankert — public/js/popover-anchor.js).
    linkPickerPos: { top: 0, left: 0 },
    _linkTriggerRect: null,
    _linkPickerCloseHandler: null,

    loading: false,
    busy: false,
    errorMessage: '',

    // SortableJS-Instanzen der Status-Zellen (eine je Bahn × Spalte).
    _boardSortables: [],
    // Speicher des EINEN Memo-Helfers der Karte (_memo in ideen-board/actions.js).
    _memos: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'ideenBoard',
        showFlag: 'showIdeenBoardCard',
        filterScopes: IDEEN_BOARD_FILTER_SCOPES,
        resetState: { editingId: null, linkPickerIdeeId: null, busy: false },
        load: async () => { await this.loadBoard(); },
        onBookChanged: () => this.resetBoard(),
        onViewReset: () => this.resetBoard(),
      });

      // Der Baum traegt die Bahnen-REIHENFOLGE (SSoT book_order). Er wird
      // asynchron geladen und kann sich unter dem offenen Board aendern (neue
      // Seite, Umsortieren, Collab-Nachzug) — ohne diesen Watcher stuenden die
      // betroffenen Ideen in der Sammelbahn, bis jemand die Karte neu oeffnet.
      this.$watch(() => this.$store.nav.tree, (tree) => {
        if (!window.__app?.showIdeenBoardCard) return;
        this.laneOrder = buildLaneOrder(tree);
        this._memos = {};
      });

      // Bahnen kommen und gehen mit dem Filter; die Drop-Zonen haengen an den
      // gerenderten Zellen und muessen darum neu angebunden werden, sobald eine
      // Bahn dazukommt oder verschwindet (anders als im Recherche-Board mit
      // seinen vier festen Spalten).
      //
      // Beobachtet wird die BAHNEN-SIGNATUR, nicht die Filterfelder: `x-for` mit
      // `:key` behaelt die Zellen einer bleibenden Bahn als dieselben DOM-Knoten,
      // ihre Sortable-Instanzen sind also weiter gueltig. An `query` gehaengt
      // wuerde dagegen jeder Tastendruck alle Instanzen wegwerfen und neu bauen.
      this.$watch(
        () => this.lanes().map(l => l.lane.key).join('|'),
        () => this._ensureBoardSortables(),
      );
    },

    destroy() {
      this._lifecycle?.destroy();
      this._destroyBoardSortables();
      this._detachLinkPickerListeners?.();
    },

    ...ideenBoardMethods,
  }));
}
