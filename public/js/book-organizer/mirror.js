// In-Place-Mirror-Helpers: spiegeln Mutationen aus workTree/soloPages in
// Alpine.store('nav').tree + Alpine.store('nav').pages, ohne loadPages() (sonst Re-Render der ganzen App).
import { _sortSoloFirst } from '../book/tree.js';

export const mirrorMethods = {
  _mirrorChapterOrderInRoot() {
    const root = window.__app;
    const newPrio = new Map(this.workTree.map((c, i) => [c.id, i + 1]));
    for (const it of Alpine.store('nav').tree) {
      if (it.type === 'chapter' && !it.solo) {
        const p = newPrio.get(it.id);
        if (p !== undefined) it.priority = p;
      }
    }
    Alpine.store('nav').tree.sort(_sortSoloFirst);
    this._rebuildChapterOrderMap();
    this._resortRootPages();
    this._rebuildPageOrderMaps();
    if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
  },

  _mirrorPageMembershipInRoot(affectedChapterIds) {
    const root = window.__app;
    // Für jede betroffene Page in workTree/soloPages: chapter_id + priority + name auf Alpine.store('nav').pages spiegeln.
    const updates = new Map();
    for (const c of this.workTree) {
      for (let i = 0; i < c.pages.length; i++) {
        updates.set(c.pages[i].id, { chapter_id: c.id, priority: i + 1, name: c.pages[i].name });
      }
    }
    for (let i = 0; i < this.soloPages.length; i++) {
      updates.set(this.soloPages[i].id, { chapter_id: 0, priority: i + 1, name: this.soloPages[i].name });
    }
    for (const p of Alpine.store('nav').pages) {
      const u = updates.get(p.id);
      if (!u) continue;
      p.chapter_id = u.chapter_id || 0;
      p.priority = u.priority;
      p.name = u.name;
      if (u.chapter_id) {
        const treeCh = Alpine.store('nav').tree.find(it => it.type === 'chapter' && !it.solo && it.id === u.chapter_id);
        p.chapterName = treeCh?.name || p.chapterName;
      } else {
        p.chapterName = null;
      }
    }
    // Betroffene Kapitel: pages-Array im Tree-Eintrag aus Alpine.store('nav').pages neu filtern.
    for (const chapId of new Set(affectedChapterIds)) {
      if (chapId === 0) continue;
      const treeCh = Alpine.store('nav').tree.find(it => it.type === 'chapter' && !it.solo && it.id === chapId);
      if (!treeCh) continue;
      treeCh.pages = Alpine.store('nav').pages
        .filter(p => p.chapter_id === chapId)
        .sort((a, b) => (a.priority || 0) - (b.priority || 0));
    }
    // Solo-Entries: rebuild (Pages, die jetzt root-level sind bzw. waren).
    this._rebuildSoloEntries();
    this._resortRootPages();
    this._rebuildPageOrderMaps();
    if (typeof root._refreshChapterStats === 'function') root._refreshChapterStats();
  },

  _rebuildSoloEntries() {
    const root = window.__app;
    // Existing solo entries entfernen.
    for (let i = Alpine.store('nav').tree.length - 1; i >= 0; i--) {
      if (Alpine.store('nav').tree[i].type === 'chapter' && Alpine.store('nav').tree[i].solo) Alpine.store('nav').tree.splice(i, 1);
    }
    // Frisch nach soloPages-Reihenfolge anlegen.
    for (const sp of this.soloPages) {
      const rp = Alpine.store('nav').pages.find(p => p.id === sp.id);
      if (!rp) continue;
      Alpine.store('nav').tree.push({
        type: 'chapter',
        id: 'solo-' + sp.id,
        name: sp.name,
        priority: rp.priority || 9999,
        open: true,
        solo: true,
        url: null,
        pages: [rp],
      });
    }
    Alpine.store('nav').tree.sort(_sortSoloFirst);
  },

  _resortRootPages() {
    const root = window.__app;
    const chapterPrio = new Map();
    for (const it of Alpine.store('nav').tree) {
      if (it.type === 'chapter' && !it.solo) chapterPrio.set(it.id, it.priority || 0);
    }
    Alpine.store('nav').pages.sort((a, b) => {
      const aO = a.chapter_id ? (chapterPrio.get(a.chapter_id) ?? 999) : -1;
      const bO = b.chapter_id ? (chapterPrio.get(b.chapter_id) ?? 999) : -1;
      if (aO !== bO) return aO - bO;
      return (a.priority || 0) - (b.priority || 0);
    });
  },

  _rebuildChapterOrderMap() {
    const root = window.__app;
    const map = new Map();
    let idx = 0;
    for (const it of Alpine.store('nav').tree) {
      if (it.type === 'chapter' && !it.solo) map.set(it.name, idx++);
    }
    root._chapterOrderMap = map;
  },

  _rebuildPageOrderMaps() {
    const root = window.__app;
    const nameMap = new Map();
    const idMap = new Map();
    for (let i = 0; i < Alpine.store('nav').pages.length; i++) {
      const p = Alpine.store('nav').pages[i];
      if (!nameMap.has(p.name)) nameMap.set(p.name, i);
      idMap.set(p.id, i);
    }
    root._pageOrderMap = nameMap;
    root._pageIdOrderMap = idMap;
  },

  // Setzt die nav.pages-Array-Identität neu (gleiche Elemente, neuer Container).
  // Der Diary-Kalender-Cache invalidiert identity-gated (cache.pagesRef ===
  // nav.pages) und keyt auf den YYYY-MM-DD-Page-Namen — nach Create/Delete/Rename
  // einer Page muss er rebuilden. Nicht bei reinem Reorder/Move nötig (Namen
  // unverändert), darum kein Aufruf aus den Mirror-Pfaden.
  _invalidateDiaryCache() {
    Alpine.store('nav').pages = [...Alpine.store('nav').pages];
  },
};
