// Plot-Werkstatt: Drag-&-Drop via SortableJS (statt nativem HTML5-DnD).
// Spiegelt das Buchorganizer-Muster ([public/js/book-organizer/dnd.js]):
// SortableJS bindet pro Beat-Zelle (Akt × Strang) einen Container, alle teilen die
// `plot-beats`-Gruppe → Beats wandern per Drag zwischen Zellen. Vor jeder Modell-
// Mutation wird SortableJS' physischer DOM-Move zurückgenommen (_revertSortable),
// damit Alpine x-for alleiniger DOM-Besitzer bleibt; die geprüfte _dropBeat-Logik
// (beats.js) mutiert dann das Modell und x-for rendert neu. Der Ghost-Slot zeigt
// dem User vor dem Loslassen exakt, wo die Karte landet.

// SortableJS v1.15.6-Patch: `_onDragOver` kann auf einer destroyten Instanz
// (this.el === null) feuern, wenn Alpine x-for nach einem Drop neu reconciliated.
// No-op auf null el statt zu crashen (identisch zum Organizer-Patch).
function _patchSortableOnce(Sortable) {
  if (Sortable.prototype._dragOverGuarded) return;
  const orig = Sortable.prototype._onDragOver;
  Sortable.prototype._onDragOver = function (evt) {
    if (!this.el) return;
    return orig.call(this, evt);
  };
  Sortable.prototype._dragOverGuarded = true;
}

