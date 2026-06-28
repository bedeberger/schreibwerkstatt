// Plot-Werkstatt: Beat-CRUD (flach + grid-zellen-granular), Verwerfen-Flag,
// Intensität/Figuren-Draft und Drag-&-Drop-Reordering über beide Pfade.

import { fetchJson } from '../../utils.js';

export const beatsMethods = {
  // ── Beat anlegen (flach + Grid-Zelle teilen den Kern) ───────────────────────
  // Flach: akt-only (thread_id null), Selektor `[data-add-beat-act]`, Add-Modus
  // über `addingActId`. Grid: zell-granular (thread_id gesetzt), Selektor
  // `[data-add-beat-cell]`, Add-Modus über `addingCell`. Die öffentlichen Methoden
  // (von den Partials referenziert) bleiben dünn und delegieren an die Kerne.

  // Das Eingabefeld einer Add-Zone refokussieren (nach dem Stapeln eines Beats).
  _focusAddInput(scopeSelector) {
    this.$root?.querySelector(`${scopeSelector} .plot-add-beat-input`)?.focus();
  },

  // Gemeinsamer Speicherpfad. cancel/refocus/close kapseln den einzigen
  // Unterschied (addingActId vs addingCell). threadId === null im flachen Pfad.
  async _createBeatInline({ actId, threadId, keepAdding, cancel, refocus, close }) {
    const app = window.__app;
    const titel = (this.newBeatTitel || '').trim();
    if (!titel) { cancel(); return; }
    this.busy = true;
    try {
      const beat = await fetchJson('/plot/beats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, act_id: actId, thread_id: threadId ?? null, titel }),
      });
      this.beats = [...this.beats, beat];
      this._memos = {};
      this.newBeatTitel = '';
      this.errorMessage = '';
      if (keepAdding) this.$nextTick(refocus); else close();
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  // Auto-Save beim Verlassen des Eingabefelds (analog Akt-Umbenennen). NICHT
  // speichern, wenn der Fokus auf die Add-Buttons (Hinzufügen/Abbrechen) oder ins
  // LanguageTool-Badge/-Popover wandert — die behandeln den Klick selbst bzw. der
  // User korrigiert gerade Rechtschreibung. Leeres Feld → Add-Modus nur schliessen.
  //
  // Der Spellcheck-Dispatcher wickelt das Feld beim Fokus in ein
  // <span class="lt-field-wrap"> — der DOM-Move feuert ein synchrones blur,
  // obwohl der Fokus unmittelbar danach wiederhergestellt wird. Würde blur sofort
  // canceln (leeres Feld beim ersten Klick), blendete das x-if das Input direkt
  // wieder aus und der User kann gar nichts eingeben. Darum eine Frame deferren und
  // nur reagieren, wenn der Fokus das Feld wirklich verlassen hat (analog onActBlur).
  _deferAddBeatBlur(ev, isActive, cancel, save) {
    if (this.busy || !isActive()) return;
    const to = ev?.relatedTarget;
    if (to?.closest?.('.plot-add-beat-actions, .lt-badge, .lt-popover')) return;
    if (document.querySelector('.lt-popover')) return;
    const input = ev?.target || null;
    requestAnimationFrame(() => {
      if (this.busy || !isActive()) return;
      if (input && document.activeElement === input) return;
      if (!(this.newBeatTitel || '').trim()) { cancel(); return; }
      save();
    });
  },

  // ── Flaches Board (akt-only) ────────────────────────────────────────────────
  startAddBeat(actId) {
    this.addingActId = actId;
    this.newBeatTitel = '';
    this.$nextTick(() => this._focusAddInput(`[data-add-beat-act="${actId}"]`));
  },
  cancelAddBeat() { this.addingActId = null; this.newBeatTitel = ''; },

  // keepAdding=true (Enter / „Hinzufügen"): Feld leeren + refokussieren zum
  // schnellen Stapeln. keepAdding=false (Blur): speichern + Add-Modus schliessen.
  saveNewBeat(actId, { keepAdding = true } = {}) {
    return this._createBeatInline({
      actId, threadId: null, keepAdding,
      cancel: () => this.cancelAddBeat(),
      refocus: () => this._focusAddInput(`[data-add-beat-act="${actId}"]`),
      close: () => { this.addingActId = null; },
    });
  },

  onAddBeatBlur(actId, ev) {
    this._deferAddBeatBlur(ev,
      () => this.addingActId === actId,
      () => this.cancelAddBeat(),
      () => this.saveNewBeat(actId, { keepAdding: false }));
  },

  // ── Grid-Zelle (Akt × Strang) ───────────────────────────────────────────────
  // addingCell ist der Zell-Schlüssel `${actId}:${threadId|null}`.
  _cellKey(actId, threadId) { return `${actId}:${threadId == null ? 'null' : threadId}`; },

  startAddBeatCell(actId, threadId) {
    this.addingCell = this._cellKey(actId, threadId);
    this.newBeatTitel = '';
    this.$nextTick(() => this._focusAddInput(`[data-add-beat-cell="${this.addingCell}"]`));
  },
  cancelAddBeatCell() { this.addingCell = null; this.newBeatTitel = ''; },

  saveNewBeatCell(actId, threadId, { keepAdding = true } = {}) {
    return this._createBeatInline({
      actId, threadId: threadId ?? null, keepAdding,
      cancel: () => this.cancelAddBeatCell(),
      refocus: () => this._focusAddInput(`[data-add-beat-cell="${this._cellKey(actId, threadId)}"]`),
      close: () => { this.addingCell = null; },
    });
  },

  onAddBeatCellBlur(actId, threadId, ev) {
    const key = this._cellKey(actId, threadId);
    this._deferAddBeatBlur(ev,
      () => this.addingCell === key,
      () => this.cancelAddBeatCell(),
      () => this.saveNewBeatCell(actId, threadId, { keepAdding: false }));
  },

  startEditBeat(beat) {
    this.editingBeatId = beat.id;
    // Root-SSoT für den Beat-Permalink (#book/X/plot/<beatId>) spiegeln.
    if (window.__app) window.__app.plotBeatId = beat.id;
    this.beatDraft = {
      titel: beat.titel || '',
      beschreibung: beat.beschreibung || '',
      status: beat.status || 'geplant',
      chapter_id: beat.chapter_id || '',
      intensitaet: beat.intensitaet || null,
      figure_ids: [...(beat.fig_ids || [])],
      draft_figure_ids: [...(beat.draft_fig_ids || [])],
    };
  },
  cancelEditBeat() { this.editingBeatId = null; if (window.__app) window.__app.plotBeatId = null; },

  // Klick ausserhalb des Edit-Panels: Änderungen committen (wie Save) und dann
  // schliessen. Leerer Titel → nichts Sinnvolles zu speichern, einfach verwerfen
  // (saveEditBeat würde sonst mit Fehler offen bleiben).
  async commitEditBeat(beat) {
    if (!(this.beatDraft.titel || '').trim()) { this.cancelEditBeat(); return; }
    await this.saveEditBeat(beat);
  },

  // Deep-Link-Ziel öffnen: Beat suchen → Edit + zentriert ins Bild. Noch nicht
  // geladenes Board → ID merken, loadBoard() ruft uns danach erneut auf.
  _focusBeatById(rawId) {
    const id = parseInt(rawId);
    if (!Number.isInteger(id)) return;
    const beat = (this.beats || []).find(b => b.id === id);
    if (!beat) { this._pendingFocusBeatId = id; return; }
    this.startEditBeat(beat);
    this.$nextTick(() => this.scrollToBeat(id));
  },

  intensitaetScale() { return [1, 2, 3, 4, 5]; },

  // Intensität setzen — erneuter Klick auf den aktiven Wert löscht ihn (null).
  setBeatDraftIntensitaet(n) {
    this.beatDraft.intensitaet = (this.beatDraft.intensitaet === n) ? null : n;
  },

  toggleBeatDraftFigure(figId) {
    const set = new Set(this.beatDraft.figure_ids);
    if (set.has(figId)) set.delete(figId); else set.add(figId);
    this.beatDraft.figure_ids = [...set];
  },

  // Werkstatt-Figur (draft_figures.id, INTEGER) im Beat an-/abwählen.
  toggleBeatDraftWerkstattFigure(draftId) {
    const set = new Set(this.beatDraft.draft_figure_ids);
    if (set.has(draftId)) set.delete(draftId); else set.add(draftId);
    this.beatDraft.draft_figure_ids = [...set];
  },

  async saveEditBeat(beat) {
    const app = window.__app;
    const titel = (this.beatDraft.titel || '').trim();
    if (!titel) { this.errorMessage = app.t('plot.error.titelRequired'); return; }
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/beats/${beat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titel,
          beschreibung: this.beatDraft.beschreibung || '',
          status: this.beatDraft.status,
          chapter_id: this.beatDraft.chapter_id ? parseInt(this.beatDraft.chapter_id) : null,
          intensitaet: this.beatDraft.intensitaet || null,
          figure_ids: this.beatDraft.figure_ids,
          draft_figure_ids: this.beatDraft.draft_figure_ids,
        }),
      });
      this._replaceBeat(updated);
      this.editingBeatId = null;
      if (window.__app) window.__app.plotBeatId = null;
      this.errorMessage = '';
      // Kapitel-Zuweisung kann sich geändert haben → Editor-Indikator syncen.
      app.refreshPlotBeatCounts?.();
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  // Verwerfen-Flag umschalten (eigene Achse, unabhängig vom Status). Sofort
  // persistiert — funktioniert aus Ansicht und Edit-Panel.
  async toggleBeatVerworfen(beat) {
    const app = window.__app;
    try {
      const updated = await fetchJson(`/plot/beats/${beat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verworfen: beat.verworfen ? 0 : 1 }),
      });
      this._replaceBeat(updated);
      // Verwerfen ändert, ob der Beat in den Page-Count zählt → Indikator syncen.
      app.refreshPlotBeatCounts?.();
    } catch (e) { this.errorMessage = app.t('plot.error.save'); }
  },

  async deleteBeat(beat) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('plot.confirmDeleteBeat', { titel: beat.titel }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/plot/beats/${beat.id}`, { method: 'DELETE' });
      this.beats = this.beats.filter(b => b.id !== beat.id);
      this._memos = {};
      if (this.editingBeatId === beat.id) { this.editingBeatId = null; if (window.__app) window.__app.plotBeatId = null; }
      this.errorMessage = '';
      // Gelöschter Beat kann ein Kapitel-Count gewesen sein → Indikator syncen.
      app.refreshPlotBeatCounts?.();
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
    } finally { this.busy = false; }
  },

  _replaceBeat(row) {
    this.beats = this.beats.map(b => (b.id === row.id ? row : b));
    this._memos = {};
  },

  // ── Drop-Mechanik (von SortableJS via dnd.js#onBeatSortEnd aufgerufen) ──────
  // Verschiebt den gezogenen Beat (this._dragBeatId) in die Ziel-Zelle (Akt ×
  // Strang; threadId null = „ohne Strang"), nummeriert Ziel- und Quell-Zelle neu
  // und persistiert nur die betroffenen Zellen. SortableJS' physischer DOM-Move
  // ist vor dem Aufruf bereits revertet — hier mutiert allein das Modell, Alpine
  // x-for rendert daraus neu.
  async _dropBeat(targetActId, targetThreadId, beforeBeatId = null) {
    const beatId = this._dragBeatId;
    if (beatId == null) return;
    const beat = this.beats.find(b => b.id === beatId);
    if (!beat) { this._dragBeatId = null; return; }
    const origActId = beat.act_id;
    const origThreadId = beat.thread_id ?? null;
    const tid = targetThreadId ?? null;
    if (beforeBeatId === beatId) { this._dragBeatId = null; return; }

    const target = this.beatsForCell(targetActId, tid).filter(b => b.id !== beatId);
    let insertIdx = target.length;
    if (beforeBeatId != null) {
      const i = target.findIndex(b => b.id === beforeBeatId);
      if (i >= 0) insertIdx = i;
    }
    beat.act_id = targetActId;
    beat.thread_id = tid;
    target.splice(insertIdx, 0, beat);
    target.forEach((b, i) => { b.sort_order = i; });
    // Quell-Zelle (falls verschieden) neu durchnummerieren.
    const sameCell = origActId === targetActId && origThreadId === tid;
    if (!sameCell) {
      this.beats
        .filter(b => b.act_id === origActId && (b.thread_id ?? null) === origThreadId && b.id !== beatId)
        .sort((a, b) => a.sort_order - b.sort_order)
        .forEach((b, i) => { b.sort_order = i; });
    }
    this.beats = [...this.beats];
    this._memos = {};
    this._dragBeatId = null;

    const cells = sameCell
      ? [{ actId: targetActId, threadId: tid }]
      : [{ actId: origActId, threadId: origThreadId }, { actId: targetActId, threadId: tid }];
    await this._persistCells(cells);
  },

  async _persistCells(cells) {
    const app = window.__app;
    const order = cells.map(({ actId, threadId }) => ({
      actId,
      threadId: threadId ?? null,
      beatIds: this.beatsForCell(actId, threadId ?? null).map(b => b.id),
    }));
    try {
      await fetchJson('/plot/beats/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, order }),
      });
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      this.loadBoard(); // Server-Stand wiederherstellen
    }
  },
};
