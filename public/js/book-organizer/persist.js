// Persist-Slice: Snapshot-Rebuild, _runMutation, _persistOrder, Workstate-Clone.
import { contentRepo } from '../repo/content.js';

export const persistMethods = {
  async _rerender() {
    this._destroySortables();
    await this._snapshotFromServer();
    await this.$nextTick();
    this._initSortables();
    this._refreshSortableDisabled();
  },

  // Holt frischen nested bookTree vom Server und baut workTree (rekursiv mit
  // subchapters). root.tree ist flach (Phase 3b haengt nested an); deshalb
  // fetcht der Organizer eigenstaendig — sonst saehe er keine Sub-Kapitel.
  async _snapshotFromServer() {
    const root = window.__app;
    const bookId = parseInt(root.selectedBookId, 10);
    if (!bookId) {
      this.workTree = [];
      this.soloPages = [];
      this._recomputeInitialOpenState();
      return;
    }
    try {
      const tree = await contentRepo.bookTree(bookId, { fresh: true });
      this._snapshotFromTree(tree);
    } catch (e) {
      console.error('[bookOrganizer] bookTree fetch failed', e);
      this.workTree = [];
      this.soloPages = [];
      this._recomputeInitialOpenState();
    }
  },

  _snapshotFromTree(tree) {
    const cloneChapter = (c, depth, parentId) => ({
      id: c.id,
      name: c.name,
      depth,
      parent_id: parentId,
      pages: (c.pages || []).map(p => ({ id: p.id, name: p.name, chapter_id: c.id })),
      subchapters: (c.subchapters || []).map(s => cloneChapter(s, depth + 1, c.id)),
    });
    this.workTree = (tree?.chapters || []).map(c => cloneChapter(c, 1, null));
    this.soloPages = (tree?.topPages || []).map(p => ({ id: p.id, name: p.name, chapter_id: 0 }));
    this._recomputeInitialOpenState();
  },

  // Deep-Clone von workTree+soloPages für History-Records. JSON-Roundtrip
  // entpackt Alpine-Proxys zum Plain-Object — structuredClone wirft auf
  // Proxies, daher JSON.
  _snapshotWorkstate() {
    return {
      workTree: JSON.parse(JSON.stringify(this.workTree)),
      soloPages: JSON.parse(JSON.stringify(this.soloPages)),
    };
  },

  async _runMutation(fn, errKey = 'bookOrganizer.saveFailed') {
    const root = window.__app;
    this.organizerSaving = true;
    let ok = false;
    try {
      await fn();
      ok = true;
    } catch (e) {
      root.setStatus(root.t(errKey, { detail: e.message }));
      // Bei Fehler einmal voll resynchronisieren — Server-Zustand könnte
      // partiell mutiert sein.
      await root.loadPages();
    } finally {
      this.organizerSaving = false;
      this.organizerProgress = 0;
      this.organizerStatus = '';
    }
    return ok;
  },

  // Single-Tree-PUT. Statt per-Item update fuer alle veraenderten Items wird
  // der vollstaendige Tree atomar an /content/books/:id/order geschickt.
  // Server validiert + materialisiert chapters.position/parent_chapter_id/
  // pages.position/pages.chapter_id in einer Transaction.
  _buildTreeFromWorkstate() {
    function buildChapter(c) {
      const children = [];
      for (const sub of (c.subchapters || [])) children.push(buildChapter(sub));
      for (const p of (c.pages || [])) children.push({ type: 'page', id: p.id });
      return { type: 'chapter', id: c.id, children };
    }
    // Seiten ohne Kapitel zuerst (UI-Invariante), dann Kapitel in workTree-Order.
    const tree = [];
    for (const p of this.soloPages) tree.push({ type: 'page', id: p.id });
    for (const c of this.workTree) tree.push(buildChapter(c));
    return tree;
  },

  // Phase-3-Vereinfachung: subchapter-Mutationen koennen root.tree (flach) nicht
  // konsistent in-place mirrorn — wir reloaden stattdessen root komplett. Fuer
  // reine Top-Level-Reorder oder Page-Bucket-Moves bleibt der granulare Mirror,
  // damit Sidebar nicht flackert.
  async _persistOrder({ affectedChapters = null, fullReload = false } = {}) {
    const root = window.__app;
    const bookId = parseInt(root.selectedBookId, 10);
    if (!bookId) return false;
    const tree = this._buildTreeFromWorkstate();
    return await this._runMutation(async () => {
      this.organizerProgress = 0;
      this.organizerStatus = root.t('bookOrganizer.savingOrder');
      await contentRepo.saveOrder(bookId, tree);
      this.organizerProgress = 100;
      if (fullReload) {
        // Subchapter-Move/Indent/Outdent: kompletter Reload (Sidebar flach, OK).
        await root.loadPages?.();
      } else if (affectedChapters) {
        this._mirrorPageMembershipInRoot(affectedChapters);
      } else {
        this._mirrorChapterOrderInRoot();
      }
    });
  },
};
