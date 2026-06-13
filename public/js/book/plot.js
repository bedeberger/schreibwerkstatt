// Methoden für die Plot-Werkstatt (Beat-Board). Planendes Welt-/Plot-Werkzeug:
// Akte (Spalten) + Beats (Karten) pro Buch + User. CRUD, Drag-&-Drop-Reordering
// und zwei KI-Jobs (Brainstorm + Consistency) — die KI plant/prüft nur die
// Struktur, schreibt nie Fliesstext ins Manuskript.

import { fetchJson } from '../utils.js';
import { startPoll, runningJobStatus } from '../cards/job-helpers.js';
import { toggleWrapFullscreen } from '../fullscreen.js';

const STATUSES = ['geplant', 'entwurf', 'im_buch', 'verworfen'];

// Akt-Farbpalette: Schlüssel referenzieren die theme-aware --palette-*-Tokens
// (tokens/colors.css, geteilt mit der Figuren-Palette). In plot_acts.farbe wird
// nur der Schlüssel gespeichert; actAccent() baut daraus die CSS-Variable und
// fällt bei unbekanntem/leerem Wert auf den Karten-Akzent zurück (kein Inline-Hue).
const ACT_PALETTE = ['blue', 'green', 'amber', 'orange', 'red', 'wine', 'pink', 'purple', 'brown', 'gray'];

// Intensität → vertikale Position im Spannungsband (10–90 %, etwas Rand oben/unten).
const _intensityBottomPct = (i) => 10 + ((i - 1) / 4) * 80;

