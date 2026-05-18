// Persist-Slice: Snapshot-Rebuild, _runMutation, _persistOrder, Workstate-Clone.
import { contentRepo } from '../repo/content.js';

export const persistMethods = {
  async _rerender() {
    this._destroySortables();
    this._snapshotFromRoot();
    await this.$nextTick();
    this._initSortables();
  },

  _snapshotFromRoot() {
    const root = window.__app;
    const tree = root.tree || [];
    this.workTree = tree
      .filter(it => it.type === 'chapter' && !it.solo)
      .map(c => ({
        id: c.id,
        name: c.name,
        pages: (c.pages || []).map(p => ({ id: p.id, name: p.name, chapter_id: p.chapter_id })),
      }));
    this.soloPages = tree
      .filter(it => it.type === 'chapter' && it.solo)
      .map(it => it.pages[0])
      .filter(Boolean)
      .map(p => ({ id: p.id, name: p.name, chapter_id: 0 }));
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
  // Server validiert + materialisiert chapters.position/pages.position/
  // pages.chapter_id in einer Transaction.
  _buildTreeFromWorkstate() {
    // Seiten ohne Kapitel zuerst (UI-Invariante), dann Kapitel in workTree-Order.
    const tree = [];
    for (const p of this.soloPages) {
      tree.push({ type: 'page', id: p.id });
    }
    for (const c of this.workTree) {
      tree.push({
        type: 'chapter',
        id: c.id,
        children: c.pages.map(p => ({ type: 'page', id: p.id })),
      });
    }
    return tree;
  },

  async _persistOrder({ affectedChapters = null } = {}) {
    const root = window.__app;
    const bookId = parseInt(root.selectedBookId, 10);
    if (!bookId) return false;
    const tree = this._buildTreeFromWorkstate();
    return await this._runMutation(async () => {
      this.organizerProgress = 0;
      this.organizerStatus = root.t('bookOrganizer.savingOrder');
      await contentRepo.saveOrder(bookId, tree);
      this.organizerProgress = 100;
      // Affected chapters: nur Kapitel-Reorder → null; Page-Move → Liste.
      if (affectedChapters) this._mirrorPageMembershipInRoot(affectedChapters);
      else this._mirrorChapterOrderInRoot();
    });
  },
};
