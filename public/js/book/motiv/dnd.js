// Motiv-Werkstatt — Reihenfolge der Themen-Liste per Drag (SortableJS, lazy).
// Ein einzelner Container (die Themen-Liste im Seitenpanel, ohne Motiv-Auswahl),
// kein Cross-Container-Move. Wie Buchorganizer/Plot: SortableJS bewegt physisch,
// wir nehmen den Move via revertSortable zurück und mutieren dann das Modell
// (this.themes + position), x-for rendert daraus neu → PUT /motifs/themes/order.

import { fetchJson } from '../../utils.js';
import { loadSortable } from '../../lazy-libs.js';
import { patchSortableOnce, revertSortable, markDragIgnore, unmarkDragIgnore, BASE_SORTABLE_OPTS } from '../../sortable-dnd.js';

export const dndMethods = {
  // Aus x-init der Themen-Liste (`_initThemeSortable($el)`). Lazy-lädt SortableJS,
  // bindet genau eine Instanz an den Listen-Container. Re-Init (Panel remountet)
  // zerstört die alte Instanz zuerst.
  async _initThemeSortable(el) {
    if (!el) return;
    this._destroyThemeSortable();
    let Sortable;
    try { Sortable = await loadSortable(); }
    catch (e) { return; /* ohne Lib kein Drag — Liste bleibt statisch */ }
    if (!Sortable) return;
    patchSortableOnce(Sortable);
    // Element evtl. schon wieder unmounted (Panel-Wechsel während des Ladens)?
    if (!el.isConnected) return;
    this._themeSortable = new Sortable(el, {
      ...BASE_SORTABLE_OPTS,
      draggable: '.motiv-theme-row',
      handle: '.motiv-drag-grip',
      ghostClass: 'motiv-theme-row--ghost',
      onChoose: markDragIgnore,
      onUnchoose: unmarkDragIgnore,
      onEnd: (evt) => { unmarkDragIgnore(evt); this.onThemeSortEnd(evt); },
    });
  },

  _destroyThemeSortable() {
    if (this._themeSortable) { try { this._themeSortable.destroy(); } catch {} this._themeSortable = null; }
  },

  // SortableJS onEnd → neue Reihenfolge aus dem DOM lesen, physischen Move
  // zurücknehmen, dann Modell + Server angleichen (Positions = Index).
  async onThemeSortEnd(evt) {
    if (evt.oldIndex === evt.newIndex) return;
    const ids = [];
    for (const child of evt.to.children) {
      if (child.tagName === 'TEMPLATE') continue;
      const id = parseInt(child.dataset?.themeId, 10);
      if (Number.isFinite(id)) ids.push(id);
    }
    revertSortable(evt);
    if (ids.length !== this.themes.length) return; // DOM/Modell divergiert — nicht raten
    const byId = new Map(this.themes.map(t => [t.id, t]));
    const reordered = ids.map(id => byId.get(id)).filter(Boolean);
    if (reordered.length !== this.themes.length) return;
    reordered.forEach((t, i) => { t.position = i; });
    this.themes = reordered;
    this._memos = {};
    try {
      await fetchJson('/motifs/themes/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: this.$store.nav.selectedBookId, order: ids }),
      });
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
};
