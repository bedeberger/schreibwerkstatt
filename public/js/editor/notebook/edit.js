import { htmlToText, tzOpts } from '../../utils.js';
import { handleEditorPaste, handleEditorCopy, handleEditorCut } from '../shared/paste.js';
import { sortByPosition } from '../../book/page-view.js';
import { contentRepo } from '../../repo/content.js';
import { readDraft, writeDraft, clearDraft } from '../draft-storage.js';
import {
  stripLektoratMarks,
  normalizeEditorBlocks,
} from '../shared/html-clean.js';
import { isNoChange } from '../shared/save-pipeline.js';
import { savePage, isPageConflict, readConflictBody } from '../shared/page-api.js';
import { getActiveEditorContainer } from '../shared/active-editor.js';
import { installEditCounter } from '../shared/edit-counter.js';
import { writeNormalSnapshot, clearNormalSnapshot, readEditorPrefs, writeEditorPrefs } from './storage.js';
import { runQuoteNormalize } from '../shared/quote-normalize.js';

// Auto-Save nach BookStack: idle-debounce + max-Cap. Jede Schreibaktion
// resettet den Idle-Timer; läuft der User durchgehend, greift der Max-Timer.
// Reduziert Revision-Spam (vorher fester 30-s-Tick → ~120 Revisions/h Tippen).
const AUTOSAVE_IDLE_MS = 60000;
const AUTOSAVE_MAX_MS = 120000;
const DRAFT_DEBOUNCE_MS = 500;
// stripLektoratMarks / normalizeForCompare / normalizeEditorBlocks /
// ROOT_BLOCK_TAGS leben in public/js/editor/shared/html-clean.js — dieselbe
// Lib wird auch vom Focus-Editor konsumiert.


