import { EVT } from '../events.js';
import { contentRepo } from '../repo/content.js';
// Pagetree-Rechtsklick-Menü. Aktionen pro Node-Typ:
//   page    → Öffnen, Editieren (Notebook), Teilen, Exportieren
//   chapter → Öffnen (Header-Activate = Toggle + ggf. Kapitel-Review), Teilen, Exportieren
//
// State lebt im Root (`pageTreeMenuOpen`/`Pos`/`Target`, deklariert in
// app-state.js#navigationState). Render-HTML in public/partials/sidebar.html.
// Methoden hier werden über `treeContextMenuMethods` in den Root gespreadet —
// `this` ist die Alpine-Root-Komponente.

const MENU_W = 240;
const MENU_H = 260;

export const treeContextMenuMethods = {
  _openPagetreeContextMenu(ev, target) {
    if (!target || !target.kind || target.id == null) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.pageTreeMenuTarget = target;
    this.pageTreeMenuPos = this._clampPagetreeMenuPos(ev.clientX, ev.clientY);
    this.pageTreeMenuOpen = true;
    if (!this._pageTreeMenuOutsideHandler) {
      this._pageTreeMenuOutsideHandler = (e) => {
        const menu = document.querySelector('.pagetree-context-menu');
        if (menu && !menu.contains(e.target)) this._hidePagetreeContextMenu();
      };
      document.addEventListener('mousedown', this._pageTreeMenuOutsideHandler, true);
    }
    if (!this._pageTreeMenuEscHandler) {
      this._pageTreeMenuEscHandler = (e) => {
        if (e.key === 'Escape') this._hidePagetreeContextMenu();
      };
      document.addEventListener('keydown', this._pageTreeMenuEscHandler);
    }
  },

  _clampPagetreeMenuPos(x, y) {
    return {
      left: Math.min(window.innerWidth - MENU_W - 8, x),
      top: Math.min(window.innerHeight - MENU_H - 8, y),
    };
  },

  _hidePagetreeContextMenu() {
    this.pageTreeMenuOpen = false;
    this.pageTreeMenuTarget = null;
    if (this._pageTreeMenuOutsideHandler) {
      document.removeEventListener('mousedown', this._pageTreeMenuOutsideHandler, true);
      this._pageTreeMenuOutsideHandler = null;
    }
    if (this._pageTreeMenuEscHandler) {
      document.removeEventListener('keydown', this._pageTreeMenuEscHandler);
      this._pageTreeMenuEscHandler = null;
    }
  },

  // Sucht Chapter-Item rekursiv im Tree. `_onChapterHeaderActivate` braucht die
  // Item-Referenz (open-Flag, Pages, hasChildren), nicht nur die ID.
  _findTreeChapter(id, items = this.$store.nav.tree) {
    if (!items) return null;
    for (const it of items) {
      if (it.type === 'chapter' && String(it.id) === String(id)) return it;
      if (it.subchapters?.length) {
        const sub = this._findTreeChapter(id, it.subchapters);
        if (sub) return sub;
      }
    }
    return null;
  },

  _findTreePage(id) {
    return (this.$store.nav.pages || []).find(p => String(p.id) === String(id)) || null;
  },

  pagetreeCtxOpen() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target) return;
    if (target.kind === 'page') {
      const page = this._findTreePage(target.id);
      if (page) this.selectPage(page);
    } else {
      const item = this._findTreeChapter(target.id);
      if (item) this._onChapterHeaderActivate(item);
    }
  },

  async pagetreeCtxEdit() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || target.kind !== 'page') return;
    const page = this._findTreePage(target.id);
    if (!page) return;
    await this.selectPage(page);
    // selectPage öffnet die Editor-Karte im View-Mode; Notebook-Edit-Trampoline
    // setzt editMode=true und installiert Autosave.
    this.startEdit?.();
  },

  async pagetreeCtxLektorieren() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || target.kind !== 'page') return;
    const page = this._findTreePage(target.id);
    if (!page) return;
    await this.selectPage(page);
    this.runCheck?.();
  },

  pagetreeCtxShare() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target) return;
    if (target.kind === 'page') this.openShareLinksForPage(target.id);
    else this.openShareLinksForChapter(target.id);
  },

  // Kapitel aus Export/Bewertung/Komplettanalyse aus- bzw. wieder einschliessen.
  // Lektorat + Fassungen bleiben unberuehrt. In-Place-Mirror auf nav.tree (flach,
  // inkl. Sub-Kapitel) fuer sofortiges Greying. Geteilt zwischen Sidebar-Kontext-
  // menue und Kapitelbewertungs-Meatball.
  async setChapterExcluded(chapterId, next) {
    if (chapterId == null) return;
    try {
      await contentRepo.updateChapter(chapterId, { excluded: !!next });
      for (const it of (this.$store.nav.tree || [])) {
        if (it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId)) it.excluded = !!next;
      }
    } catch (e) {
      this.setStatus?.(this.t('bookOrganizer.saveFailed', { detail: e.message }));
    }
  },

  pagetreeCtxToggleExclude() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || target.kind !== 'chapter') return;
    this.setChapterExcluded(target.id, !target.excluded);
  },

  async pagetreeCtxExport() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (target?.kind === 'page' || target?.kind === 'chapter') {
      await this.openExportFor(target.kind, target.id);
    } else {
      await this.openExportFor();
    }
  },

  // Export-Karte öffnen, optional mit Seiten-/Kapitel-Preset. Geteilt zwischen
  // Sidebar-Kontextmenue und den Meatball-Menues (Notebook-Seitenaktionen +
  // Kapitelbewertung).
  async openExportFor(kind, id) {
    const preset = (kind === 'page' || kind === 'chapter') && id != null
      ? { kind, id }
      : null;
    if (preset) {
      this.__exportPreset = preset;
      window.dispatchEvent(new CustomEvent(EVT.EXPORT_PRESET, { detail: preset }));
    }
    if (!this.showExportCard) await this.toggleExportCard();
    else this._scrollToCardByKey('export');
  },
};
