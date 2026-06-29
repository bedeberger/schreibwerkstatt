// Teil von notebookEditMethods (siehe Facade edit.js).
import { FEATURE_BLOCK_MERGE, clearDraft, clearNormalSnapshot, ensureTrailingParagraph, getActiveEditorContainer, htmlToText, installEditCounter, isNoChange, isPageConflict, normalizeEditorBlocks, readConflictBody, readDraft, readEditorPrefs, savePage, sortByPosition, stripLektoratMarks, trackMerge, tzOpts, writeDraft, writeNormalSnapshot } from './_shared.js';

export const lifecycleMethods = {
  // Container-Lookup: einziger Eintrittspunkt für beide Modi.
  _getEditEl() {
    return getActiveEditorContainer();
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
    app.$store.stt.caretUserSet = false;

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
        const localeTag = (app.$store.shell.uiLocale === 'en') ? 'en-US' : 'de-CH';
        app.setStatus(app.t('edit.offlineSavedAt', { time: new Date().toLocaleTimeString(localeTag, tzOpts()) }), false, 3000);
      } else {
        app.setStatus(app.t('edit.saveFailedRetry'), false, 6000);
      }
    } finally {
      app.editSaving = false;
    }
  },
};
