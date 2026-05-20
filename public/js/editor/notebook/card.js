// Notebook-Card-Methoden (Normal-Editor Sub-Komponente).
//
// Pendant zu editor/focus/card.js für den Fokusmodus. Hostet bisher die
// Reload-Wiederaufnahme aus dem `normal.snapshot`-Session-Storage (Pendant zu
// _tryRestoreFocus). Wachstumsfläche für weitere Notebook-spezifische
// Lifecycle-Schritte (Lock, Listener-Cleanup, _notebookGen-Counter), wenn
// startEdit/saveEdit/cancelEdit von der Root in die Sub wandern.

import { readNormalSnapshot, clearNormalSnapshot } from './storage.js';
import { readDraft } from '../draft-storage.js';

// Restore nur, wenn für die Seite ein lokaler Draft (ungespeicherter Inhalt)
// existiert. Ohne Draft hat der User keinen nennenswerten Edit-State —
// Snapshot-Reste aus exitFocusMode/_closeOtherMainCards würden den User sonst
// ungewollt aus „viewing" zurück in den Edit-Modus zwingen.
function hasUnsavedDraft(pageId, currentHtml) {
  const draft = readDraft(pageId);
  if (!draft || !draft.html) return false;
  return draft.html !== currentHtml;
}

export const notebookCardMethods = {
  // Reload-Wiederaufnahme: liest den `normal.snapshot` aus sessionStorage und
  // ruft `startEdit()` an der Root, sobald `currentPage`/`renderedPageHtml`/
  // `showEditorCard` für die richtige Seite stehen. Snapshot wird einmalig
  // konsumiert (auch bei späterem Misserfolg kein Retry, sonst Loop bei
  // kaputter Seite).
  _setupNotebookRestore() {
    const snap = readNormalSnapshot();
    if (!snap) return;
    this._notebookRestoreSnapshot = snap;
    const tryRestore = () => this._tryRestoreNotebook();
    this.$watch(() => window.__app?.currentPage?.id, tryRestore);
    this.$watch(() => window.__app?.renderedPageHtml, tryRestore);
    this.$watch(() => window.__app?.showEditorCard, tryRestore);
    queueMicrotask(tryRestore);
  },

  _tryRestoreNotebook() {
    const snap = this._notebookRestoreSnapshot;
    if (!snap) return;
    const app = window.__app;
    if (!app) return;
    if (app.editMode || app.focusActive) return;
    if (!app.showEditorCard) return;
    if (!app.currentPage || app.currentPage.id !== snap.pageId) return;
    if (!app.renderedPageHtml) return;
    this._notebookRestoreSnapshot = null;
    clearNormalSnapshot();
    if (!hasUnsavedDraft(snap.pageId, app.renderedPageHtml)) return;
    app.startEdit?.();
  },
};
