// Create/Rename/Delete-Slice. Server-Calls via contentRepo + In-Place-Mirror
// in root.tree/root.pages. History-Push pro erfolgreichem Schritt.
import { contentRepo } from '../repo/content.js';
import { _sortSoloFirst } from '../book/tree.js';
import { localIsoDate } from '../utils.js';

export const crudMethods = {
  onRenameChapter(id, ev) {
    const newName = (ev?.target?.value || '').trim();
    const found = this._findChapter(id);
    const ch = found?.node;
    if (!ch || !newName || ch.name === newName) {
      if (ch && ev?.target) ev.target.value = ch.name;
      return;
    }
    const oldName = ch.name;
    this._doRenameChapter(id, newName, ev.target).then(ok => {
      if (ok) this._recordRenameChapter(id, oldName, newName);
    });
  },

  async _doRenameChapter(id, newName, inputEl) {
    const root = window.__app;
    try {
      await contentRepo.updateChapter(id, { name: newName });
      const ch = this._findChapter(id)?.node;
      if (ch) ch.name = newName;
      // In-place mirror: chapter entry in root.tree + _chapterOrderMap (nur
      // Top-Level — Sub-Kapitel sind in root.tree noch nicht abgebildet).
      for (const it of root.tree) {
        if (it.type === 'chapter' && !it.solo && it.id === id) it.name = newName;
      }
      this._rebuildChapterOrderMap();
      return true;
    } catch (e) {
      root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
      const ch = this._findChapter(id)?.node;
      if (ch && inputEl) inputEl.value = ch.name;
      return false;
    }
  },

  onRenamePage(id, ev) {
    const newName = (ev?.target?.value || '').trim();
    const page = this._findPage(id);
    if (!page || !newName || page.name === newName) {
      if (page && ev?.target) ev.target.value = page.name;
      return;
    }
    const oldName = page.name;
    this._doRenamePage(id, newName, ev.target).then(ok => {
      if (ok) this._recordRenamePage(id, oldName, newName);
    });
  },

  async _doRenamePage(id, newName, inputEl) {
    const root = window.__app;
    try {
      await contentRepo.updatePage(id, { name: newName });
      const page = this._findPage(id);
      if (page) page.name = newName;
      // In-place mirror: page in root.pages + ggf. solo-Tree-Entry.
      const rp = root.pages.find(p => p.id === id);
      if (rp) rp.name = newName;
      for (const it of root.tree) {
        if (it.type === 'chapter' && it.solo && it.pages?.[0]?.id === id) {
          it.name = newName;
        }
      }
      // Pages-Maps neu aufbauen (Reihenfolge unverändert, aber Name-Index drin).
      this._rebuildPageOrderMaps();
      return true;
    } catch (e) {
      root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
      const page = this._findPage(id);
      if (page && inputEl) inputEl.value = page.name;
      return false;
    }
  },

  async createChapter() {
    const root = window.__app;
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptChapterName'),
      placeholder: root.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await contentRepo.createChapter({
        book_id: parseInt(root.selectedBookId, 10),
        name,
      });
      if (!created?.id) return;
      createdId = created.id;
      this._mirrorCreatedChapter(created, name);
      await this._rerender();
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreateChapter(createdId, name);
  },

  async createPage(chapterId) {
    const root = window.__app;
    const isDiary = typeof root.isTagebuch === 'function' && root.isTagebuch();
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptPageName'),
      placeholder: root.t('bookOrganizer.placeholderPageName'),
      defaultValue: isDiary ? localIsoDate() : '',
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await this._createPageRaw({ name, chapterId });
      if (!created?.id) return;
      createdId = created.id;
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreatePage(createdId, chapterId || 0, name);
  },

  // Reine Create-Operation ohne Prompt — auch von History-Redo nutzbar.
  async _createPageRaw({ name, chapterId }) {
    const root = window.__app;
    const body = {
      book_id: parseInt(root.selectedBookId, 10),
      name,
      // Server (routes/content.js) defaultet HTML auf '<p></p>' wenn leer —
      // notwendig, weil sonst ein Draft angelegt wird, der nicht in GET /pages
      // auftaucht. Explizit hier setzen schadet nicht.
      html: '<p></p>',
    };
    if (chapterId) body.chapter_id = chapterId;
    const created = await contentRepo.createPage(body);
    if (!created?.id) return null;
    this._mirrorCreatedPage(created, chapterId);
    // Kapitel aufklappen, damit die neue Seite sichtbar ist (frisch erstellte
    // Kapitel sind im Organizer per Default zu). Vor _rerender setzen:
    // _recomputeInitialOpenState behält bekannte Keys, danach bindet
    // _initSortables die jetzt sichtbare Pages-UL.
    if (chapterId) this.chapterOpen = { ...this.chapterOpen, [chapterId]: true };
    await this._rerender();
    return created;
  },

  _mirrorCreatedChapter(created, name) {
    const root = window.__app;
    const treeEntry = {
      type: 'chapter',
      id: created.id,
      name: created.name || name,
      priority: created.priority ?? Number.MAX_SAFE_INTEGER,
      open: true,
      solo: false,
      pages: [],
    };
    root.tree.push(treeEntry);
    root.tree.sort(_sortSoloFirst);
    this._rebuildChapterOrderMap();
    if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
  },

  _mirrorCreatedPage(created, chapterId) {
    const root = window.__app;
    const chapName = chapterId
      ? root.tree.find(it => it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId))?.name || null
      : null;
    const newPage = { ...created, chapterName: chapName };
    root.pages.push(newPage);
    if (chapterId) {
      const treeCh = root.tree.find(it => it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId));
      if (treeCh) {
        // Reassignment statt push: Alpine-Reaktivität greift bei nested
        // Arrays nicht immer zuverlässig, wenn das Parent-Item kürzlich
        // selbst gepusht wurde (neu erstelltes Kapitel). Property-Set
        // auf `.pages` triggert die Watcher in jedem Fall.
        treeCh.pages = [...treeCh.pages, newPage];
        treeCh.open = true;
      }
    } else {
      root.tree.push({
        type: 'chapter',
        id: 'solo-' + newPage.id,
        name: newPage.name,
        priority: newPage.priority ?? Number.MAX_SAFE_INTEGER,
        open: true,
        solo: true,
        url: null,
        pages: [newPage],
      });
      root.tree.sort(_sortSoloFirst);
    }
    root.tokEsts[newPage.id] = { tok: 0, words: 0, chars: 0 };
    this._rebuildPageOrderMaps();
    if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
  },

  async deleteChapter(id) {
    const root = window.__app;
    const found = this._findChapter(id);
    const ch = found?.node;
    if (!ch) return;
    if (ch.pages.length > 0) {
      root.setStatus(root.t('bookOrganizer.chapterNotEmpty', { name: ch.name, n: ch.pages.length }));
      return;
    }
    if ((ch.subchapters?.length || 0) > 0) {
      root.setStatus(root.t('bookOrganizer.chapterHasSubchapters', { name: ch.name }));
      return;
    }
    if (root.currentPage && root.currentPage.chapter_id === id) {
      root.setStatus(root.t('bookOrganizer.pageInEditorWarn'));
      return;
    }
    const ok = await root.appConfirm({
      message: root.t('bookOrganizer.confirmDeleteChapter', { name: ch.name }),
      confirmLabel: root.t('common.delete'),
      cancelLabel: root.t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    await this._deleteChapterRaw(id);
    this._clearHistory();
  },

  async _deleteChapterRaw(id) {
    const root = window.__app;
    const found = this._findChapter(id);
    const ch = found?.node;
    if (!ch) return false;
    return await this._runMutation(async () => {
      await contentRepo.deleteChapter(id);
      // Cascade: Kapitel + dessen Seiten landen im Papierkorb.
      const deletedPageIds = new Set(ch.pages.map(p => p.id));
      for (let i = root.pages.length - 1; i >= 0; i--) {
        if (deletedPageIds.has(root.pages[i].id)) root.pages.splice(i, 1);
      }
      for (let i = root.tree.length - 1; i >= 0; i--) {
        if (root.tree[i].type === 'chapter' && !root.tree[i].solo && root.tree[i].id === id) {
          root.tree.splice(i, 1);
        }
      }
      // Aus workTree entfernen (nested-aware).
      if (found.parentList && found.index >= 0) {
        found.parentList.splice(found.index, 1);
      }
      this._rebuildChapterOrderMap();
      this._rebuildPageOrderMaps();
      if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
      // Subchapter-Delete: Sidebar (flach) ist inkonsistent → fullReload.
      if (found.node.depth > 1) await root.loadPages?.();
      await this.$nextTick();
      this._destroySortables();
      this._initSortables();
    }, 'bookOrganizer.deleteFailed');
  },

  // Neues Sub-Kapitel unter einem bestehenden Kapitel anlegen.
  async createSubchapter(parentChapterId) {
    const root = window.__app;
    const parent = this._findChapter(parentChapterId)?.node;
    if (!parent) return;
    if (parent.depth >= 3) {
      root.setStatus(root.t('bookOrganizer.maxDepthReached'));
      return;
    }
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptChapterName'),
      placeholder: root.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await contentRepo.createChapter({
        book_id: parseInt(root.selectedBookId, 10),
        name,
        parent_chapter_id: parentChapterId,
      });
      if (!created?.id) return;
      createdId = created.id;
      this.chapterOpen = { ...this.chapterOpen, [parent.id]: true, [created.id]: true };
      // root.tree ist flach + depth-first; ein in-place-Mirror muesste die
      // Insertion-Position rekonstruieren. Stattdessen fullReload — gleicher
      // Pfad wie _deleteChapterRaw fuer Sub-Kapitel. pages:loaded triggert
      // anschliessend _rerender via Card-Listener und befuellt workTree.
      await root.loadPages?.();
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreateChapter(createdId, name);
  },

  // Promote: Kapitel ein Level hoeher (rueckt aus dem Eltern-Kapitel raus,
  // wird Geschwister des bisherigen Elternteils). Top-Level: no-op.
  async promoteChapter(id) {
    if (this.organizerSaving) return;
    const found = this._findChapter(id);
    if (!found || found.node.depth <= 1) return;
    const before = this._snapshotWorkstate();
    // Aus aktuellem parentList entfernen.
    const node = found.node;
    found.parentList.splice(found.index, 1);
    // Eltern-Suchen → in dessen parentList eintragen, direkt nach dem Elternteil.
    const parentLoc = this._findChapter(found.parent.id);
    if (!parentLoc) {
      // Theoretisch unmoeglich; sicherheitshalber zurueckschieben.
      found.parentList.splice(found.index, 0, node);
      return;
    }
    parentLoc.parentList.splice(parentLoc.index + 1, 0, node);
    // depth/parent_id aktualisieren rekursiv.
    this._reassignDepth(node, node.depth - 1, parentLoc.parent ? parentLoc.parent.id : null);
    const ok = await this._persistOrder({ fullReload: true });
    if (ok) this._recordReorder(before);
  },

  // Demote: Kapitel ein Level tiefer (wird Sub-Kapitel des Vor-Geschwisters).
  async demoteChapter(id) {
    if (this.organizerSaving) return;
    if (!this.canDemoteChapter(id)) return;
    const found = this._findChapter(id);
    if (!found) return;
    const before = this._snapshotWorkstate();
    const node = found.node;
    const newParent = found.parentList[found.index - 1];
    found.parentList.splice(found.index, 1);
    newParent.subchapters = [...(newParent.subchapters || []), node];
    this._reassignDepth(node, newParent.depth + 1, newParent.id);
    this.chapterOpen = { ...this.chapterOpen, [newParent.id]: true };
    const ok = await this._persistOrder({ fullReload: true });
    if (ok) this._recordReorder(before);
  },

  _reassignDepth(node, depth, parentId) {
    node.depth = depth;
    node.parent_id = parentId;
    for (const sub of (node.subchapters || [])) {
      this._reassignDepth(sub, depth + 1, node.id);
    }
  },

  async deletePage(id) {
    const root = window.__app;
    if (root.currentPage && root.currentPage.id === id) {
      root.setStatus(root.t('bookOrganizer.pageInEditorWarn'));
      return;
    }
    const page = this._findPage(id);
    if (!page) return;
    const ok = await root.appConfirm({
      message: root.t('bookOrganizer.confirmDeletePage', { name: page.name }),
      confirmLabel: root.t('common.delete'),
      cancelLabel: root.t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    await this._deletePageRaw(id);
    // Delete ist nicht reversibel → History invalidieren.
    this._clearHistory();
  },

  async _deletePageRaw(id) {
    const root = window.__app;
    return await this._runMutation(async () => {
      await contentRepo.deletePage(id);
      const pi = root.pages.findIndex(p => p.id === id);
      if (pi >= 0) root.pages.splice(pi, 1);
      for (let i = root.tree.length - 1; i >= 0; i--) {
        const it = root.tree[i];
        if (it.type !== 'chapter') continue;
        if (it.solo && it.pages?.[0]?.id === id) {
          root.tree.splice(i, 1);
        } else if (!it.solo) {
          const j = it.pages.findIndex(p => p.id === id);
          if (j >= 0) it.pages.splice(j, 1);
        }
      }
      // Rekursiv durch workTree.subchapters — sonst bleiben Sub-Kapitel-Pages sichtbar.
      const removeFromTree = (list) => {
        for (const c of list) {
          const j = c.pages.findIndex(p => p.id === id);
          if (j >= 0) { c.pages.splice(j, 1); return true; }
          if (removeFromTree(c.subchapters || [])) return true;
        }
        return false;
      };
      if (!removeFromTree(this.workTree)) {
        const si = this.soloPages.findIndex(p => p.id === id);
        if (si >= 0) this.soloPages.splice(si, 1);
      }
      this._rebuildPageOrderMaps();
      if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
      await this.$nextTick();
      this._destroySortables();
      this._initSortables();
    }, 'bookOrganizer.deleteFailed');
  },
};
