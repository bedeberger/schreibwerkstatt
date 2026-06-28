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
import { mergeBlocks, mergedToHtml, buildResolvedHtml } from '../shared/block-merge.js';
import { trackMerge } from '../shared/merge-telemetry.js';
import { FEATURE_BLOCK_MERGE } from '../../app/app-state.js';
import { getActiveEditorContainer } from '../shared/active-editor.js';
import { installEditCounter } from '../shared/edit-counter.js';
import { writeNormalSnapshot, clearNormalSnapshot, readEditorPrefs, writeEditorPrefs } from './storage.js';
import { runQuoteNormalize } from '../shared/quote-normalize.js';
import { ensureTrailingParagraph } from '../shared/auto-slot.js';
import { EVT } from '../../events.js';

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

  // Block-Level-3-Way-Merge gegen den frischen Remote-Stand. base = originalHtml
  // (zuletzt geladene/gespeicherte Server-Fassung = common ancestor). Liefert
  // { merged, conflicts } oder null → Aufrufer fällt auf klassischen Banner zurück
  // (Flag off, leere Base = frische Page → 2-Way-Fallback, oder Merge wirft).
  _computeBlockMerge(localHtml, remoteHtml) {
    const app = window.__app;
    if (!FEATURE_BLOCK_MERGE) return null;
    const base = app.originalHtml || '';
    if (!base) return null;
    try {
      return mergeBlocks(base, localHtml, remoteHtml);
    } catch (e) {
      console.warn('[blockMerge] compute failed, fallback to classic', e);
      return null;
    }
  },

  // Gemergtes HTML in den Live-Editor spiegeln, damit Folge-Edits auf dem
  // gemergten Stand aufbauen (sonst würde der nächste Save remote-Blöcke
  // wieder „zurückeditieren"). Quelle ist server-sanitiertes Page-HTML (gleiche
  // Vertrauensstufe wie startEdit, das ebenfalls direkt setzt). Cursor springt
  // an den Anfang — akzeptabel, der Pfad läuft nur bei echtem Multi-Device-Konflikt.
  _applyMergedToEditor(html) {
    const el = this._getEditEl();
    if (el && el.innerHTML !== html) el.innerHTML = html;
  },

  // Konflikt-Banner öffnen: kollidierende Blöcke + Auflösungs-State festhalten.
  _openConflictResolution({ merged, conflicts, source, remoteUpdatedAt }) {
    const app = window.__app;
    const decisions = {};
    for (const c of conflicts) decisions[c.bid] = 'local';
    app.conflictResolution = {
      pageId: app.currentPage?.id,
      source,
      merged,
      conflicts,
      remoteUpdatedAt,
      decisions,
    };
    trackMerge('conflict_shown');
  },

  // Konflikt-Orchestrierung: versucht Block-Merge gegen den Remote-Stand.
  // remoteHtml/remoteUpdatedAt können aus _checkPageConflict mitgegeben werden
  // (spart einen fresh-Load); fehlen sie (409-Race), wird frisch geladen.
  // Rückgabe:
  //   { merged:true, saveHtml, expectedAt } — kollisionsfrei, Aufrufer speichert saveHtml.
  //   { conflict:true } — Auflösungs-Banner geöffnet, Aufrufer bricht ab.
  //   null — kein Merge (Flag off / leere Base / Read-Fehler) → klassischer Pfad.
  async _attemptBlockMerge({ localHtml, source, remoteHtml = null, remoteUpdatedAt = null }) {
    const app = window.__app;
    if (!FEATURE_BLOCK_MERGE || !app.currentPage) return null;
    if (remoteHtml === null || remoteUpdatedAt === null) {
      try {
        const remote = await contentRepo.loadPage(app.currentPage.id, { fresh: true });
        remoteHtml = remote?.html || '';
        remoteUpdatedAt = remote?.updated_at || null;
      } catch { return null; }
    }
    if (!remoteUpdatedAt) return null;
    const m = this._computeBlockMerge(localHtml, remoteHtml);
    if (!m) return null;
    if (m.conflicts.length === 0) {
      const saveHtml = mergedToHtml(m.merged);
      this._applyMergedToEditor(saveHtml);
      trackMerge('silent_success');
      return { merged: true, saveHtml, expectedAt: remoteUpdatedAt };
    }
    writeDraft(app.currentPage.id, localHtml, app.originalHtml, app.currentPage.updated_at);
    app.lastDraftSavedAt = Date.now();
    app.saveOffline = true;
    this._openConflictResolution({ merged: m.merged, conflicts: m.conflicts, source, remoteUpdatedAt });
    return { conflict: true };
  },

  // Auflösungs-Entscheidung pro Block (UI). choice: 'local'|'remote'|'both'.
  resolveBlock(bid, choice) {
    const app = window.__app;
    if (!app.conflictResolution) return;
    app.conflictResolution.decisions[bid] = choice;
  },

  // Bulk: alle Konflikte auf eine Seite setzen.
  resolveAllConflicts(choice) {
    const app = window.__app;
    if (!app.conflictResolution) return;
    for (const c of app.conflictResolution.conflicts) {
      app.conflictResolution.decisions[c.bid] = choice;
    }
  },

  // Auflösung übernehmen: finales HTML aus merged + decisions bauen und mit
  // expected_updated_at = remoteUpdatedAt speichern.
  async submitConflictResolution() {
    const app = window.__app;
    const cr = app.conflictResolution;
    if (!cr || app.editSaving) return;
    const finalHtml = buildResolvedHtml(cr.merged, cr.decisions);
    const source = cr.source || (app.focusActive ? 'focus' : 'main');
    app.editSaving = true;
    app.setStatus(app.t('edit.saving'), true);
    try {
      const saved = await savePage(cr.pageId, {
        html: finalHtml,
        pageName: app.currentPage?.name,
        source,
        expectedUpdatedAt: cr.remoteUpdatedAt,
      });
      if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;
      this._applyMergedToEditor(finalHtml);
      app.originalHtml = finalHtml;
      app.currentPageEmpty = !htmlToText(finalHtml).trim();
      this._filterFindingsAfterSave(finalHtml);
      app._syncPageStatsAfterSave?.(app.currentPage, finalHtml);
      app.refreshPageAges?.();
      clearDraft(cr.pageId);
      app.lastAutosaveAt = Date.now();
      app.lastDraftSavedAt = null;
      app.editDirty = false;
      app.saveOffline = false;
      app.editConflict = null;
      trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
      app.conflictResolution = null;
      app.updatePageView?.();
      app.setStatus('');
    } catch (e) {
      if (isPageConflict(e)) {
        // Dritter Schreibvorgang zwischen Konflikt-Anzeige und „Auflösung
        // übernehmen": der finale PUT (expected = cr.remoteUpdatedAt) trifft
        // erneut 409. Statt Sackgasse (User klickt immer in denselben 409) die
        // lokal aufgelöste Fassung gegen den jetzt frischen Remote-Stand neu
        // block-mergen — analog zum 409-Pfad in saveEdit, nur mit finalHtml als
        // lokaler Quelle (= die gerade getroffene Auflösung).
        app.editSaving = false;
        const merge = await this._attemptBlockMerge({ localHtml: finalHtml, source });
        // _openConflictResolution hat den conflictResolution-State auf den neuen
        // Remote-Stand ersetzt → User löst die neue Kollision auf.
        if (merge?.conflict) return;
        if (merge?.merged) {
          // Kollisionsfrei gegen den neuen Stand: gemergte Auflösung nachspeichern.
          try {
            const saved = await savePage(cr.pageId, {
              html: merge.saveHtml, pageName: app.currentPage?.name, source,
              expectedUpdatedAt: merge.expectedAt,
            });
            if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;
            this._applyMergedToEditor(merge.saveHtml);
            app.originalHtml = merge.saveHtml;
            app.currentPageEmpty = !htmlToText(merge.saveHtml).trim();
            this._filterFindingsAfterSave(merge.saveHtml);
            app._syncPageStatsAfterSave?.(app.currentPage, merge.saveHtml);
            app.refreshPageAges?.();
            clearDraft(cr.pageId);
            app.lastAutosaveAt = Date.now();
            app.lastDraftSavedAt = null;
            app.editDirty = false;
            app.saveOffline = false;
            app.editConflict = null;
            trackMerge('conflict_resolved', { mix: this._resolutionMix(cr) });
            app.conflictResolution = null;
            app.updatePageView?.();
            app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
            return;
          } catch (e2) { console.warn('[submitConflictResolution] merged re-save failed', e2); }
        }
        // Fallback (Merge null: Flag off / leere Base / Read-Fehler): die
        // aufgelöste Arbeit als Draft sichern, Offline-/Konflikt-Banner zeigen.
        // conflictResolution bleibt offen — User kann erneut übernehmen/abbrechen.
        writeDraft(cr.pageId, finalHtml, app.originalHtml, app.currentPage?.updated_at);
        app.lastDraftSavedAt = Date.now();
        app.saveOffline = true;
        app.editConflict = readConflictBody(e);
        app.setStatus(app.t('edit.conflict.kept'), false, 8000);
        return;
      }
      console.error('[submitConflictResolution]', e);
      app.setStatus(app.t('edit.saveFailed', { msg: e.message }), false, 8000);
    } finally {
      app.editSaving = false;
    }
  },

  // Auflösungs-Mix (Meine/Andere/Beide) für Telemetrie aus dem
  // conflictResolution-State zählen.
  _resolutionMix(cr) {
    const mix = { local: 0, remote: 0, both: 0 };
    for (const c of cr.conflicts) {
      const choice = cr.decisions[c.bid] || 'local';
      if (mix[choice] != null) mix[choice]++;
    }
    return mix;
  },

  // Auflösung abbrechen: Konflikt-State verwerfen, frischen Server-Stand laden.
  // Lokale Edits bleiben als Page-Revision/Draft erhalten (Last-Resort).
  async cancelConflictResolution() {
    const app = window.__app;
    const cr = app.conflictResolution;
    app.conflictResolution = null;
    app.editConflict = null;
    if (!cr?.pageId) return;
    try {
      const remote = await contentRepo.loadPage(cr.pageId, { fresh: true });
      if (remote?.html != null) {
        this._applyMergedToEditor(remote.html);
        app.originalHtml = remote.html;
        if (remote.updated_at) app.currentPage.updated_at = remote.updated_at;
        app.editDirty = false;
        app.saveOffline = false;
        app.updatePageView?.();
      }
    } catch (e) {
      console.warn('[cancelConflictResolution] reload failed', e);
    }
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
    // Auto-Fokus-Caret (setTimeout focus() weiter unten) ist KEIN bewusster
    // Anker — erst ein Klick ins Feld setzt sttCaretUserSet (STT haengt sonst
    // ans Editorende an).
    app.sttCaretUserSet = false;

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
      } else if (lastBlock && lastBlock.tagName === 'HR') {
        // Trailing <hr> ist ein void-Element ohne Caret-Slot. Endet die Seite
        // damit, gibt es keinen Block, um dahinter weiterzuschreiben — ein
        // Klick ans Seitenende landet vor der Linie. Folge-Absatz als
        // Schreib-Anker ergänzen (gleicher Slot wie insertHorizontalRule).
        // html-clean strippt das leere <p><br></p> beim nächsten Save wieder,
        // und normalizeForCompare ignoriert es im Dirty-Vergleich → kein
        // Persistenz- oder Falsch-Dirty-Effekt.
        ensureTrailingParagraph(el);
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

    // Undo/Redo: Session-Baseline mit dem initialen Edit-Stand. Stack
    // wird bei cancel/save (non-focus) wieder geclear't.
    if (el) this._historyReset?.(el.innerHTML);

    // Layout-Prefs (Fullscreen + Seitenbreite) aus localStorage restoren.
    // Fit-Width skaliert die Schrift jetzt per CSS Container-Query (cqi) —
    // kein JS-Pfad, kein Zoom-Vorab-Compute mehr.
    const prefs = readEditorPrefs();
    app.pageEditorFullscreen = prefs.fullscreen;
    app.pageEditorFitWidth = prefs.fitWidth;
    app.pageEditorShowMarks = prefs.showMarks;
    if (app.pageEditorShowMarks) this._installFormatMarks();
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
    this._uninstallFormatMarks();
    app._editCounterCtx?.teardown?.();
    app._stopPresenceHeartbeat?.();
    app._releaseEditLock?.(app.currentPage?.id);
    this._historyClear?.();
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

    let saveHtml = newHtml;
    let expectedAt = app.currentPage.updated_at;
    const source = app.focusActive ? 'focus' : 'main';
    const conflict = await this._checkPageConflict(app.currentPage.id, app.currentPage.updated_at);
    if (conflict) {
      const merge = await this._attemptBlockMerge({
        localHtml: newHtml, source,
        remoteHtml: conflict.remoteHtml, remoteUpdatedAt: conflict.remoteUpdatedAt,
      });
      if (merge?.conflict) return; // Auflösungs-Banner offen
      if (merge?.merged) {
        // Stiller Auto-Merge: nicht-kollidierende Block-Edits zusammengeführt.
        saveHtml = merge.saveHtml;
        expectedAt = merge.expectedAt;
        app.editConflict = null;
        app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
      }
      if (!merge?.merged) {
        // Klassischer Fallback (Flag off / leere Base / kein Merge): Überschreiben-Modal.
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
        if (FEATURE_BLOCK_MERGE) trackMerge('fallback_overwrite');
      }
    }

    app.editSaving = true;
    app.setStatus(app.t('edit.saving'), true);
    try {
      const saved = await savePage(app.currentPage.id, {
        html: saveHtml,
        pageName: app.currentPage.name,
        source,
        expectedUpdatedAt: expectedAt,
      });
      if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;

      app.originalHtml = saveHtml;
      app.currentPageEmpty = !htmlToText(saveHtml).trim();

      this._filterFindingsAfterSave(saveHtml);
      app._syncPageStatsAfterSave?.(app.currentPage, saveHtml);
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
        this._uninstallFormatMarks();
        app._editCounterCtx?.teardown?.();
        app._stopPresenceHeartbeat?.();
        app._releaseEditLock?.(app.currentPage?.id);
        this._historyClear?.();
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
        // Erneuter Block-Merge gegen den jetzt frischen Remote-Stand.
        app.editSaving = false;
        const merge = await this._attemptBlockMerge({ localHtml: newHtml, source });
        if (merge?.conflict) return;
        if (merge?.merged) {
          // Kollisionsfrei: gemergten Stand direkt nachspeichern.
          try {
            const saved = await savePage(app.currentPage.id, {
              html: merge.saveHtml, pageName: app.currentPage.name, source,
              expectedUpdatedAt: merge.expectedAt,
            });
            if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;
            app.originalHtml = merge.saveHtml;
            app.currentPageEmpty = !htmlToText(merge.saveHtml).trim();
            this._filterFindingsAfterSave(merge.saveHtml);
            app._syncPageStatsAfterSave?.(app.currentPage, merge.saveHtml);
            app.refreshPageAges?.();
            clearDraft(app.currentPage.id);
            app.editDirty = false;
            app.saveOffline = false;
            app.editConflict = null;
            app.updatePageView?.();
            app.setStatus(app.t('edit.conflict.merged.silent'), false, 3000);
            return;
          } catch (e2) { console.warn('[saveEdit] merged re-save failed', e2); }
        }
        // Fallback: Draft sichern + klassischer Conflict-Banner.
        writeDraft(app.currentPage.id, newHtml, app.originalHtml, app.currentPage.updated_at);
        app.lastDraftSavedAt = Date.now();
        app.saveOffline = true;
        app.editConflict = readConflictBody(e);
        app.setStatus(app.t('edit.conflict.kept'), false, 8000);
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

    // Bewusst KEIN navigator.onLine-Gate vor dem PUT: der Flag meldet (Sleep/Wake,
    // VPN-Wechsel, Netzwerk-Interface-Flap) faelschlich `false` und feuert danach
    // kein `online`-Event — ein Vorab-Abbruch wuerde den Editor dauerhaft auf
    // "offline" nageln (Recovery haengt am `online`-Event). Stattdessen den Fetch
    // immer wagen; sein echter Ausgang entscheidet ueber saveOffline (Catch unten).

    // editSaving früh setzen — verhindert, dass parallele Auto-Save-Tick + Ctrl+S
    // (oder exitFocusMode-quickSave + Auto-Save-Timer) den gleichen PUT zweimal
    // absetzen.
    app.editSaving = true;
    let saveHtml = newHtml;
    let expectedAt = app.currentPage.updated_at;
    const source = app.focusActive ? 'focus' : 'main';
    try {
      // Silent-Path: Auto-Save darf keinen Modal triggern. Bei Cross-User-Konflikt
      // versucht der Block-Merge still zusammenzuführen; nur echte Block-Kollisionen
      // öffnen das Auflösungs-Banner (auch im Fokusmodus sichtbar). Ohne Merge
      // (Flag off / leere Base) bleibt der editConflict-Hinweis wie gehabt.
      const conflict = await this._checkPageConflict(app.currentPage.id, app.currentPage.updated_at);
      if (conflict) {
        const merge = await this._attemptBlockMerge({
          localHtml: newHtml, source,
          remoteHtml: conflict.remoteHtml, remoteUpdatedAt: conflict.remoteUpdatedAt,
        });
        if (merge?.conflict) return; // Auflösungs-Banner offen
        if (merge?.merged) {
          saveHtml = merge.saveHtml;
          expectedAt = merge.expectedAt;
        } else {
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
      }
      const saved = await savePage(app.currentPage.id, {
        html: saveHtml,
        pageName: app.currentPage.name,
        source,
        expectedUpdatedAt: expectedAt,
      });
      if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;
      app.originalHtml = saveHtml;
      app.editDirty = false;
      app.saveOffline = false;
      app.editConflict = null;
      app.lastAutosaveAt = Date.now();
      app.lastDraftSavedAt = null;
      clearDraft(app.currentPage.id);
      app.currentPageEmpty = !htmlToText(saveHtml).trim();
      this._filterFindingsAfterSave(saveHtml);
      app._syncPageStatsAfterSave?.(app.currentPage, saveHtml);
      // Sidebar-Lektorat-Status flippt auf 'warn' (updated_at > checkedAt) — Server-Map nachladen.
      app.refreshPageAges?.();
      app.updatePageView?.();
      // Kein setStatus — Save-Indicator in der Subline zeigt schon
      // "gespeichert HH:MM"; doppelte Notification wäre redundant.
      app.setStatus('');
    } catch (e) {
      if (isPageConflict(e)) {
        // Race nach Pre-Check: anderer User war im selben Tick schneller.
        // Block-Merge gegen den frischen Remote-Stand; nur Block-Kollisionen
        // öffnen das Banner. Quiet-Pfad, kein Modal.
        app.editSaving = false;
        const merge = await this._attemptBlockMerge({ localHtml: newHtml, source });
        if (merge?.conflict) return;
        if (merge?.merged) {
          try {
            const saved = await savePage(app.currentPage.id, {
              html: merge.saveHtml, pageName: app.currentPage.name, source,
              expectedUpdatedAt: merge.expectedAt,
            });
            if (saved?.updated_at) app.currentPage.updated_at = saved.updated_at;
            app.originalHtml = merge.saveHtml;
            app.editDirty = false;
            app.saveOffline = false;
            app.editConflict = null;
            app.lastAutosaveAt = Date.now();
            app.lastDraftSavedAt = null;
            clearDraft(app.currentPage.id);
            app.currentPageEmpty = !htmlToText(merge.saveHtml).trim();
            this._filterFindingsAfterSave(merge.saveHtml);
            app._syncPageStatsAfterSave?.(app.currentPage, merge.saveHtml);
            app.refreshPageAges?.();
            app.updatePageView?.();
            return;
          } catch (e2) { console.warn('[quickSave] merged re-save failed', e2); }
        }
        app.saveOffline = true;
        app.editConflict = readConflictBody(e);
        app.setStatus(app.t('edit.conflict.unsavedHint', {
          user: e.body?.server_editor_name || app.t('edit.conflict.unknownUser'),
        }), false, 8000);
        return;
      }
      console.error('[quickSave]', e);
      app.saveOffline = true;
      // navigator.onLine ist hier nur noch Hinweis fuer die Wortwahl, kein Gate:
      // bei echtem Offline die freundlichere Meldung, sonst generischer Retry-Hinweis.
      if (!navigator.onLine) {
        const localeTag = (app.uiLocale === 'en') ? 'en-US' : 'de-CH';
        app.setStatus(app.t('edit.offlineSavedAt', { time: new Date().toLocaleTimeString(localeTag, tzOpts()) }), false, 3000);
      } else {
        app.setStatus(app.t('edit.saveFailedRetry'), false, 6000);
      }
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
    this._historyPushSoon?.();
    this._scrollEditCaretIntoView();
    // Steuerzeichen-Overlay neu vermessen: programmatische Mutationen (STT,
    // Paste, Cut, Toolbar) feuern KEIN `input`-Event, an dem die Marks-Schicht
    // sonst hängt — ohne diesen Aufruf bleibt die ↵/¶-Dekoration während des
    // Diktats stehen und entkoppelt sich vom Text. rAF-coalesced/idempotent,
    // daher für den Tipp-Pfad (feuert ohnehin `input`) ein No-op.
    this._scheduleFormatMarks?.();
  },

  // Hält den Caret im sichtbaren Bereich des Edit-Felds. Das contenteditable ist
  // sein eigener Scroll-Container (max-height + overflow-y:auto), darum nicht
  // scrollIntoView (das würde die ganze Seite scrollen), sondern den eigenen
  // scrollTop nachziehen. Nur ein Nudge, wenn der Caret über/unter den
  // sichtbaren Rand rutscht — scrollt der User bewusst weg (ohne zu tippen),
  // bleibt das unberührt (kein Input-Event). Aufrufer: `_markEditDirty`
  // (Tippen/Paste/Toolbar — Sicherheitsnetz) und STT (programmatischer Insert,
  // bei dem der Browser NICHT automatisch nachzieht). `rect` optional: STT
  // misst den eingefügten Knoten direkt, sonst wird der Live-Caret vermessen.
  _scrollEditCaretIntoView(rect) {
    const el = this._getEditEl();
    if (!el) return;
    let r = rect;
    if (!r) {
      const sel = document.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer) && el !== range.commonAncestorContainer) return;
      r = range.getBoundingClientRect();
      // Kollabierte Range in einem frisch erzeugten leeren `<p><br></p>` liefert
      // in Chromium {top:0, bottom:0, height:0}. Greift dann der Block-Fallback
      // nicht, bricht der Nudge beim Enter ab und der Editor zieht erst beim
      // ersten getippten Zeichen nach -> sichtbarer Scroll-Sprung. Stattdessen
      // den umschliessenden Block vermessen (wie der STT-Pfad mit explizitem
      // Knoten-Rect), damit der neue Absatz schon beim Enter mitscrollt.
      if (!r || (!r.height && !r.top && !r.bottom)) {
        let node = range.commonAncestorContainer;
        if (node && node.nodeType === 3) node = node.parentNode;
        while (node && node.parentNode && node.parentNode !== el) node = node.parentNode;
        if (node && node !== el && node.getBoundingClientRect) r = node.getBoundingClientRect();
      }
    }
    if (!r || (!r.height && !r.top && !r.bottom)) return; // kein verlässliches Rect
    const host = el.getBoundingClientRect();
    const margin = 28;
    if (r.bottom > host.bottom - margin) {
      el.scrollTop += r.bottom - (host.bottom - margin);
    } else if (r.top < host.top + margin) {
      el.scrollTop -= (host.top + margin) - r.top;
    }
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
    const app = window.__app;
    if (!app || !app._onlineHandler) return;
    window.removeEventListener('online', app._onlineHandler);
    window.removeEventListener('focus', app._onlineHandler);
    if (app._onlineVisHandler) {
      document.removeEventListener('visibilitychange', app._onlineVisHandler);
      app._onlineVisHandler = null;
    }
    app._onlineHandler = null;
  },

  togglePageEditorFullscreen() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorFullscreen = !app.pageEditorFullscreen;
    writeEditorPrefs({ fullscreen: app.pageEditorFullscreen, fitWidth: app.pageEditorFitWidth, showMarks: app.pageEditorShowMarks });
  },

  // Fit-Width ist Pure-CSS (Container-Query in page-view.css). Toggle ändert
  // nur die Klasse; Font-Scaling übernimmt cqi-Calc. Manueller Zoom (--editor-zoom)
  // multipliziert sich orthogonal — beim Toggle hier nicht angefasst.
  togglePageEditorFitWidth() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorFitWidth = !app.pageEditorFitWidth;
    writeEditorPrefs({ fullscreen: app.pageEditorFullscreen, fitWidth: app.pageEditorFitWidth, showMarks: app.pageEditorShowMarks });
  },

  // Steuerzeichen-Anzeige (Absatzmarken ¶ + Soft-Break ↵). Reiner Klassen-
  // Toggle auf dem contenteditable — die Marken sind CSS-Pseudo-Elemente
  // (page-view.css), kein Markup im gespeicherten HTML, kein Caret-Slot.
  togglePageEditorShowMarks() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorShowMarks = !app.pageEditorShowMarks;
    writeEditorPrefs({ fullscreen: app.pageEditorFullscreen, fitWidth: app.pageEditorFitWidth, showMarks: app.pageEditorShowMarks });
    if (app.pageEditorShowMarks) this._installFormatMarks();
    else this._uninstallFormatMarks();
  },

  pageEditorZoomIn() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = Math.min(2.5, Math.round((app.pageEditorZoom + 0.1) * 100) / 100);
    this._scheduleFormatMarks?.();
  },

  pageEditorZoomOut() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = Math.max(0.7, Math.round((app.pageEditorZoom - 0.1) * 100) / 100);
    this._scheduleFormatMarks?.();
  },

  pageEditorZoomReset() {
    const app = window.__app;
    if (!app) return;
    app.pageEditorZoom = 1;
    this._scheduleFormatMarks?.();
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
    app.quotesNormalizedFlash = { count };
    if (app._quotesFlashTimer) clearTimeout(app._quotesFlashTimer);
    app._quotesFlashTimer = setTimeout(() => {
      app.quotesNormalizedFlash = null;
      app._quotesFlashTimer = null;
    }, 1800);
    window.dispatchEvent(new CustomEvent(EVT.LANGUAGETOOL_RECHECK));
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
