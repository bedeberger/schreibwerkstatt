import { htmlToText, cleanContentArtefacts, tzOpts } from '../../utils.js';
import { sortByPosition } from '../../book/page-view.js';
import { contentRepo } from '../../repo/content.js';
import { readDraft, writeDraft, clearDraft } from '../draft-storage.js';
import {
  stripLektoratMarks,
  normalizeEditorBlocks,
} from '../shared/html-clean.js';
import { buildSavePayload, isNoChange } from '../shared/save-pipeline.js';
import { isPageConflict, readConflictBody } from '../shared/page-api.js';
import { getActiveEditorContainer } from '../shared/active-editor.js';
import { installEditCounter } from '../shared/edit-counter.js';
import { writeNormalSnapshot, clearNormalSnapshot } from './storage.js';

// Auto-Save nach BookStack: idle-debounce + max-Cap. Jede Schreibaktion
// resettet den Idle-Timer; läuft der User durchgehend, greift der Max-Timer.
// Reduziert Revision-Spam (vorher fester 30-s-Tick → ~120 Revisions/h Tippen).
const AUTOSAVE_IDLE_MS = 60000;
const AUTOSAVE_MAX_MS = 120000;
const DRAFT_DEBOUNCE_MS = 500;
// stripLektoratMarks / normalizeForCompare / normalizeEditorBlocks /
// ROOT_BLOCK_TAGS leben in public/js/editor/shared/html-clean.js — dieselbe
// Lib wird auch vom Focus-Editor konsumiert.


