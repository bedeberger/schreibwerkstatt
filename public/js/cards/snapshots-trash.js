// Papierkorb der Fassungen-Karte: geloeschte Seiten des Buchs wiederherstellen.
// In snapshotsCard gespreadet (LOC-Split, analog snapshots-drift.js). Kein
// Getter (Spread-Getter-Falle) — nur Methoden; der State (trash/trashRestoringId)
// lebt im Karten-Initializer.
//
// Gesichert wird beim Loeschen serverseitig (page_deletions); die
// Wiederherstellung legt die Seite mit neuer page_id an, darum danach Tree neu.

import { contentRepo } from '../repo/content.js';

export const snapshotsTrashMethods = {
  // Best-effort: ohne Editor-Recht (403) oder bei Fehler bleibt die Sektion leer.
  async loadTrash(bookId) {
    if (!bookId) { this.trash = []; return; }
    try {
      const data = await contentRepo.listTrash(bookId);
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      this.trash = Array.isArray(data?.items) ? data.items : [];
    } catch (e) {
      if (e?.status !== 403) console.error('[snapshots:trash]', e);
      this.trash = [];
    }
  },

  async restoreTrashItem(item) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!item?.id || !bookId || this.trashRestoringId) return;
    this.trashRestoringId = item.id;
    try {
      await contentRepo.restoreFromTrash(bookId, item.id);
      await app.loadPages?.();
      app.setStatus?.(app.t('snapshots.trash.restored', { name: item.name || app.t('snapshots.untitled') }), false, 4000);
    } catch (e) {
      console.error('[snapshots:trash:restore]', e);
      if (e?.code === 'ALREADY_RESTORED') app.setStatus?.(app.t('snapshots.trash.alreadyRestored'), true, 5000);
      else app.setStatus?.(app.t('snapshots.trash.restoreFailed') + ' ' + (e?.code || e?.message || ''), true, 6000);
    } finally {
      this.trashRestoringId = null;
      await this.loadTrash(bookId);
    }
  },
};