export const dndMethods = {
  _destroySortables() {
    for (const s of (this._sortables || [])) { try { s.destroy(); } catch {} }
    this._sortables = [];
  },

  // Reattach coalescen: strukturelle Änderungen (Akt-/Strang-CRUD, Fork, loadBoard)
  // feuern oft mehrfach pro Frame über $watch. Ein nextTick-Durchlauf reicht.
  _scheduleReattach() {
    if (this._reattachQueued) return;
    this._reattachQueued = true;
    this.$nextTick(() => { this._reattachQueued = false; this._reattachSortables(); });
  },

  // Sortable-Instanzen frisch ans aktuelle DOM binden. gridRows()/acts/threads
  // ändern die Zell-Container (x-for erzeugt neue Elemente) — alte Refs zeigen
  // sonst auf stale Nodes und folgende Drops verschieben Beats in unsichtbaren
  // alten Zellen.
  async _reattachSortables() {
    this._destroySortables();
    await this.$nextTick();
    this._initSortables();
  },

  _initSortables() {
    const Sortable = window.Sortable;
    if (!Sortable) return;
    _patchSortableOnce(Sortable);
    this._destroySortables();
    // x-ignore auf das Drag-Item, damit der via cloneNode(true) erzeugte
    // Fallback-Ghost im <body> von Alpines MutationObserver übersprungen wird —
    // sonst evaluiert Alpine `beat.*` ausserhalb des x-for-Scopes und wirft
    // "beat is not defined". Nach Drag wieder entfernen.
    const markIgnore = (evt) => evt.item?.setAttribute('x-ignore', '');
    const unmarkIgnore = (evt) => evt.item?.removeAttribute('x-ignore');
    // Tuning analog Organizer (forceFallback-Ghost, swapThreshold gegen
    // Nachbar-Flackern, invertSwap für stabile Backward-Drops, revertOnSpill
    // gegen Item-Loss bei Drop ausserhalb). filter hält Drag von interaktiven
    // Karten-Elementen (Status-Badge, Tags, Edit-Form) fern; preventOnFilter
    // false lässt deren Klick durch (Status zyklen, Beat öffnen, Figur springen).
    const baseOpts = {
      animation: 150,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 5,
      swapThreshold: 0.65,
      invertSwap: true,
      direction: 'vertical',
      revertOnSpill: true,
      emptyInsertThreshold: 10,
      scroll: true,
      draggable: '.plot-beat',
      filter: '.plot-beat--editing, .plot-beat-edit, .plot-beat-meta, .plot-status-tag, .plot-beat-warn, button, input, textarea, a, .combobox-wrap',
      preventOnFilter: false,
      group: { name: 'plot-beats', pull: true, put: ['plot-beats'] },
      chosenClass: 'plot-beat-chosen',
      ghostClass: 'plot-beat-ghost',
      dragClass: 'plot-beat-drag-active',
      onChoose: markIgnore,
      onUnchoose: unmarkIgnore,
      onEnd: (evt) => { unmarkIgnore(evt); this.onBeatSortEnd(evt); },
    };
    // Eine Sortable-Instanz pro Beat-Zelle (.plot-beats[data-plot-cell]). Flaches
    // Board und Grid sind beide im DOM (x-show); die jeweils versteckten Container
    // sind geometrielos → nie Drop-Ziel, das Binden bleibt unschädlich.
    const cells = this.$root.querySelectorAll('[data-plot-cell]');
    for (const el of cells) this._sortables.push(new Sortable(el, baseOpts));
  },

  // Draggable-Space-Index eines Elements innerhalb seines Parents — zählt exakt
  // wie SortableJS' internes index() (Template-Anker übersprungen), damit Revert-
  // Refs im selben Indexraum wie evt.oldIndex liegen.
  _sortableIndexOf(el) {
    let idx = 0;
    let cur = el;
    while ((cur = cur.previousElementSibling)) {
      if (cur.tagName !== 'TEMPLATE') idx++;
    }
    return idx;
  },

  // Nimmt SortableJS' physischen DOM-Move zurück (Node zurück in Quell-Container
  // an alten Index). Pflicht vor jeder Modell-Mutation: sonst besitzen SortableJS
  // und Alpine x-for dieselben Nodes doppelt → Orphan/Duplikat-Nodes. Nach Revert
  // ist Alpine alleiniger DOM-Besitzer; das Modell (in _dropBeat mutiert) ist die
  // Wahrheit, x-for rendert daraus neu.
  _revertSortable(evt) {
    const { item, from, oldIndex } = evt;
    if (!item || !from || !Number.isFinite(oldIndex)) return;
    // Schon am richtigen Slot? (Index im SortableJS-Raum vergleichen — Alpines
    // <template x-for> ist erstes Kind und verschiebt die rohe HTMLCollection um 1.)
    if (item.parentNode === from && this._sortableIndexOf(item) === oldIndex) return;
    let ref = null;
    let idx = 0;
    for (const child of from.children) {
      if (child === item || child.tagName === 'TEMPLATE') continue;
      if (idx === oldIndex) { ref = child; break; }
      idx++;
    }
    from.insertBefore(item, ref); // ref===null → ans Ende
  },

  // ID der Beat-Karte, vor der eingefügt wird = nächste .plot-beat-Geschwisterkarte
  // am neuen Slot. null = ans Zell-Ende. VOR dem Revert lesen (danach ist der Knoten
  // zurück in der Quelle). Der Container hält ausser dem <template>-Anker nur Beats.
  _nextBeatId(item) {
    let cur = item?.nextElementSibling;
    while (cur) {
      if (cur.classList?.contains('plot-beat') && cur.dataset?.beatId) {
        return parseInt(cur.dataset.beatId, 10);
      }
      cur = cur.nextElementSibling;
    }
    return null;
  },

  // SortableJS onEnd → Brücke auf die bewährte _dropBeat-Mechanik (beats.js).
  async onBeatSortEnd(evt) {
    const item = evt.item;
    const toEl = evt.to;
    const beatId = parseInt(item?.dataset?.beatId, 10);
    if (this.busy || !Number.isFinite(beatId)) { this._revertSortable(evt); return; }
    // Echter No-op (gleiche Zelle, gleiche Position) → SortableJS hat nichts bewegt.
    if (evt.from === toEl && evt.oldIndex === evt.newIndex) return;
    const actId = parseInt(toEl?.dataset?.actId, 10);
    if (!Number.isFinite(actId)) { this._revertSortable(evt); return; }
    const rawThread = toEl?.dataset?.threadId;
    const threadId = (rawThread == null || rawThread === '') ? null : (parseInt(rawThread, 10) || null);
    const beforeBeatId = this._nextBeatId(item);
    this._revertSortable(evt);
    this._dragBeatId = beatId;
    await this._dropBeat(actId, threadId, beforeBeatId);
  },
};