export const editorEditMethods = {
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
    let remote;
    try {
      remote = await contentRepo.loadPage(pageId, { fresh: true });
    } catch {
      return null;
    }
    if (!remote?.updated_at || remote.updated_at === expectedUpdatedAt) return null;
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
    if (!this.lektoratFindings || this.lektoratFindings.length === 0) return;
    const survivors = [];
    const prevSelected = new Map();
    for (let i = 0; i < this.lektoratFindings.length; i++) {
      const f = this.lektoratFindings[i];
      if (f.original && newHtml.indexOf(f.original) !== -1) {
        survivors.push(f);
        prevSelected.set(f, !!this.selectedFindings[i]);
      }
    }
    this.lektoratFindings = sortByPosition(newHtml, survivors);
    this.selectedFindings = this.lektoratFindings.map(f => prevSelected.get(f) ?? false);
    this.appliedOriginals = this.appliedOriginals.filter(o => newHtml.indexOf(o) !== -1);
    if (this.lektoratFindings.length === 0) {
      this.checkDone = false;
      this.correctedHtml = null;
      this.hasErrors = false;
    } else {
      this._recomputeCorrectedHtml();
    }
  },

  startEdit() {
    if (!this.currentPage || this.originalHtml === null) return;
    if (this.checkLoading || this.saveApplying != null) return;
    // Prüfmodus blockt Edit (Invariante: editMode + checkDone forbidden).
    // Findings-Apply-Pfad bleibt via saveCorrections, ohne contenteditable.
    if (this.checkDone) return;
    // viewer/lektor duerfen Page-HTML nicht direkt mutieren.
    // Defense-in-depth zum verstecken Button-Hide in editor.html.
    if (!this.canEdit()) return;
    this.editMode = true;
    this.editDirty = false;
    this.editSaving = false;
    this.saveOffline = false;
    this.pendingDraft = null;

    // Chromium/Safari-Default ist 'div' → Enter an bare Text oder am
    // Editor-Root erzeugt <div> statt <p>, damit fehlt der Absatz-Abstand
    // und der Fokus-Mode erkennt den Block nicht (BLOCK_TAGS ohne DIV).
    // Einmal pro Edit-Session genügt, der Flag ist dokumentweit.
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}

    let initialHtml = this.originalHtml;

    // Draft-Wiederherstellung: lokalen Entwurf immer übernehmen, wenn vorhanden
    // und abweichend. Kein Dialog – der User hat den Entwurf bewusst getippt,
    // ihn beim Wiedereintritt zu verwerfen wäre destruktiv.
    const draft = readDraft(this.currentPage.id);
    if (draft && draft.html && draft.html !== this.originalHtml) {
      initialHtml = draft.html;
      this.editDirty = true;
      this.lastDraftSavedAt = draft.savedAt || Date.now();
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
        this.editDirty = true;
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
    this._startPresenceHeartbeat?.(this.currentPage.id);
    // Soft-Edit-Lock: zusaetzliches UI-Signal mit Ablaufzeit; OCC-Pfad bleibt
    // das echte Safety-Net. Fremder Lock → foreignEditLock-Banner.
    this._acquireEditLock?.(this.currentPage.id);
    // Live-Counter rechnet in beiden Modi (für korrektes Tagesdelta beim
    // Wiedereintritt in den Focus), sichtbar aber nur im Focus-Header
    // (x-show=focusActive in editor.html). Setup nach Alpine-x-show-Flush —
    // .page-content-view--editing existiert vorher nicht im DOM.
    setTimeout(() => { if (this.editMode) installEditCounter(this); }, 0);
    // Snapshot für Reload-Wiederaufnahme. Pendant zu focus/storage.js —
    // beim regulären Exit (cancelEdit/saveEdit) wird er wieder gelöscht.
    writeNormalSnapshot(this.currentPage.id);
  },

  async cancelEdit() {
    if (this.editDirty) {
      const ok = await this.appConfirm({
        message: this.t('edit.cancelConfirm'),
        confirmLabel: this.t('edit.discardEdit'),
        danger: true,
      });
      if (!ok) return;
    }
    if (this.currentPage) clearDraft(this.currentPage.id);
    clearNormalSnapshot();
    this._stopAutosave();
    this._uninstallOnlineRetry();
    this._editCounterCtx?.teardown?.();
    this._stopPresenceHeartbeat?.();
    this._releaseEditLock?.(this.currentPage?.id);
    this.lastDraftSavedAt = null;
    this.editMode = false;
    this.editDirty = false;
    this.editSaving = false;
    this.saveOffline = false;
    this.pageEditorFullscreen = false;
    this.pageEditorFitWidth = false;
    this.pendingDraft = null;
    this.closeSynonymMenu?.();
    this.closeSynonymPicker?.();
    this.closeFigurLookup?.();
    this.updatePageView();
    if (this.focusActive) this.exitFocusMode();
  },

  async saveEdit() {
    if (!this.currentPage) return;
    if (!this.canEdit()) return;
    const el = this._getEditEl();
    if (!el) return;
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (isNoChange(newHtml, this.originalHtml)) {
      // Im Fokusmodus nicht aus Edit-/Fokusmodus herausfallen, wenn
      // der User ein zweites Mal Speichern klickt (nichts geändert).
      if (this.focusActive) {
        this.setStatus(this.t('edit.changesSaved'), false, 2000);
        return;
      }
      // editDirty kann durch startEdit-Normalize gesetzt sein, obwohl der
      // tatsächliche Inhalt sich nicht von normalizeForCompare(original)
      // unterscheidet. cancelEdit darf hier NICHT den Verwerfen-Dialog
      // zeigen — wir sind im Save-Flow, nicht im Cancel-Flow.
      this.editDirty = false;
      this.cancelEdit();
      return;
    }

    const newText = htmlToText(newHtml).trim();
    if (!newText) {
      this.setStatus(this.t('edit.emptyTextAbort'), false, 5000);
      return;
    }
    const origText = htmlToText(this.originalHtml || '').trim();
    if (origText.length > 50 && newText.length < origText.length * 0.2) {
      const okShort = await this.appConfirm({
        message: this.t('edit.shorterConfirm', { newLen: newText.length, oldLen: origText.length }),
      });
      if (!okShort) return;
    }

    const conflict = await this._checkPageConflict(this.currentPage.id, this.currentPage.updated_at);
    if (conflict) {
      this.editConflict = {
        remoteUserName: conflict.remoteUserName,
        remoteUpdatedAt: conflict.remoteUpdatedAt,
      };
      const okOverwrite = await this.appConfirm({
        message: this.t('edit.conflict.message', {
          user: conflict.remoteUserName || this.t('edit.conflict.unknownUser'),
          time: this.formatDate(conflict.remoteUpdatedAt),
        }),
        confirmLabel: this.t('edit.conflict.saveAnyway'),
        danger: true,
      });
      if (!okOverwrite) {
        writeDraft(this.currentPage.id, newHtml, this.originalHtml, this.currentPage.updated_at);
        this.lastDraftSavedAt = Date.now();
        this.saveOffline = true;
        this.setStatus(this.t('edit.conflict.kept'), false, 6000);
        return;
      }
    }

    this.editSaving = true;
    this.setStatus(this.t('edit.saving'), true);
    try {
      const saved = await contentRepo.savePage(this.currentPage.id, buildSavePayload({
        html: newHtml,
        pageName: this.currentPage.name,
        source: this.focusActive ? 'focus' : 'main',
        expectedUpdatedAt: this.currentPage.updated_at,
      }));
      if (saved?.updated_at) this.currentPage.updated_at = saved.updated_at;

      this.originalHtml = newHtml;
      this.currentPageEmpty = !htmlToText(newHtml).trim();

      this._filterFindingsAfterSave(newHtml);
      this._syncPageStatsAfterSave?.(this.currentPage, newHtml);
      // Sidebar-Lektorat-Status flippt auf 'warn' (updated_at > checkedAt) — Server-Map nachladen.
      this.refreshPageAges?.();

      clearDraft(this.currentPage.id);
      this.lastAutosaveAt = Date.now();
      this.lastDraftSavedAt = null;
      this.editDirty = false;
      this.saveOffline = false;
      this.editConflict = null;
      this.updatePageView();
      if (this.focusActive) {
        this.setStatus(this.t('edit.changesSaved'), false, 3000);
      } else {
        clearNormalSnapshot();
        this._stopAutosave();
        this._uninstallOnlineRetry();
        this._editCounterCtx?.teardown?.();
        this._stopPresenceHeartbeat?.();
        this._releaseEditLock?.(this.currentPage?.id);
        this.editMode = false;
        this.pageEditorFullscreen = false;
        this.pageEditorFitWidth = false;
        this.closeSynonymMenu?.();
        this.closeSynonymPicker?.();
        this.setStatus(this.t('edit.changesSaved'), false, 5000);
      }
    } catch (e) {
      if (isPageConflict(e)) {
        // Race: zwischen Pre-Check und PUT hat anderer User geschrieben.
        // Draft sichern + Conflict-Banner setzen; User muss erneut entscheiden.
        writeDraft(this.currentPage.id, newHtml, this.originalHtml, this.currentPage.updated_at);
        this.lastDraftSavedAt = Date.now();
        this.saveOffline = true;
        this.editConflict = readConflictBody(e);
        this.setStatus(this.t('edit.conflict.kept'), false, 8000);
        this.editSaving = false;
        return;
      }
      console.error('[saveEdit]', e);
      // Netzwerkfehler → Draft behalten, Offline-Modus aktivieren, Auto-Retry.
      writeDraft(this.currentPage.id, newHtml, this.originalHtml, this.currentPage.updated_at);
      this.lastDraftSavedAt = Date.now();
      this.saveOffline = true;
      if (!navigator.onLine) {
        this.setStatus(this.t('edit.offlineSaved'), false, 8000);
      } else {
        this.setStatus(this.t('edit.saveFailed', { msg: e.message }), false, 8000);
      }
    } finally {
      this.editSaving = false;
    }
  },

  // Stilles Speichern (Ctrl+S / Auto-Save): bleibt im Editor.
  async quickSave() {
    if (!this.editMode || !this.currentPage || this.editSaving) return;
    // Ohne Edit-Recht kein Auto-Save (Defense; startEdit blockt
    // ohnehin den Eintritt — aber Race mit Role-Refresh waehrend Edit-Session).
    if (!this.canEdit()) return;
    const el = this._getEditEl();
    if (!el) return;
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (isNoChange(newHtml, this.originalHtml)) {
      this.editDirty = false;
      clearDraft(this.currentPage.id);
      this.lastDraftSavedAt = null;
      return;
    }
    const newText = htmlToText(newHtml).trim();
    if (!newText) return;

    // Immer zuerst lokal sichern, dann erst Netzwerkversuch.
    writeDraft(this.currentPage.id, newHtml, this.originalHtml, this.currentPage.updated_at);
    this.lastDraftSavedAt = Date.now();

    const localeTag = (this.uiLocale === 'en') ? 'en-US' : 'de-CH';

    if (!navigator.onLine) {
      this.saveOffline = true;
      this.setStatus(this.t('edit.offlineSavedAt', { time: new Date().toLocaleTimeString(localeTag, tzOpts()) }), false, 3000);
      return;
    }

    // editSaving früh setzen — verhindert, dass parallele Auto-Save-Tick + Ctrl+S
    // (oder exitFocusMode-quickSave + Auto-Save-Timer) den gleichen PUT zweimal
    // absetzen. Vorher prüfte nur saveEdit dieses Flag, quickSave nicht.
    this.editSaving = true;
    try {
      // Silent-Path: Auto-Save / Pre-Send-Refresh dürfen keinen Modal triggern.
      // Bei Cross-User-Konflikt → Draft bleibt liegen, editConflict-Banner
      // im Editor-Header zeigt Hinweis (auch im Fokusmodus sichtbar). User
      // muss explizit Save-Button drücken (saveEdit), dort fragt appConfirm
      // dann nach Überschreiben.
      const conflict = await this._checkPageConflict(this.currentPage.id, this.currentPage.updated_at);
      if (conflict) {
        this.saveOffline = true;
        this.editConflict = {
          remoteUserName: conflict.remoteUserName,
          remoteUpdatedAt: conflict.remoteUpdatedAt,
        };
        this.setStatus(this.t('edit.conflict.unsavedHint', {
          user: conflict.remoteUserName || this.t('edit.conflict.unknownUser'),
        }), false, 8000);
        return;
      }
      const saved = await contentRepo.savePage(this.currentPage.id, buildSavePayload({
        html: newHtml,
        pageName: this.currentPage.name,
        source: this.focusActive ? 'focus' : 'main',
        expectedUpdatedAt: this.currentPage.updated_at,
      }));
      if (saved?.updated_at) this.currentPage.updated_at = saved.updated_at;
      this.originalHtml = newHtml;
      this.editDirty = false;
      this.saveOffline = false;
      this.editConflict = null;
      this.lastAutosaveAt = Date.now();
      this.lastDraftSavedAt = null;
      clearDraft(this.currentPage.id);
      this.currentPageEmpty = !htmlToText(newHtml).trim();
      this._filterFindingsAfterSave(newHtml);
      this._syncPageStatsAfterSave?.(this.currentPage, newHtml);
      // Sidebar-Lektorat-Status flippt auf 'warn' (updated_at > checkedAt) — Server-Map nachladen.
      this.refreshPageAges?.();
      this.updatePageView();
      this.setStatus(this.t('edit.savedAt', { time: new Date().toLocaleTimeString(localeTag, tzOpts()) }), false, 2500);
    } catch (e) {
      if (isPageConflict(e)) {
        // Race nach Pre-Check: anderer User war im selben Tick schneller.
        // Quiet-Pfad: Draft bleibt, Banner setzen, kein Modal.
        this.saveOffline = true;
        this.editConflict = readConflictBody(e);
        this.setStatus(this.t('edit.conflict.unsavedHint', {
          user: e.body?.server_editor_name || this.t('edit.conflict.unknownUser'),
        }), false, 8000);
        this.editSaving = false;
        return;
      }
      console.error('[quickSave]', e);
      this.saveOffline = true;
      this.setStatus(this.t('edit.saveFailedRetry'), false, 6000);
    } finally {
      this.editSaving = false;
    }
  },

  // Paste-Handler: Browser injiziert beim Paste (besonders aus anderen
  // BookStack-Seiten / Websites mit Lato) Computed-Styles inline auf jeden
  // Block. Ohne Sanitisierung landen `<p style="font-family:Lato;color:..."`-
  // Hüllen in der DB und überschreiben dort .poem & Co. Wir parsen das
  // Clipboard-HTML, kleinen es durch den gleichen Cleaner wie der Save-Pfad
  // und fügen sauber via execCommand ein.
  _onEditPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();

    const html = cd.getData('text/html');
    if (html) {
      document.execCommand('insertHTML', false, cleanContentArtefacts(html));
    } else {
      const text = cd.getData('text/plain') || '';
      if (text) document.execCommand('insertText', false, text);
    }
    this._markEditDirty();
  },

  _markEditDirty() {
    if (!this.editMode) return;
    this.editDirty = true;
    this._scheduleDraftSave();
    this._scheduleAutosave();
  },

  _scheduleDraftSave() {
    if (this._draftTimer) clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      this._draftTimer = null;
      this._flushDraftSaveNow();
    }, DRAFT_DEBOUNCE_MS);
  },

  // Schreibt den aktuellen Editor-Inhalt sofort als Draft – unabhängig vom
  // Debounce-Timer. Aufruf vor jedem Zustandsübergang, der den Editor-Inhalt
  // nicht mehr einfängt (Focus-Mode-Entry) oder ihn riskieren könnte zu
  // verlieren. Beim Aufruf nach Debounce-Fire ist _draftTimer bereits null
  // (ungefährlicher No-op).
  _flushDraftSaveNow() {
    if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
    if (!this.editMode || !this.currentPage) return;
    const el = this._getEditEl();
    if (!el) return;
    const html = stripLektoratMarks(el.innerHTML);
    if (isNoChange(html, this.originalHtml)) {
      clearDraft(this.currentPage.id);
      this.lastDraftSavedAt = null;
      return;
    }
    writeDraft(this.currentPage.id, html, this.originalHtml, this.currentPage.updated_at);
    this.lastDraftSavedAt = Date.now();
  },

  _startAutosave() {
    this._clearAutosaveTimers();
    if (this.editDirty) this._scheduleAutosave();
  },

  _stopAutosave() {
    this._clearAutosaveTimers();
    if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
  },

  _clearAutosaveTimers() {
    if (this._autosaveIdleTimer) { clearTimeout(this._autosaveIdleTimer); this._autosaveIdleTimer = null; }
    if (this._autosaveMaxTimer) { clearTimeout(this._autosaveMaxTimer); this._autosaveMaxTimer = null; }
  },

  // Idle-Timer wird bei jedem Edit zurückgesetzt → speichert erst nach
  // AUTOSAVE_IDLE_MS Tipp-Pause. Max-Timer läuft ab erstem Dirty-Mark
  // weiter und greift bei Dauer-Tippen, sodass spätestens AUTOSAVE_MAX_MS
  // nach der ersten Änderung ein Save ausgelöst wird.
  _scheduleAutosave() {
    if (this._autosaveIdleTimer) clearTimeout(this._autosaveIdleTimer);
    this._autosaveIdleTimer = setTimeout(() => this._fireAutosave(), AUTOSAVE_IDLE_MS);
    if (!this._autosaveMaxTimer) {
      this._autosaveMaxTimer = setTimeout(() => this._fireAutosave(), AUTOSAVE_MAX_MS);
    }
  },

  _fireAutosave() {
    this._clearAutosaveTimers();
    if (this.editMode && this.editDirty && !this.editSaving) this.quickSave();
  },

  _installOnlineRetry() {
    if (this._onlineHandler) return;
    this._onlineHandler = () => {
      if (this.editMode && this.editDirty && this.saveOffline) {
        this.quickSave();
      }
    };
    window.addEventListener('online', this._onlineHandler);
  },

  _uninstallOnlineRetry() {
    if (!this._onlineHandler) return;
    window.removeEventListener('online', this._onlineHandler);
    this._onlineHandler = null;
  },

  togglePageEditorFullscreen() {
    this.pageEditorFullscreen = !this.pageEditorFullscreen;
  },

  togglePageEditorFitWidth() {
    const next = !this.pageEditorFitWidth;
    if (next) {
      // Zoom so anpassen, dass Text bei aktiver Seitenbreite die volle
      // Wrap-Breite ausnutzt: ratio = Container / Reading-Frame.
      const el = this._getEditEl();
      const wrap = el?.closest('.page-editor-wrap');
      if (el && wrap) {
        const readingW = el.clientWidth;
        const containerW = wrap.clientWidth;
        if (readingW > 0 && containerW > readingW) {
          const ratio = containerW / readingW;
          this.pageEditorZoom = Math.min(2.5, Math.max(1, Math.round(ratio * 10) / 10));
        }
      }
    } else {
      this.pageEditorZoom = 1;
    }
    this.pageEditorFitWidth = next;
  },

  pageEditorZoomIn() {
    this.pageEditorZoom = Math.min(2.5, Math.round((this.pageEditorZoom + 0.1) * 100) / 100);
  },

  pageEditorZoomOut() {
    this.pageEditorZoom = Math.max(0.7, Math.round((this.pageEditorZoom - 0.1) * 100) / 100);
  },

  pageEditorZoomReset() {
    this.pageEditorZoom = 1;
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