export const plotMethods = {
  // ── Memo-Helper (ein Helper pro Modul, Array-Deps shallow ===) ─────────────
  _memo(key, deps, fn) {
    const cache = (this._memos = this._memos || {});
    const prev = cache[key];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
      return prev.val;
    }
    const val = fn();
    cache[key] = { deps, val };
    return val;
  },

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async loadBoard() {
    const app = window.__app;
    const bookId = app.selectedBookId;
    if (!bookId) { this.acts = []; this.threads = []; this.beats = []; this.draftFiguren = []; return; }
    this.loading = true;
    this._memos = {};
    try {
      const data = await fetchJson(`/plot?book_id=${bookId}`);
      this.acts = Array.isArray(data.acts) ? data.acts : [];
      this.threads = Array.isArray(data.threads) ? data.threads : [];
      this.beats = Array.isArray(data.beats) ? data.beats : [];
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.load');
      this.acts = []; this.threads = []; this.beats = [];
    } finally {
      this.loading = false;
    }
    // Werkstatt-Figuren separat laden — ein Fehler hier darf das Board nicht
    // leeren (Board ist die Primärdaten, Drafts nur Beilage fürs Picker/Badge).
    // draftFigurenById (Getter in plot-card.js) baut sich aus der neuen Referenz neu.
    try {
      const drafts = await fetchJson(`/draft-figures/${bookId}`);
      this.draftFiguren = Array.isArray(drafts) ? drafts : [];
    } catch (e) {
      this.draftFiguren = [];
    }
  },

  resetPlot() {
    this._clearJobs();
    this.acts = [];
    this.threads = [];
    this.beats = [];
    this.draftFiguren = [];
    this._memos = {};
    this.editingBeatId = null;
    this.addingActId = null;
    this.addingCell = null;
    this.newBeatTitel = '';
    this.editingActId = null;
    this.actDraft = '';
    this.addingAct = false;
    this.newActName = '';
    this.editingThreadId = null;
    this.addingThread = false;
    this.newThreadName = '';
    this.threadColorPickerId = null;
    this._dragBeatId = null;
    this._dragOverActId = null;
    this._dragOverCell = null;
    this.brainstormResult = null;
    this.brainstormActId = null;
    this.brainstormThreadId = null;
    this.consistencyResult = null;
    this.selectedKonfliktIdx = null;
    this.plotFilters = { kapitel: '', figurId: '', draftFigurId: '' };
    this.verworfenOpen = {};
    this.actColorPickerId = null;
    this.errorMessage = '';
    this.busy = false;
  },

  // ── Derived (memoized) ──────────────────────────────────────────────────────
  beatsForAct(actId) {
    return this._memo(`beats:${actId}`, [this.beats, actId], () =>
      (this.beats || [])
        .filter(b => b.act_id === actId)
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
    );
  },

  // Beats einer Grid-Zelle (Akt × Strang). threadId === null = „ohne Strang"-Lane.
  // Im Grid-Pfad das Pendant zu beatsForAct.
  beatsForCell(actId, threadId) {
    const tid = threadId == null ? null : threadId;
    return this._memo(`cell:${actId}:${tid}`, [this.beats, actId, tid], () =>
      (this.beats || [])
        .filter(b => b.act_id === actId && (b.thread_id ?? null) === tid)
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
    );
  },

  boardStats() {
    return this._memo('stats', [this.beats], () => this._computeStats(this.beats || []));
  },

  // Status-Zählung über eine Beat-Liste (board-weit oder pro Akt). imBuch/geplant
  // bleiben als Top-Level-Felder erhalten (von plot.stats-i18n konsumiert).
  _computeStats(list) {
    const by = { geplant: 0, entwurf: 0, im_buch: 0, verworfen: 0 };
    for (const b of list) if (by[b.status] != null) by[b.status]++;
    return { total: list.length, by, imBuch: by.im_buch, geplant: by.geplant };
  },

  // Pro-Akt-Status-Verteilung (für die Mini-Fortschrittsleiste im Spaltenkopf).
  actStats(actId) {
    return this._memo(`astats:${actId}`, [this.beats, actId], () =>
      this._computeStats((this.beats || []).filter(b => b.act_id === actId)));
  },

  statusList() { return STATUSES; },

  // ── Stränge (Swimlanes, Derived) ───────────────────────────────────────────
  // Zeilen des Grids: Stränge in Position-Reihenfolge + die „ohne Strang"-Lane
  // (id null) immer am Ende — sie ist Drop-Ziel zum Entkoppeln und fängt alle
  // nicht zugeordneten Beats.
  threadLanes() {
    return this._memo('lanes', [this.threads], () => {
      const rows = [...(this.threads || [])]
        .sort((a, b) => a.position - b.position)
        .map(t => ({ id: t.id, thread: t, isDefault: false }));
      rows.push({ id: null, thread: null, isDefault: true });
      return rows;
    });
  },

  // CSS-Akzent eines Strangs (gleiche Palette-Whitelist wie actAccent).
  threadAccent(thread) {
    const key = thread && thread.farbe;
    return (key && ACT_PALETTE.includes(key)) ? `var(--palette-${key})` : 'var(--card-accent)';
  },

  // Anzeigename der an den Strang gebundenen Figur (Katalog via fig_id, sonst
  // Werkstatt via draft_figure_id). Leer, wenn keine Figur gebunden.
  threadFigureLabel(thread) {
    if (!thread) return '';
    if (thread.fig_id) {
      const f = window.__app.figurenById?.get(thread.fig_id);
      return f ? (f.kurzname || f.name) : '';
    }
    if (thread.draft_figure_id) {
      const d = this.draftFigurenById?.get(thread.draft_figure_id);
      return d ? d.name : '';
    }
    return '';
  },

  // ── Akt-Farben ───────────────────────────────────────────────────────────
  actPalette() { return ACT_PALETTE; },

  // CSS-Wert für den Akt-Akzent: bekannter Palette-Key → --palette-<key>,
  // sonst Karten-Akzent. Whitelist verhindert CSS-Injection aus dem Freitextfeld.
  actAccent(act) {
    const key = act && act.farbe;
    return (key && ACT_PALETTE.includes(key)) ? `var(--palette-${key})` : 'var(--card-accent)';
  },

  toggleActColorPicker(actId) {
    this.actColorPickerId = this.actColorPickerId === actId ? null : actId;
  },

  async setActColor(act, key) {
    const app = window.__app;
    this.actColorPickerId = null;
    const farbe = ACT_PALETTE.includes(key) ? key : null;
    if (farbe === (act.farbe || null)) return;
    try {
      const updated = await fetchJson(`/plot/acts/${act.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farbe }),
      });
      this.acts = this.acts.map(a => (a.id === updated.id ? updated : a));
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    }
  },

  // ── Spannungsbogen ─────────────────────────────────────────────────────────
  // Beats mit gesetzter Intensität (verworfene zählen nicht — sie formen den
  // Bogen nicht) in Board-Lesereihenfolge (Akt-Position → sort_order) zu einer
  // Kurve. Punkte als Prozent-Koordinaten + Polyline-String für die SVG-Linie.
  tensionCurve() {
    return this._memo('tension', [this.beats, this.acts, this.threads], () => {
      const actPos = new Map((this.acts || []).map(a => [a.id, a.position]));
      const actById = new Map((this.acts || []).map(a => [a.id, a]));
      const order = (a, b) =>
        ((actPos.get(a.act_id) ?? 0) - (actPos.get(b.act_id) ?? 0)) ||
        (a.sort_order - b.sort_order) || (a.id - b.id);

      // Eine Punkt-Reihe aus einer Beat-Teilmenge (verworfene + ohne Intensität raus).
      const _line = (subset, color) => {
        const seq = subset
          .filter(b => b.status !== 'verworfen' && b.intensitaet != null)
          .sort(order);
        const n = seq.length;
        const pts = seq.map((b, k) => {
          const xPct = n === 1 ? 50 : +(5 + (k / (n - 1)) * 90).toFixed(2);
          const bottomPct = +_intensityBottomPct(b.intensitaet).toFixed(2);
          return {
            beat: b, act: actById.get(b.act_id) || null, color,
            xPct, bottomPct, xSvg: xPct, ySvg: +(100 - bottomPct).toFixed(2),
          };
        });
        return { points: pts, polyline: pts.map(p => `${p.xSvg},${p.ySvg}`).join(' '), count: n };
      };

      // Globale Kurve (alle Beats, Akt-Akzent pro Punkt) — Board ohne Stränge.
      const all = (this.beats || []).filter(b => b.status !== 'verworfen' && b.intensitaet != null).sort(order);
      const nAll = all.length;
      const points = all.map((b, k) => {
        const act = actById.get(b.act_id) || null;
        const xPct = nAll === 1 ? 50 : +(5 + (k / (nAll - 1)) * 90).toFixed(2);
        const bottomPct = +_intensityBottomPct(b.intensitaet).toFixed(2);
        return { beat: b, act, color: this.actAccent(act), xPct, bottomPct, xSvg: xPct, ySvg: +(100 - bottomPct).toFixed(2) };
      });

      // Pro-Strang-Serien (nur wenn Stränge existieren) — je Strang eine eigene
      // farbige Polyline. Leere Stränge fallen raus.
      const series = (this.threads || [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map(t => {
          const line = _line((this.beats || []).filter(b => b.thread_id === t.id), this.threadAccent(t));
          return { key: `t${t.id}`, thread: t, label: t.name, ...line };
        })
        .filter(s => s.count >= 1);

      return { points, polyline: points.map(p => `${p.xSvg},${p.ySvg}`).join(' '), count: nAll, series };
    });
  },

  // ── Verworfen-Collapse (pro Akt) ────────────────────────────────────────────
  // Verworfene Beats werden eingeklappt, damit sie die Spalte nicht aufblähen;
  // ein „+N verworfen"-Toggle blendet sie ein. Drag/Reorder bleibt unberührt
  // (operiert weiter auf beatsForAct/filteredBeatsForAct mit allen Beats).
  visibleBeatsForAct(actId) {
    const base = this.filteredBeatsForAct(actId);
    if (this.verworfenOpen[actId]) return base;
    return this._memo(`vbeats:${actId}`, [base], () => base.filter(b => b.status !== 'verworfen'));
  },

  verworfenCountForAct(actId) {
    return this.filteredBeatsForAct(actId).filter(b => b.status === 'verworfen').length;
  },

  toggleVerworfen(actId) {
    this.verworfenOpen = { ...this.verworfenOpen, [actId]: !this.verworfenOpen[actId] };
  },

  // ── Filter (Kapitel / Figur) ───────────────────────────────────────────────
  // Kapitel-Optionen aus den Beats ableiten (buchgeordnet via Root-Helper),
  // damit nur Kapitel angeboten werden, die im Board überhaupt vorkommen.
  plotKapitelListe() {
    return window.__app._deriveKapitel(this.beats, b => b.chapter_name);
  },

  plotFilterActive() {
    return !!(this.plotFilters.kapitel || this.plotFilters.figurId || this.plotFilters.draftFigurId);
  },

  _beatMatchesFilter(b) {
    const f = this.plotFilters;
    // draftFigurId kommt aus der Combobox als Roh-Value (INTEGER) — String-
    // koerziert vergleichen, da draft_fig_ids INTEGER sind.
    return (!f.kapitel || b.chapter_name === f.kapitel) &&
           (!f.figurId || (b.fig_ids || []).includes(f.figurId)) &&
           (!f.draftFigurId || (b.draft_fig_ids || []).map(String).includes(String(f.draftFigurId)));
  },

  // Gefilterte Beats pro Akt — nur fürs Rendering. Ohne aktiven Filter wird der
  // (bereits memoisierte) ungefilterte beatsForAct-Array unverändert durchgereicht.
  filteredBeatsForAct(actId) {
    const f = this.plotFilters;
    const base = this.beatsForAct(actId);
    if (!f.kapitel && !f.figurId && !f.draftFigurId) return base;
    return this._memo(`fbeats:${actId}`, [base, f.kapitel, f.figurId, f.draftFigurId], () =>
      base.filter(b => this._beatMatchesFilter(b)));
  },

  filteredBeatCount() {
    const f = this.plotFilters;
    return this._memo('fcount', [this.beats, f.kapitel, f.figurId, f.draftFigurId], () =>
      (this.beats || []).filter(b => this._beatMatchesFilter(b)).length);
  },

  // Gefilterte Beats einer Grid-Zelle — Pendant zu filteredBeatsForAct. Anders als
  // der flache Akt-Pfad gibt es im Grid keinen Verworfen-Collapse (Zellen sind klein,
  // verworfene Beats bleiben sichtbar/durchgestrichen).
  filteredBeatsForCell(actId, threadId) {
    const f = this.plotFilters;
    const base = this.beatsForCell(actId, threadId);
    if (!f.kapitel && !f.figurId && !f.draftFigurId) return base;
    const tid = threadId == null ? null : threadId;
    return this._memo(`fcell:${actId}:${tid}`, [base, f.kapitel, f.figurId, f.draftFigurId], () =>
      base.filter(b => this._beatMatchesFilter(b)));
  },

  // ── Akte ─────────────────────────────────────────────────────────────────
  async addAct() {
    const app = window.__app;
    const name = (this.newActName || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    this.busy = true;
    try {
      const act = await fetchJson('/plot/acts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, name }),
      });
      this.acts = [...this.acts, act];
      this.newActName = '';
      this.addingAct = false;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  startEditAct(act) {
    this.editingActId = act.id;
    this.actDraft = act.name;
    // Flaches Board + Grid sind beide im DOM (eines via x-show versteckt) — die
    // sichtbare Titel-Eingabe fokussieren, nicht die display:none-Variante.
    this.$nextTick(() => {
      const inputs = [...(this.$root?.querySelectorAll('.plot-column-title-input') || [])];
      (inputs.find(el => el.offsetParent !== null) || inputs[0])?.focus();
    });
  },
  cancelEditAct() { this.editingActId = null; this.actDraft = ''; },

  // Der Spellcheck-Dispatcher wickelt das Feld beim Fokus in ein
  // <span class="lt-field-wrap"> — der DOM-Move feuert ein synchrones blur,
  // obwohl der Fokus unmittelbar danach wiederhergestellt wird. Würde blur
  // sofort speichern, liefe saveEditAct → cancelEditAct und das x-if blendete
  // das Input direkt beim ersten Klick wieder aus. Darum eine Frame deferren und
  // nur speichern, wenn der Fokus das Feld wirklich verlassen hat.
  onActBlur(act, ev) {
    const input = ev?.target || null;
    requestAnimationFrame(() => {
      if (input && document.activeElement === input) return;
      this.saveEditAct(act);
    });
  },

  async saveEditAct(act) {
    const app = window.__app;
    const name = (this.actDraft || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    if (name === act.name) { this.cancelEditAct(); return; }
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/acts/${act.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.acts = this.acts.map(a => (a.id === updated.id ? updated : a));
      this.editingActId = null;
      this.actDraft = '';
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  async deleteAct(act) {
    const app = window.__app;
    const beatCount = this.beatsForAct(act.id).length;
    if (!await app.appConfirm({
      message: app.t('plot.confirmDeleteAct', { name: act.name, n: beatCount }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/plot/acts/${act.id}`, { method: 'DELETE' });
      this.acts = this.acts.filter(a => a.id !== act.id);
      this.beats = this.beats.filter(b => b.act_id !== act.id);
      this._memos = {};
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
    } finally { this.busy = false; }
  },

  // Akt-Reihenfolge per Pfeil-Button verschieben (a11y statt Drag der Spalten).
  async moveAct(act, dir) {
    const app = window.__app;
    const ordered = [...this.acts].sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex(a => a.id === act.id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ordered.length) return;
    [ordered[idx], ordered[swap]] = [ordered[swap], ordered[idx]];
    ordered.forEach((a, i) => { a.position = i; });
    this.acts = ordered;
    try {
      await fetchJson('/plot/acts/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, order: ordered.map(a => a.id) }),
      });
    } catch (e) { this.errorMessage = app.t('plot.error.save'); }
  },

  // ── Stränge (Swimlanes, CRUD) ───────────────────────────────────────────────
  async addThread() {
    const app = window.__app;
    const name = (this.newThreadName || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    this.busy = true;
    try {
      const thread = await fetchJson('/plot/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, name }),
      });
      this.threads = [...this.threads, thread];
      this._memos = {};
      this.newThreadName = '';
      this.addingThread = false;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  startEditThread(thread) {
    this.editingThreadId = thread.id;
    this.threadColorPickerId = null;
    this.threadDraft = {
      name: thread.name || '',
      farbe: thread.farbe || null,
      // Katalog-Bindung wird als TEXT-fig_id geführt (matcht $app.figuren),
      // Werkstatt-Bindung als INTEGER draft_figures.id.
      figure_id: thread.fig_id || '',
      draft_figure_id: thread.draft_figure_id || '',
    };
    this.$nextTick(() => { this.$root?.querySelector('.plot-thread-name-input')?.focus(); });
  },
  cancelEditThread() { this.editingThreadId = null; },

  // Bindung ist exklusiv: eine Strang-Zeile gehört zu höchstens einer Figur.
  setThreadDraftFigure(figId) {
    this.threadDraft.figure_id = (this.threadDraft.figure_id === figId) ? '' : figId;
    if (this.threadDraft.figure_id) this.threadDraft.draft_figure_id = '';
  },
  setThreadDraftDraftFigure(draftId) {
    this.threadDraft.draft_figure_id = (this.threadDraft.draft_figure_id === draftId) ? '' : draftId;
    if (this.threadDraft.draft_figure_id) this.threadDraft.figure_id = '';
  },

  async saveEditThread(thread) {
    const app = window.__app;
    const name = (this.threadDraft.name || '').trim();
    if (!name) { this.errorMessage = app.t('plot.error.nameRequired'); return; }
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/threads/${thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          farbe: this.threadDraft.farbe || null,
          figure_id: this.threadDraft.figure_id || null,
          draft_figure_id: this.threadDraft.draft_figure_id || null,
        }),
      });
      this.threads = this.threads.map(t => (t.id === updated.id ? updated : t));
      this._memos = {};
      this.editingThreadId = null;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  toggleThreadColorPicker(threadId) {
    this.threadColorPickerId = this.threadColorPickerId === threadId ? null : threadId;
  },

  async setThreadColor(thread, key) {
    const app = window.__app;
    this.threadColorPickerId = null;
    const farbe = ACT_PALETTE.includes(key) ? key : null;
    if (farbe === (thread.farbe || null)) return;
    try {
      const updated = await fetchJson(`/plot/threads/${thread.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ farbe }),
      });
      this.threads = this.threads.map(t => (t.id === updated.id ? updated : t));
      this._memos = {};
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    }
  },

  async deleteThread(thread) {
    const app = window.__app;
    const beatCount = (this.beats || []).filter(b => b.thread_id === thread.id).length;
    if (!await app.appConfirm({
      message: app.t('plot.thread.confirmDelete', { name: thread.name, n: beatCount }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/plot/threads/${thread.id}`, { method: 'DELETE' });
      this.threads = this.threads.filter(t => t.id !== thread.id);
      // Server setzt thread_id der Beats auf NULL (SET NULL) — lokal spiegeln,
      // die Beats fallen in die „ohne Strang"-Lane.
      this.beats = this.beats.map(b => (b.thread_id === thread.id ? { ...b, thread_id: null } : b));
      this._memos = {};
      if (this.editingThreadId === thread.id) this.editingThreadId = null;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
    } finally { this.busy = false; }
  },

  // Strang-Reihenfolge per Pfeil-Button (a11y, analog moveAct).
  async moveThread(thread, dir) {
    const app = window.__app;
    const ordered = [...this.threads].sort((a, b) => a.position - b.position);
    const idx = ordered.findIndex(t => t.id === thread.id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ordered.length) return;
    [ordered[idx], ordered[swap]] = [ordered[swap], ordered[idx]];
    ordered.forEach((t, i) => { t.position = i; });
    this.threads = ordered;
    this._memos = {};
    try {
      await fetchJson('/plot/threads/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, order: ordered.map(t => t.id) }),
      });
    } catch (e) { this.errorMessage = app.t('plot.error.save'); }
  },

  // ── Beats ──────────────────────────────────────────────────────────────────
  startAddBeat(actId) {
    this.addingActId = actId;
    this.newBeatTitel = '';
    this.$nextTick(() => {
      const el = this.$root?.querySelector(`[data-add-beat-act="${actId}"] .plot-add-beat-input`);
      el?.focus();
    });
  },
  cancelAddBeat() { this.addingActId = null; this.newBeatTitel = ''; },

  // keepAdding=true (Enter / „Hinzufügen"): Feld leeren + refokussieren zum
  // schnellen Stapeln. keepAdding=false (Verlassen via Blur): speichern und den
  // Add-Modus schliessen, ohne den Fokus zurückzureissen.
  async saveNewBeat(actId, { keepAdding = true } = {}) {
    const app = window.__app;
    const titel = (this.newBeatTitel || '').trim();
    if (!titel) { this.cancelAddBeat(); return; }
    this.busy = true;
    try {
      const beat = await fetchJson('/plot/beats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, act_id: actId, titel }),
      });
      this.beats = [...this.beats, beat];
      this._memos = {};
      this.newBeatTitel = '';
      this.errorMessage = '';
      if (keepAdding) {
        this.$nextTick(() => {
          const el = this.$root?.querySelector(`[data-add-beat-act="${actId}"] .plot-add-beat-input`);
          el?.focus();
        });
      } else {
        this.addingActId = null;
      }
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
  // cancelAddBeat (leeres Feld beim ersten Klick), blendete das x-if das Input
  // direkt wieder aus und der User kann gar nichts eingeben. Darum eine Frame
  // deferren und nur reagieren, wenn der Fokus das Feld wirklich verlassen hat
  // (analog onActBlur).
  onAddBeatBlur(actId, ev) {
    if (this.busy || this.addingActId !== actId) return;
    const to = ev?.relatedTarget;
    if (to?.closest?.('.plot-add-beat-actions, .lt-badge, .lt-popover')) return;
    if (document.querySelector('.lt-popover')) return;
    const input = ev?.target || null;
    requestAnimationFrame(() => {
      if (this.busy || this.addingActId !== actId) return;
      if (input && document.activeElement === input) return;
      if (!(this.newBeatTitel || '').trim()) { this.cancelAddBeat(); return; }
      this.saveNewBeat(actId, { keepAdding: false });
    });
  },

  // ── Beat hinzufügen in einer Grid-Zelle (Akt × Strang) ─────────────────────
  // Eigener Pfad neben startAddBeat/saveNewBeat (die akt-only sind), weil im Grid
  // beim Anlegen direkt der Strang (thread_id) mitgesetzt wird. addingCell ist der
  // Zell-Schlüssel `${actId}:${threadId|null}`.
  _cellKey(actId, threadId) { return `${actId}:${threadId == null ? 'null' : threadId}`; },

  startAddBeatCell(actId, threadId) {
    this.addingCell = this._cellKey(actId, threadId);
    this.newBeatTitel = '';
    this.$nextTick(() => {
      const el = this.$root?.querySelector(`[data-add-beat-cell="${this.addingCell}"] .plot-add-beat-input`);
      el?.focus();
    });
  },
  cancelAddBeatCell() { this.addingCell = null; this.newBeatTitel = ''; },

  async saveNewBeatCell(actId, threadId, { keepAdding = true } = {}) {
    const app = window.__app;
    const titel = (this.newBeatTitel || '').trim();
    if (!titel) { this.cancelAddBeatCell(); return; }
    this.busy = true;
    try {
      const beat = await fetchJson('/plot/beats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, act_id: actId, thread_id: threadId ?? null, titel }),
      });
      this.beats = [...this.beats, beat];
      this._memos = {};
      this.newBeatTitel = '';
      this.errorMessage = '';
      if (keepAdding) {
        this.$nextTick(() => {
          const el = this.$root?.querySelector(`[data-add-beat-cell="${this._cellKey(actId, threadId)}"] .plot-add-beat-input`);
          el?.focus();
        });
      } else {
        this.addingCell = null;
      }
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  onAddBeatCellBlur(actId, threadId, ev) {
    const key = this._cellKey(actId, threadId);
    if (this.busy || this.addingCell !== key) return;
    const to = ev?.relatedTarget;
    if (to?.closest?.('.plot-add-beat-actions, .lt-badge, .lt-popover')) return;
    if (document.querySelector('.lt-popover')) return;
    const input = ev?.target || null;
    requestAnimationFrame(() => {
      if (this.busy || this.addingCell !== key) return;
      if (input && document.activeElement === input) return;
      if (!(this.newBeatTitel || '').trim()) { this.cancelAddBeatCell(); return; }
      this.saveNewBeatCell(actId, threadId, { keepAdding: false });
    });
  },

  startEditBeat(beat) {
    this.editingBeatId = beat.id;
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
  cancelEditBeat() { this.editingBeatId = null; },

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
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  // Quick-Status: Klick auf das Status-Badge zyklisch weiterschalten.
  async cycleBeatStatus(beat) {
    const app = window.__app;
    const next = STATUSES[(STATUSES.indexOf(beat.status) + 1) % STATUSES.length];
    try {
      const updated = await fetchJson(`/plot/beats/${beat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      this._replaceBeat(updated);
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
      if (this.editingBeatId === beat.id) this.editingBeatId = null;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.delete');
    } finally { this.busy = false; }
  },

  _replaceBeat(row) {
    this.beats = this.beats.map(b => (b.id === row.id ? row : b));
    this._memos = {};
  },

  // ── Drag & Drop ──────────────────────────────────────────────────────────
  onBeatDragStart(beat, ev) {
    this._dragBeatId = beat.id;
    if (ev?.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', String(beat.id)); } catch {} }
  },
  onBeatDragEnd() { this._dragBeatId = null; this._dragOverActId = null; this._dragOverCell = null; },
  onActDragOver(actId) { if (this._dragBeatId != null) this._dragOverActId = actId; },
  onCellDragOver(actId, threadId) { if (this._dragBeatId != null) this._dragOverCell = this._cellKey(actId, threadId); },

  // Flacher Pfad (Board ohne Stränge): Drop in eine Akt-Spalte → Strang bleibt
  // NULL. Signatur unverändert, damit das flache Board-Template unberührt bleibt.
  async onBeatDrop(targetActId, beforeBeatId = null) {
    return this._dropBeat(targetActId, null, beforeBeatId);
  },
  // Grid-Pfad: Drop in eine Zelle (Akt × Strang) → setzt act_id + thread_id.
  async onCellDrop(targetActId, targetThreadId, beforeBeatId = null) {
    return this._dropBeat(targetActId, targetThreadId, beforeBeatId);
  },

  // Gemeinsame DnD-Mechanik für beide Pfade: verschiebt den gezogenen Beat in die
  // Ziel-Zelle (Akt × Strang; threadId null = „ohne Strang"), nummeriert Ziel- und
  // Quell-Zelle neu und persistiert nur die betroffenen Zellen.
  async _dropBeat(targetActId, targetThreadId, beforeBeatId = null) {
    const beatId = this._dragBeatId;
    this._dragOverActId = null;
    this._dragOverCell = null;
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
        body: JSON.stringify({ book_id: app.selectedBookId, order }),
      });
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      this.loadBoard(); // Server-Stand wiederherstellen
    }
  },

  // ── KI: Brainstorm ──────────────────────────────────────────────────────
  // Im flachen Board akt-weit (thread = null), im Grid zell-granular (Strang
  // mitgegeben → die KI grundiert den Vorschlag mit Strang + gebundener Figur).
  async runBrainstorm(act, thread = null) {
    const app = window.__app;
    this.brainstormActId = act.id;
    this.brainstormThreadId = thread ? thread.id : null;
    this.brainstormLoading = true;
    this.brainstormStatus = '';
    this.brainstormResult = null;
    try {
      const resp = await fetchJson('/jobs/plot-brainstorm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, act_id: act.id, thread_id: thread ? thread.id : null }),
      });
      this._brainstormJobId = resp.jobId;
      startPoll(this, {
        timerProp: '_brainstormPollTimer',
        jobId: resp.jobId,
        progressProp: 'brainstormProgress',
        onProgress: (job) => {
          this.brainstormStatus = runningJobStatus(app.t.bind(app),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: (job) => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this._brainstormJobId = null;
          this.brainstormResult = { actId: job.result.actId, threadId: job.result.threadId ?? null, vorschlaege: job.result.vorschlaege || [] };
        },
        onError: (job) => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this._brainstormJobId = null;
          this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
        },
        onNotFound: () => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this._brainstormJobId = null;
        },
      });
    } catch (e) {
      this.brainstormLoading = false;
      this.errorMessage = app.t('plot.error.brainstorm');
    }
  },

  async applyBrainstorm(idx) {
    const app = window.__app;
    if (!this.brainstormResult) return;
    const v = this.brainstormResult.vorschlaege[idx];
    const actId = this.brainstormResult.actId;
    if (!v || !actId) return;
    this.busy = true;
    try {
      const beat = await fetchJson('/plot/beats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId, act_id: actId, thread_id: this.brainstormResult.threadId ?? null, titel: v.label, beschreibung: v.begruendung || '' }),
      });
      this.beats = [...this.beats, beat];
      this._memos = {};
      this.brainstormResult.vorschlaege = this.brainstormResult.vorschlaege.filter((_, i) => i !== idx);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
    } finally { this.busy = false; }
  },

  async cancelBrainstorm() {
    const id = this._brainstormJobId;
    if (id) await window.__app.cancelJob(id);
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    this.brainstormLoading = false;
    this.brainstormStatus = '';
    this.brainstormProgress = 0;
    this._brainstormJobId = null;
  },

  dismissBrainstorm() { this.brainstormResult = null; this.brainstormActId = null; this.brainstormThreadId = null; },

  // ── KI: Consistency ─────────────────────────────────────────────────────
  async runConsistency() {
    const app = window.__app;
    if (!this.beats.length) { this.errorMessage = app.t('plot.error.boardEmpty'); return; }
    this.consistencyLoading = true;
    this.consistencyStatus = '';
    this.consistencyResult = null;
    this.selectedKonfliktIdx = null;
    try {
      const resp = await fetchJson('/jobs/plot-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: app.selectedBookId }),
      });
      this._consistencyJobId = resp.jobId;
      startPoll(this, {
        timerProp: '_consistencyPollTimer',
        jobId: resp.jobId,
        progressProp: 'consistencyProgress',
        onProgress: (job) => {
          this.consistencyStatus = runningJobStatus(app.t.bind(app),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: (job) => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
          this.consistencyResult = { konflikte: job.result.konflikte || [], fazit: job.result.fazit || '' };
        },
        onError: (job) => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
          this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
        },
        onNotFound: () => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this._consistencyJobId = null;
        },
      });
    } catch (e) {
      this.consistencyLoading = false;
      this.errorMessage = app.t('plot.error.consistency');
    }
  },

  async cancelConsistency() {
    const id = this._consistencyJobId;
    if (id) await window.__app.cancelJob(id);
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.consistencyLoading = false;
    this.consistencyStatus = '';
    this.consistencyProgress = 0;
    this._consistencyJobId = null;
  },

  dismissConsistency() { this.consistencyResult = null; this.selectedKonfliktIdx = null; },

  // Ganze Plot-Karte ins Native-Vollbild — mehr horizontaler Platz fürs Akt-Board.
  // Status-Sync via fullscreenchange-Listener in plot-card.js (plotFullscreen).
  async togglePlotFullscreen() {
    try {
      await toggleWrapFullscreen(this.$root);
    } catch {
      this.errorMessage = window.__app.t('plot.error.fullscreen');
    }
  },

  _clearJobs() {
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.brainstormLoading = false;
    this.consistencyLoading = false;
    this.brainstormStatus = '';
    this.consistencyStatus = '';
    this._brainstormJobId = null;
    this._consistencyJobId = null;
  },
};