// Sub-Methoden der Card `editorNotebookCard`. Alle State-Touches gegen
// `window.__app` (Root). Aufruf von extern: über die Trampoline-Forwarder
// in [trampoline.js] am Root-Spread (`app.startEdit()` → `__notebookCard.startEdit()`).
export const notebookEditMethods = {
  // Container-Lookup: einziger Eintrittspunkt für beide Modi.
  _getEditEl() {
    return getActiveEditorContainer();
  },

  // Pre-Save-Conflict-Check für Read-Modify-Write-Pfade. Vor PUT die Seite
  // frisch lesen und `updated_at` mit Editor-Snapshot vergleichen; Mismatch =
  // anderer User hat zwischendrin gespeichert. Liefert null bei keiner
  // Diskrepanz, sonst { remoteUpdatedAt, remoteUserName, remoteHtml }.
  // Wirft nicht — Aufrufer entscheidet bei Read-Fehler.
  async _checkPageConflict(pageId, expectedUpdatedAt) {
    if (!expectedUpdatedAt) return null;
    // Offline kann es keinen Cross-User-Konflikt geben — der ohnehin folgende
    // PUT wird ebenfalls scheitern und in den Offline-Banner-Pfad fallen. Modal
    // hier zu zeigen wäre irreführend (kein verlässlicher Server-Stand).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
    let remote;
    try {
      remote = await contentRepo.loadPage(pageId, { fresh: true });
    } catch (e) {
      console.warn('[checkPageConflict] read failed, skip modal', { pageId, status: e?.status, code: e?.code, msg: e?.message });
      return null;
    }
    if (!remote?.updated_at) {
      console.warn('[checkPageConflict] remote response without updated_at, skip modal', { pageId });
      return null;
    }
    if (remote.updated_at === expectedUpdatedAt) return null;
    return {
      remoteUpdatedAt: remote.updated_at,
      remoteUserName: remote.updated_by_name || null,
      remoteHtml: remote.html || '',
    };
  },

  // Nach jedem erfolgreichen Save: Findings, deren `original`-Text nicht mehr
  // im neuen HTML vorkommt, gelten als behoben und fliegen raus. Gilt sowohl
  // für saveEdit (expliziter Save) als auch quickSave (Ctrl+S/Autosave) –
  // damit das Prüf-Panel auch nach Fokus-Editor-Edits aktuell bleibt.
  _filterFindingsAfterSave(newHtml) {
    const app = window.__app;
    if (!app?.lektoratFindings || app.lektoratFindings.length === 0) return;
    const survivors = [];
    const prevSelected = new Map();
    for (let i = 0; i < app.lektoratFindings.length; i++) {
      const f = app.lektoratFindings[i];
      if (f.original && newHtml.indexOf(f.original) !== -1) {
        survivors.push(f);
        prevSelected.set(f, !!app.selectedFindings[i]);
      }
    }
    app.lektoratFindings = sortByPosition(newHtml, survivors);
    app.selectedFindings = app.lektoratFindings.map(f => prevSelected.get(f) ?? false);
    app.appliedOriginals = app.appliedOriginals.filter(o => newHtml.indexOf(o) !== -1);
    if (app.lektoratFindings.length === 0) {
      app.checkDone = false;
      app.correctedHtml = null;
      app.hasErrors = false;
    } else {
      app._recomputeCorrectedHtml?.();
    }
  },

  startEdit() {
    const app = window.__app;
    if (!app || !app.currentPage || app.originalHtml === null) return;
    if (app.checkLoading || app.saveApplying != null) return;
    // Prüfmodus blockt Edit (Invariante: editMode + checkDone forbidden).
    // Findings-Apply-Pfad bleibt via saveCorrections, ohne contenteditable.
    if (app.checkDone) return;
    // viewer/lektor duerfen Page-HTML nicht direkt mutieren.
    // Defense-in-depth zum verstecken Button-Hide in editor.html.
    if (!app.canEdit?.()) return;
    app.editMode = true;
    app.editDirty = false;
    app.editSaving = false;
    app.saveOffline = false;
    app.pendingDraft = null;

    // Chromium/Safari-Default ist 'div' → Enter an bare Text oder am
    // Editor-Root erzeugt <div> statt <p>, damit fehlt der Absatz-Abstand
    // und der Fokus-Mode erkennt den Block nicht (BLOCK_TAGS ohne DIV).
    // Einmal pro Edit-Session genügt, der Flag ist dokumentweit.
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}

    let initialHtml = app.originalHtml;

    // Draft-Wiederherstellung: lokalen Entwurf immer übernehmen, wenn vorhanden
    // und abweichend. Kein Dialog – der User hat den Entwurf bewusst getippt,
    // ihn beim Wiedereintritt zu verwerfen wäre destruktiv.
    const draft = readDraft(app.currentPage.id);
    if (draft && draft.html && draft.html !== app.originalHtml) {
      initialHtml = draft.html;
      app.editDirty = true;
      app.lastDraftSavedAt = draft.savedAt || Date.now();
    }

    const el = this._getEditEl();
    if (el) {
      if (initialHtml) {
        el.innerHTML = initialHtml;
      } else {
        // Leere Seite: Platzhalter-Absatz, damit der Cursor einen Block hat
        // (sonst landen erste Zeichen als orphan-Textnode direkt unter dem
        // Editor-Root und Focus-Mode-Absatz-Erkennung greift erst nach Enter).
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        el.replaceChildren(p);
      }
      // Pre-Normalize-Snapshot: weicht die Fassung nach normalizeEditorBlocks
      // davon ab, hat der Normalizer Legacy-HTML repariert (orphan Text-/
      // Inline-Nodes direkt unter dem Editor-Root). Ohne Persistenz kehrt
      // der Defekt nach jedem Reload zurück und bricht Focus-Mode-Absatz-
      // Hervorhebung erneut. `editDirty=true` sorgt dafür, dass der nächste
      // Auto- oder Manual-Save die bereinigte Fassung nach BookStack schreibt.
      const beforeNormalize = el.innerHTML;
      normalizeEditorBlocks(el);
      if (el.innerHTML !== beforeNormalize) {
        app.editDirty = true;
        this._scheduleDraftSave();
      }
      // Caret-Slot: Server liefert neue Seiten als `<p></p>` ohne Kinder
      // (cleanPageHtml-Fallback). Selection auf Element-Offset 0 in einem
      // leeren `<p>` empfängt keinen Caret und keine input-Events → User
      // sieht nichts und kann nicht tippen. `<br>` als Schreib-Slot ergänzen;
      // html-clean strippt `<p><br></p>` beim nächsten Save wieder.
      // Pendant zu jumpToTrailingParagraph im Fokus-Modus; hier vorab, weil
      // auch normaler Edit-Modus den Bug zeigt.
      const lastBlock = el.lastElementChild;
      if (lastBlock && lastBlock.tagName === 'P' && !lastBlock.hasChildNodes()) {
        lastBlock.appendChild(document.createElement('br'));
      }
    }
    setTimeout(() => this._getEditEl()?.focus(), 0);

    this._startAutosave();
    this._installOnlineRetry();
    // Presence-Heartbeat: anderen Usern signalisieren „hier editiert wer".
    // Stopp im cancelEdit/saveEdit (Non-Focus-Pfad).
    app._startPresenceHeartbeat?.(app.currentPage.id);
    // Soft-Edit-Lock: zusaetzliches UI-Signal mit Ablaufzeit; OCC-Pfad bleibt
    // das echte Safety-Net. Fremder Lock → foreignEditLock-Banner.
    app._acquireEditLock?.(app.currentPage.id);
    // Live-Counter rechnet in beiden Modi (für korrektes Tagesdelta beim
    // Wiedereintritt in den Focus), sichtbar aber nur im Focus-Header
    // (x-show=focusActive in editor.html). Setup nach Alpine-x-show-Flush —
    // contenteditable existiert vorher nicht im DOM.
    setTimeout(() => { if (app.editMode) installEditCounter(app); }, 0);
    // Snapshot für Reload-Wiederaufnahme. Pendant zu focus/storage.js —
    // beim regulären Exit (cancelEdit/saveEdit) wird er wieder gelöscht.
    writeNormalSnapshot(app.currentPage.id);

    // Layout-Prefs (Fullscreen + Seitenbreite) aus localStorage restoren.
    // Fit-Width skaliert die Schrift jetzt per CSS Container-Query (cqi) —
    // kein JS-Pfad, kein Zoom-Vorab-Compute mehr.
    const prefs = readEditorPrefs();
    app.pageEditorFullscreen = prefs.fullscreen;
    app.pageEditorFitWidth = prefs.fitWidth;
  },

  async cancelEdit() {
    const app = window.__app;
    if (!app) return;
    if (app.editDirty) {
      const ok = await app.appConfirm({
        message: app.t('edit.cancelConfirm'),
        confirmLabel: app.t('edit.discardEdit'),
        danger: true,
      });
      if (!ok) return;
    }
    if (app.currentPage) clearDraft(app.currentPage.id);
    clearNormalSnapshot();
    this._stopAutosave();
    this._uninstallOnlineRetry();
    app._editCounterCtx?.teardown?.();
    app._stopPresenceHeartbeat?.();
    app._releaseEditLock?.(app.currentPage?.id);
    app.lastDraftSavedAt = null;
    app.editMode = false;
    app.editDirty = false;
    app.editSaving = false;
    app.saveOffline = false;
    app.pageEditorFullscreen = false;
    app.pageEditorFitWidth = false;
    app.pendingDraft = null;
    app.closeSynonymMenu?.();
    app.closeSynonymPicker?.();
    app.closeFigurLookup?.();
    app.updatePageView?.();
    if (app.focusActive) app.exitFocusMode?.();
  },

  async saveEdit() {
    const app = window.__app;
    if (!app || !app.currentPage) return;
    if (!app.canEdit?.()) return;
    const el = this._getEditEl();
    if (!el) return;
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (isNoChange(newHtml, app.originalHtml)) {
      // Im Fokusmodus nicht aus Edit-/Fokusmodus herausfallen, wenn
      // der User ein zweites Mal Speichern klickt (nichts geändert).
      if (app.focusActive) {
        app.setStatus(app.t('edit.changesSaved'), false, 2000);
        return;
      }
      // editDirty kann durch startEdit-Normalize gesetzt sein, obwohl der
      // tatsächliche Inhalt sich nicht von normalizeForCompare(original)
      // unterscheidet. cancelEdit darf hier NICHT den Verwerfen-Dialog
      // zeigen — wir sind im Save-Flow, nicht im Cancel-Flow.
      app.editDirty = false;
      this.cancelEdit();
      return;
    }

    const newText = htmlToText(newHtml).trim();
    if (!newText) {
      app.setStatus(app.t('edit.emptyTextAbort'), false, 5000);
      return;
    }
    const origText = htmlToText(app.originalHtml || '').trim();
    if (origText.length > 50 && newText.length < origText.length * 0.2) {
      const okShort = await app.appConfirm({
        message: app.t('edit.shorterConfirm', { newLen: newText.length, oldLen: origText.length }),
      });
      if (!okShort) return;
    }

    const conflict = await this._checkPageConflict(app.currentPage.id, app.currentPage.updated_at);
    if (conflict) {
      app.editConflict = {
        remoteUserName: conflict.remoteUserName,
        remoteUpdatedAt: conflict.remoteUpdatedAt,
      };
      const okOverwrite = await app.appConfirm({
        message: app.t('edit.conflict.message', {
          user: conflict.remoteUserName || app.t('edit.conflict.unknownUser'),
          time: app.formatDate(conflict.remoteUpdatedAt),
        }),
        confirmLabel: app.t('edit.conflict.saveAnyway'),
        danger: true,
      });
      if (!okOverwrite) {
        writeDraft(app.currentPage.id, newHtml, app.originalHtml, app.currentPage.updated_at);
        app.lastDraftSavedAt = Date.now();
        app.saveOffline = true;
        app.setStatus(app.t('edit.conflict.kept'), false, 6000);
        return;
      }
    }

    app.editSaving = true;
    app.setStatus(app.t('edit.saving'), true);
    try {
      const saved = await savePage(app.currentPage.id, {
        html: newHtml,
        pageName: app.currentPage.name,
        source: app.focusActive ? 'focus' : 'main',
        expectedUpdatedAt: app.currentPage.updated_at,
      });
      if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;

      app.originalHtml = newHtml;
      app.currentPageEmpty = !htmlToText(newHtml).trim();

      this._filterFindingsAfterSave(newHtml);
      app._syncPageStatsAfterSave?.(app.currentPage, newHtml);
      // Sidebar-Lektorat-Status flippt auf 'warn' (updated_at > checkedAt) — Server-Map nachladen.
      app.refreshPageAges?.();

      clearDraft(app.currentPage.id);
      app.lastAutosaveAt = Date.now();
      app.lastDraftSavedAt = null;
      app.editDirty = false;
      app.saveOffline = false;
      app.editConflict = null;
      app.updatePageView?.();
      // Kein extra setStatus — Save-Indicator in der Subline zeigt schon
      // "gespeichert HH:MM"; doppelte Notification wäre redundant.
      if (app.focusActive) {
        // Fokus bleibt aktiv — User schreibt weiter; editMode/Listener bleiben.
      } else {
        clearNormalSnapshot();
        this._stopAutosave();
        this._uninstallOnlineRetry();
        app._editCounterCtx?.teardown?.();
        app._stopPresenceHeartbeat?.();
        app._releaseEditLock?.(app.currentPage?.id);
        app.editMode = false;
        app.pageEditorFullscreen = false;
        app.pageEditorFitWidth = false;
        app.closeSynonymMenu?.();
        app.closeSynonymPicker?.();
      }
      app.setStatus('');
    } catch (e) {
      if (isPageConflict(e)) {
        // Race: zwischen Pre-Check und PUT hat anderer User geschrieben.
        // Draft sichern + Conflict-Banner setzen; User muss erneut entscheiden.
        writeDraft(app.currentPage.id, newHtml, app.originalHtml, app.currentPage.updated_at);
        app.lastDraftSavedAt = Date.now();
        app.saveOffline = true;
        app.editConflict = readConflictBody(e);
        app.setStatus(app.t('edit.conflict.kept'), false, 8000);
        app.editSaving = false;
        return;
      }
      console.error('[saveEdit]', e);
      // Netzwerkfehler → Draft behalten, Offline-Modus aktivieren, Auto-Retry.
      writeDraft(app.currentPage.id, newHtml, app.originalHtml, app.currentPage.updated_at);
      app.lastDraftSavedAt = Date.now();
      app.saveOffline = true;
      if (!navigator.onLine) {
        app.setStatus(app.t('edit.offlineSaved'), false, 8000);
      } else {
        app.setStatus(app.t('edit.saveFailed', { msg: e.message }), false, 8000);
      }
    } finally {
      app.editSaving = false;
    }
  },

  // Stilles Speichern (Ctrl+S / Auto-Save): bleibt im Editor.
  async quickSave() {
    const app = window.__app;
    if (!app || !app.editMode || !app.currentPage || app.editSaving) return;
    // Ohne Edit-Recht kein Auto-Save (Defense; startEdit blockt
    // ohnehin den Eintritt — aber Race mit Role-Refresh waehrend Edit-Session).
    if (!app.canEdit?.()) return;
    const el = this._getEditEl();
    if (!el) return;
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (isNoChange(newHtml, app.originalHtml)) {
      app.editDirty = false;
      clearDraft(app.currentPage.id);
      app.lastDraftSavedAt = null;
      return;
    }
    const newText = htmlToText(newHtml).trim();
    if (!newText) return;

    // Immer zuerst lokal sichern, dann erst Netzwerkversuch.
    writeDraft(app.currentPage.id, newHtml, app.originalHtml, app.currentPage.updated_at);
    app.lastDraftSavedAt = Date.now();

    const localeTag = (app.uiLocale === 'en') ? 'en-US' : 'de-CH';

    if (!navigator.onLine) {
      app.saveOffline = true;
      app.setStatus(app.t('edit.offlineSavedAt', { time: new Date().toLocaleTimeString(localeTag, tzOpts()) }), false, 3000);
      return;
    }

    // editSaving früh setzen — verhindert, dass parallele Auto-Save-Tick + Ctrl+S
    // (oder exitFocusMode-quickSave + Auto-Save-Timer) den gleichen PUT zweimal
    // absetzen.
    app.editSaving = true;
    try {
      // Silent-Path: Auto-Save / Pre-Send-Refresh dürfen keinen Modal triggern.
      // Bei Cross-User-Konflikt → Draft bleibt liegen, editConflict-Banner
      // im Editor-Header zeigt Hinweis (auch im Fokusmodus sichtbar). User
      // muss explizit Save-Button drücken (saveEdit), dort fragt appConfirm
      // dann nach Überschreiben.
      const conflict = await this._checkPageConflict(app.currentPage.id, app.currentPage.updated_at);
      if (conflict) {
        app.saveOffline = true;
        app.editConflict = {
          remoteUserName: conflict.remoteUserName,
          remoteUpdatedAt: conflict.remoteUpdatedAt,
        };
        app.setStatus(app.t('edit.conflict.unsavedHint', {
          user: conflict.remoteUserName || app.t('edit.conflict.unknownUser'),
        }), false, 8000);
        return;
      }
      const saved = await savePage(app.currentPage.id, {
        html: newHtml,
        pageName: app.currentPage.name,
        source: app.focusActive ? 'focus' : 'main',
        expectedUpdatedAt: app.currentPage.updated_at,
      });
      if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;
      app.originalHtml = newHtml;
      app.editDirty = false;
      app.saveOffline = false;
      app.editConflict = null;
      app.lastAutosaveAt = Date.now();
      app.lastDraftSavedAt = null;
      clearDraft(app.currentPage.id);
      app.currentPageEmpty = !htmlToText(newHtml).trim();
      this._filterFindingsAfterSave(newHtml);
      app._syncPageStatsAfterSave?.(app.currentPage, newHtml);
      // Sidebar-Lektorat-Status flippt auf 'warn' (updated_at > checkedAt) — Server-Map nachladen.
      app.refreshPageAges?.();
      app.updatePageView?.();
      // Kein setStatus — Save-Indicator in der Subline zeigt schon
      // "gespeichert HH:MM"; doppelte Notification wäre redundant.
      app.setStatus('');
    } catch (e) {
      if (isPageConflict(e)) {
        // Race nach Pre-Check: anderer User war im selben Tick schneller.
        // Quiet-Pfad: Draft bleibt, Banner setzen, kein Modal.
        app.saveOffline = true;
        app.editConflict = readConflictBody(e);
        app.setStatus(app.t('edit.conflict.unsavedHint', {
          user: e.body?.server_editor_name || app.t('edit.conflict.unknownUser'),
        }), false, 8000);
        app.editSaving = false;
        return;
      }
      console.error('[quickSave]', e);
      app.saveOffline = true;
      app.setStatus(app.t('edit.saveFailedRetry'), false, 6000);
    } finally {
      app.editSaving = false;
    }
  },

  _onEditPaste(e) {
    if (handleEditorPaste(e)) this._markEditDirty();
  },

  _onEditCopy(e) { handleEditorCopy(e); },

  _onEditCut(e) {
    if (handleEditorCut(e)) this._markEditDirty();
  },

  _markEditDirty() {
    const app = window.__app;
    if (!app?.editMode) return;
    app.editDirty = true;
    this._scheduleDraftSave();
    this._scheduleAutosave();
  },

  _scheduleDraftSave() {
    const app = window.__app;
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
    const app = window.__app;
    if (!app) return;
    if (app._draftTimer) { clearTimeout(app._draftTimer); app._draftTimer = null; }
    if (!app.editMode || !app.currentPage) return;
    const el = this._getEditEl();
    if (!el) return;
    const html = stripLektoratMarks(el.innerHTML);
    if (isNoChange(html, app.originalHtml)) {
      clearDraft(app.currentPage.id);
      app.lastDraftSavedAt = null;
      return;
    }
    writeDraft(app.currentPage.id, html, app.originalHtml, app.currentPage.updated_at);
    app.lastDraftSavedAt = Date.now();
  },

  _startAutosave() {
    const app = window.__app;
    if (!app) return;
    this._clearAutosaveTimers();
    if (app.editDirty) this._scheduleAutosave();
  },

  _stopAutosave() {
    const app = window.__app;
    if (!app) return;
    this._clearAutosaveTimers();
    if (app._draftTimer) { clearTimeout(app._draftTimer); app._draftTimer = null; }
  },

  _clearAutosaveTimers() {
    const app = window.__app;
    if (!app) return;
    if (app._autosaveIdleTimer) { clearTimeout(app._autosaveIdleTimer); app._autosaveIdleTimer = null; }
    if (app._autosaveMaxTimer) { clearTimeout(app._autosaveMaxTimer); app._autosaveMaxTimer = null; }
  },

  // Idle-Timer wird bei jedem Edit zurückgesetzt → speichert erst nach
  // AUTOSAVE_IDLE_MS Tipp-Pause. Max-Timer läuft ab erstem Dirty-Mark
  // weiter und greift bei Dauer-Tippen, sodass spätestens AUTOSAVE_MAX_MS
  // nach der ersten Änderung ein Save ausgelöst wird.
  _scheduleAutosave() {
    const app = window.__app;
    if (!app) return;
    if (app._autosaveIdleTimer) clearTimeout(app._autosaveIdleTimer);
    app._autosaveIdleTimer = setTimeout(() => this._fireAutosave(), AUTOSAVE_IDLE_MS);
    if (!app._autosaveMaxTimer) {
      app._autosaveMaxTimer = setTimeout(() => this._fireAutosave(), AUTOSAVE_MAX_MS);
    }
  },

  _fireAutosave() {
    const app = window.__app;
    if (!app) return;
    this._clearAutosaveTimers();
    if (app.editMode && app.editDirty && !app.editSaving) this.quickSave();
  },

  _installOnlineRetry() {
    const app = window.__app;
    if (!app || app._onlineHandler) return;
    app._onlineHandler = () => {
      if (app.editMode && app.editDirty && app.saveOffline) {
        this.quickSave();
      }
    };
    window.addEventListener('online', app._onlineHandler);
  },

  _uninstallOnlineRetry() {
    const app = window.__app;
    if (!app || !app._onlineHandler) return;
    window.removeEventListener('online', app._onlineHandler);
    app._onlineHandler = null;
  },

  togglePageEditorFullscreen() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorFullscreen = !app.pageEditorFullscreen;
    writeEditorPrefs({ fullscreen: app.pageEditorFullscreen, fitWidth: app.pageEditorFitWidth });
  },

  // Fit-Width ist Pure-CSS (Container-Query in page-view.css). Toggle ändert
  // nur die Klasse; Font-Scaling übernimmt cqi-Calc. Manueller Zoom (--editor-zoom)
  // multipliziert sich orthogonal — beim Toggle hier nicht angefasst.
  togglePageEditorFitWidth() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorFitWidth = !app.pageEditorFitWidth;
    writeEditorPrefs({ fullscreen: app.pageEditorFullscreen, fitWidth: app.pageEditorFitWidth });
  },

  pageEditorZoomIn() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = Math.min(2.5, Math.round((app.pageEditorZoom + 0.1) * 100) / 100);
  },

  pageEditorZoomOut() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = Math.max(0.7, Math.round((app.pageEditorZoom - 0.1) * 100) / 100);
  },

  pageEditorZoomReset() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = 1;
  },

  async normalizeQuotes() {
    const app = window.__app;
    if (!app?.selectedBookId) return;
    const editEl = this._getEditEl();
    if (!editEl) return;
    const { ok, count } = await runQuoteNormalize({
      bookId: app.selectedBookId,
      rootEl: editEl,
    });
    if (!ok) return;
    if (count > 0) {
      app._markEditDirty?.();
      editEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    window.dispatchEvent(new CustomEvent('languagetool:recheck'));
  },

  // Trennlinie (<hr>) am Caret einfügen + Folge-Absatz für Weiterschreiben.
  // Verhalten: leerer Block → ersetzen; sonst → nach Block einfügen.
  // Trigger: Toolbar-Button + Cmd/Ctrl+Shift+H (siehe editor/toolbar.js).
  insertHorizontalRule() {
    const editEl = this._getEditEl();
    if (!editEl) return;
    editEl.focus();
    const sel = document.getSelection();
    let block = null;
    if (sel && sel.rangeCount) {
      let cur = sel.getRangeAt(0).startContainer;
      if (cur && cur.nodeType === 3) cur = cur.parentNode;
      while (cur && cur !== editEl) {
        if (cur.nodeType === 1 && cur.matches?.('p, h1, h2, h3, h4, h5, h6, blockquote, pre, li, div.poem')) { block = cur; break; }
        cur = cur.parentNode;
      }
    }
    const hr = document.createElement('hr');
    const next = document.createElement('p');
    next.appendChild(document.createElement('br'));
    if (!block) {
      editEl.appendChild(hr);
      editEl.appendChild(next);
    } else if ((block.textContent || '').trim() === '') {
      block.parentNode.replaceChild(hr, block);
      hr.insertAdjacentElement('afterend', next);
    } else {
      block.insertAdjacentElement('afterend', hr);
      hr.insertAdjacentElement('afterend', next);
    }
    const range = document.createRange();
    range.setStart(next, 0);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    this._markEditDirty?.();
  },
};
