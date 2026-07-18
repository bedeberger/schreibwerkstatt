// Teil von notebookEditMethods (siehe Facade edit.js).
import { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS, DRAFT_DEBOUNCE_MS, clearDraft, editorHost, isNoChange, stripLektoratMarks, writeDraft } from './_shared.js';

// Timer-Handles (`_draftTimer`, `_autosaveIdleTimer`, `_autosaveMaxTimer`,
// `_onlineHandler`, `_onlineVisHandler`) leben BEWUSST am Host (Root, deklariert
// im notebookState-Slice von app-state.js), nicht an der Card: `_stopAutosave`
// wird auch aus Root-Kontext gerufen (app-view/page.js#resetPage via Trampoline)
// und muss dieselben Handles treffen. Der card-lokale `_undoTimer` (history.js)
// ist die Ausnahme, weil Undo card-only ist — daher kein Widerspruch.
export const autosaveMethods = {

  _scheduleDraftSave() {
    const app = editorHost();
    if (!app) return;
    if (app._draftTimer) clearTimeout(app._draftTimer);
    app._draftTimer = setTimeout(() => {
      app._draftTimer = null;
      this._flushDraftSaveNow();
    }, DRAFT_DEBOUNCE_MS);
  },


  // Schreibt den aktuellen Editor-Inhalt sofort als Draft – unabhängig vom
  // Debounce-Timer. Aufruf vor jedem Zustandsübergang, der den Editor-Inhalt
  // nicht mehr einfängt (Focus-Mode-Entry) oder ihn riskieren könnte zu
  // verlieren. Beim Aufruf nach Debounce-Fire ist _draftTimer bereits null
  // (ungefährlicher No-op).
  _flushDraftSaveNow() {
    const app = editorHost();
    if (!app) return;
    if (app._draftTimer) { clearTimeout(app._draftTimer); app._draftTimer = null; }
    if (!app.editMode || !app.currentPage) return;
    const el = this._getEditEl();
    if (!el) return;
    const html = stripLektoratMarks(el.innerHTML);
    if (isNoChange(html, app.originalHtml)) {
      clearDraft(app.currentPage.id);
      app.lastDraftSavedAt = null;
      app.draftPersistFailed = false;
      return;
    }
    const ok = writeDraft(app.currentPage.id, html, app.originalHtml, app.currentPage.updated_at);
    app.draftPersistFailed = !ok;
    if (ok) app.lastDraftSavedAt = Date.now();
  },


  _startAutosave() {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    if (app.editDirty) this._scheduleAutosave();
  },


  _stopAutosave() {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    if (app._draftTimer) { clearTimeout(app._draftTimer); app._draftTimer = null; }
  },


  _clearAutosaveTimers() {
    const app = editorHost();
    if (!app) return;
    if (app._autosaveIdleTimer) { clearTimeout(app._autosaveIdleTimer); app._autosaveIdleTimer = null; }
    if (app._autosaveMaxTimer) { clearTimeout(app._autosaveMaxTimer); app._autosaveMaxTimer = null; }
  },


  // Idle-Timer wird bei jedem Edit zurückgesetzt → speichert erst nach
  // AUTOSAVE_IDLE_MS Tipp-Pause. Max-Timer läuft ab erstem Dirty-Mark
  // weiter und greift bei Dauer-Tippen, sodass spätestens AUTOSAVE_MAX_MS
  // nach der ersten Änderung ein Save ausgelöst wird.
  _scheduleAutosave() {
    const app = editorHost();
    if (!app) return;
    if (app._autosaveIdleTimer) clearTimeout(app._autosaveIdleTimer);
    app._autosaveIdleTimer = setTimeout(() => this._fireAutosave(), AUTOSAVE_IDLE_MS);
    if (!app._autosaveMaxTimer) {
      app._autosaveMaxTimer = setTimeout(() => this._fireAutosave(), AUTOSAVE_MAX_MS);
    }
  },


  _fireAutosave() {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    if (app.editMode && app.editDirty && !app.editSaving) this.quickSave();
  },


  _installOnlineRetry() {
    const app = editorHost();
    if (!app || app._onlineHandler) return;
    // Retry-Trigger fuer einen haengengebliebenen Offline-Save. Das `online`-Event
    // allein genuegt nicht: es feuert nur bei einem echten Offline→Online-Wechsel,
    // nicht bei einem transienten Server-Blip oder einem faelschlichen
    // navigator.onLine-`false`. Tab-Refokus (visibilitychange/focus) ist der
    // zuverlaessige zweite Anlass, den Netzwerkversuch erneut zu wagen.
    const retry = () => {
      if (app.editMode && app.editDirty && app.saveOffline && !app.editSaving) {
        this.quickSave();
      }
    };
    app._onlineHandler = retry;
    app._onlineVisHandler = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('online', app._onlineHandler);
    window.addEventListener('focus', app._onlineHandler);
    document.addEventListener('visibilitychange', app._onlineVisHandler);
  },


  _uninstallOnlineRetry() {
    const app = editorHost();
    if (!app || !app._onlineHandler) return;
    window.removeEventListener('online', app._onlineHandler);
    window.removeEventListener('focus', app._onlineHandler);
    if (app._onlineVisHandler) {
      document.removeEventListener('visibilitychange', app._onlineVisHandler);
      app._onlineVisHandler = null;
    }
    app._onlineHandler = null;
  },
};
