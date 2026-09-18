// Laden, Filtern, Schreiben und Drag&Drop des Ideen-Boards.
// `this` = die ideenBoardCard-Instanz.

import { fetchJson } from '../../utils.js';
import { loadSortable } from '../../lazy-libs.js';
import {
  patchSortableOnce, revertSortable, markDragIgnore, unmarkDragIgnore, BASE_SORTABLE_OPTS,
} from '../../sortable-dnd.js';
import { IDEE_STATUSES, ideeStatus, isOpenIdee } from '../ideen-shared.js';
import { buildLaneOrder, buildBoard, chapterFilterOptions, statusTotals } from './model.js';

// Key in einer Klapp-Liste umschalten — immer als neue Liste (siehe
// toggleLaneFold).
function toggleKey(list, key) {
  const arr = Array.isArray(list) ? list : [];
  return arr.includes(key) ? arr.filter(k => k !== key) : [...arr, key];
}

export const ideenBoardActions = {
  // ── Ansicht ──────────────────────────────────────────────────────────────
  statuses() { return IDEE_STATUSES; },
  statusLabel(s) { return window.__app.t(`ideen.status.${s}`); },
  ideeStatus(idee) { return ideeStatus(idee); },

  // Ein Pass ueber den Bestand fuer alle Bahnen und Spalten (Memo-Pattern:
  // das Template fragt das Board mehrfach pro Render — Bahnen, Karten, Zaehler).
  board() {
    return this._memo('board',
      [this.ideen, this.laneOrder, this.filterChapterId, this.showVerworfen, this.query,
        this.collapsedLanes, this.collapsedChapters],
      () => buildBoard({
        ideen: this.ideen,
        laneOrder: this.laneOrder,
        filterChapterId: this.filterChapterId,
        showVerworfen: this.showVerworfen,
        query: this.query,
        collapsedLanes: this.collapsedLanes,
        collapsedChapters: this.collapsedChapters,
      }));
  },
  lanes() { return this.board().lanes; },
  hiddenCount() { return this.board().hiddenByFilter; },
  visibleCount() { return this.board().visible; },
  totalCount() { return this.board().total; },
  statusTotal(s) {
    return this._memo('statusTotals', [this.ideen], () => statusTotals(this.ideen))[s] || 0;
  },
  // Trefferzaehler der Filterleiste. Nennt das Ausgeblendete ausdruecklich —
  // ein blosses „12" liesse offen, ob die uebrigen erledigt, gefiltert oder weg
  // sind.
  countLabel() {
    const app = window.__app;
    const hidden = this.hiddenCount();
    return hidden > 0
      ? app.t('ideenBoard.countFiltered', { n: this.visibleCount(), total: this.totalCount(), hidden })
      : app.t('ideenBoard.countAll', { n: this.totalCount() });
  },
  chapterOptions() {
    return this._memo('chapterOptions', [this.ideen, this.laneOrder],
      () => chapterFilterOptions(this.ideen, this.laneOrder));
  },
  laneLabel(lane) {
    if (lane.kind === 'unknown') return window.__app.t('ideenBoard.laneUnknown');
    return lane.label || window.__app.t(lane.kind === 'chapter' ? 'ideenBoard.laneChapterFallback' : 'ideenBoard.lanePageFallback');
  },
  // ── Klappen ──────────────────────────────────────────────────────────────
  // Zwei unabhaengige Achsen, beide als Liste von Bahn-Keys im Filter-Scope
  // `ideenBoard` (per Buch im localStorage, siehe cards/ideen-board-card.js):
  //   collapsedLanes    — die KARTEN dieser Bahn sind eingeklappt.
  //   collapsedChapters — die SEITEN-BAHNEN dieses Kapitels sind in die
  //                       Kapitelzeile gefaltet.
  // Sie sind getrennt, weil sie Verschiedenes beantworten: „zeig mir die
  // Gliederung des Kapitels ohne seine Seiten" und „zeig mir die Bahn, aber
  // nicht ihre Notizen".
  //
  // Immer eine NEUE Liste schreiben, nie die bestehende mutieren: der
  // Board-Memo vergleicht seine Deps per Identitaet, und die Default-Liste des
  // Filter-Scopes ist ein geteiltes Objekt (filter-persist.js legt sie beim
  // Restore direkt auf die Karte).
  toggleLaneFold(lane) {
    if (!lane?.key) return;
    this.collapsedLanes = toggleKey(this.collapsedLanes, lane.key);
  },
  toggleChapterFold(lane) {
    if (lane?.kind !== 'chapter') return;
    this.collapsedChapters = toggleKey(this.collapsedChapters, lane.key);
  },
  // Beschriftung des Kapitel-Griffs: wie viele BELEGTE Seiten-Bahnen darunter
  // haengen (leere erscheinen ohnehin nicht, und eine Zahl, die sie mitzaehlte,
  // liesse beim Aufklappen weniger Zeilen erscheinen als angekuendigt).
  foldChapterTip(row) {
    const app = window.__app;
    return row.childCollapsed
      ? app.t('ideenBoard.chapterExpand', { n: row.childLanes, ideen: row.foldedCount })
      : app.t('ideenBoard.chapterCollapse', { n: row.childLanes });
  },
  foldLaneTip(row) {
    const app = window.__app;
    return app.t(row.collapsed ? 'ideenBoard.laneExpand' : 'ideenBoard.laneCollapse', { n: row.count });
  },

  // Sprung an die Stelle im Buch, an der die Pendenz haengt. Der Hash-Router ist
  // SSoT der Navigation — hier wird nur das Ziel gebaut.
  openLane(lane) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !lane || lane.kind === 'unknown') return;
    location.hash = lane.kind === 'chapter'
      ? `#book/${bookId}/kapitel/${lane.id}`
      : `#book/${bookId}/page/${lane.id}`;
  },

  // Ein Memo-Helfer fuer die ganze Karte (harte Regel „Memo-Pattern: ein Helper
  // pro Modul"): Array-Deps, shallow verglichen. `this._memos` wird in
  // loadBoard/resetBoard geleert.
  _memo(key, deps, fn) {
    const prev = this._memos[key];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
      return prev.value;
    }
    const value = fn();
    this._memos[key] = { deps, value };
    return value;
  },

  // ── Laden ────────────────────────────────────────────────────────────────
  async loadBoard() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.resetBoard(); return; }
    this.loading = true;
    this._memos = {};
    try {
      const data = await fetchJson(`/ideen/board?book_id=${bookId}`);
      this.ideen = Array.isArray(data?.ideen) ? data.ideen : [];
      this.laneOrder = buildLaneOrder(Alpine.store('nav').tree);
      this.errorMessage = '';
      this._publishCounts();
    } catch {
      this.errorMessage = app.t('ideenBoard.error.load');
      this.ideen = [];
    } finally {
      this.loading = false;
      this._memos = {};
      await this._ensureBoardSortables();
    }
  },

  resetBoard() {
    this.ideen = [];
    this.laneOrder = [];
    this.newContent = '';
    this.newLaneKey = '';
    this.editingId = null;
    this.editingDraft = '';
    this.linkPickerIdeeId = null;
    this.linkPickerKind = 'research';
    this.linkPickerTargetId = '';
    // Filterfelder bleiben unangetastet: sie gehoeren dem Filter-Scope
    // (filter-persist.js) und werden im Lifecycle VOR dem Nachladen restauriert.
    // Wuerde der Reset sie mitnehmen, holte der Buchwechsel das ungefilterte
    // Board und der restaurierte Filter zeigte auf nichts.
    this.errorMessage = '';
    this.busy = false;
    this._memos = {};
    this._destroyBoardSortables();
  },

  // Die Sidebar-Plaketten haengen an denselben Zahlen wie das Board. Wer hier
  // eine Pendenz abhakt, soll die Plakette der Seite nicht erst nach einem
  // Neuladen fallen sehen — die Maps werden darum aus dem Bestand neu gebildet
  // (nicht inkrementell gepatcht: das Board kennt ohnehin alle Ideen des Buchs).
  _publishCounts() {
    const badges = Alpine.store('badges');
    if (!badges) return;
    const pages = {};
    const chapters = {};
    for (const idee of (this.ideen || [])) {
      if (!isOpenIdee(idee)) continue;
      if (idee.page_id != null) pages[idee.page_id] = (pages[idee.page_id] || 0) + 1;
      else if (idee.chapter_id != null) chapters[idee.chapter_id] = (chapters[idee.chapter_id] || 0) + 1;
    }
    badges.ideenCounts = pages;
    badges.chapterIdeenCounts = chapters;
  },

  // ── Schreiben ────────────────────────────────────────────────────────────
  async setIdeeStatus(idee, status) {
    if (!idee || !IDEE_STATUSES.includes(status)) return;
    if (ideeStatus(idee) === status) return;
    await this._patchIdee(idee, { status });
  },

  async _patchIdee(idee, body) {
    const app = window.__app;
    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      this._replaceIdee(row);
      this.errorMessage = '';
      this._publishCounts();
      return row;
    } catch {
      this.errorMessage = app.t('ideenBoard.error.save');
      return null;
    } finally {
      this.busy = false;
    }
  },

  _replaceIdee(row) {
    if (!row) return;
    this.ideen = this.ideen.map(i => (i.id === row.id ? row : i));
    this._memos = {};
  },

  startEdit(idee) { this.editingId = idee.id; this.editingDraft = idee.content || ''; },
  cancelEdit() { this.editingId = null; this.editingDraft = ''; },
  async saveEdit(idee) {
    const content = (this.editingDraft || '').trim();
    if (!content) { this.errorMessage = window.__app.t('ideen.error.contentRequired'); return; }
    if (content === idee.content) { this.cancelEdit(); return; }
    if (await this._patchIdee(idee, { content })) this.cancelEdit();
  },

  // Neue Pendenz direkt am Board: die Bahn waehlt den Anker. Ohne Bahn kein
  // Anlegen — eine Idee ohne Anker gibt es im Schema nicht (XOR-CHECK).
  newLaneOptions() {
    // Erst alle Kapitel-Bahnen, dann alle Seiten-Bahnen — INNERHALB jeder Gruppe
    // bleibt die Buch-Reihenfolge aus `laneOrder`. Die Gruppen muessen
    // zusammenhaengen: die Combobox setzt ihre Kopfzeile beim Gruppenwechsel,
    // und in der reinen Buch-Reihenfolge wechselt die Art bei fast jeder Zeile —
    // dann stuenden „Kapitel" und „Seiten" abwechselnd zwischen den Eintraegen
    // statt als die zwei Bloecke, die die beiden Labels versprechen.
    return this._memo('newLaneOptions', [this.laneOrder], () => {
      const t = window.__app.t.bind(window.__app);
      const opt = (l) => ({
        value: l.key,
        label: l.kind === 'chapter' ? l.label : `${l.chapterLabel ? l.chapterLabel + ' · ' : ''}${l.label}`,
        group: t(l.kind === 'chapter' ? 'ideenBoard.groupChapters' : 'ideenBoard.groupPages'),
      });
      const lanes = this.laneOrder || [];
      return [
        ...lanes.filter(l => l.kind === 'chapter').map(opt),
        ...lanes.filter(l => l.kind !== 'chapter').map(opt),
      ];
    });
  },

  async addIdee() {
    const app = window.__app;
    const content = (this.newContent || '').trim();
    const bookId = Alpine.store('nav').selectedBookId;
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (!this.newLaneKey) { this.errorMessage = app.t('ideenBoard.error.laneRequired'); return; }
    if (!bookId) return;
    const [kind, rawId] = String(this.newLaneKey).split(':');
    const anchorId = parseInt(rawId, 10);
    if (!anchorId) return;

    this.busy = true;
    try {
      const body = { book_id: bookId, content };
      body[kind === 'chapter' ? 'chapter_id' : 'page_id'] = anchorId;
      const row = await fetchJson('/ideen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      this.ideen = [row, ...this.ideen];
      this.newContent = '';
      this.errorMessage = '';
      this._memos = {};
      this._publishCounts();
      await this._ensureBoardSortables();
    } catch {
      this.errorMessage = app.t('ideenBoard.error.save');
    } finally {
      this.busy = false;
    }
  },

  async deleteIdee(idee) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('ideen.confirmDelete'),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/ideen/${idee.id}`, { method: 'DELETE' });
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.errorMessage = '';
      this._memos = {};
      this._publishCounts();
    } catch {
      this.errorMessage = app.t('ideenBoard.error.delete');
    } finally {
      this.busy = false;
    }
  },

  // ── Drag & Drop ──────────────────────────────────────────────────────────
  // Angebunden werden die Status-Zellen JEDER Bahn. Anders als im Recherche-
  // Board sind sie nicht stabil (Bahnen kommen und gehen mit dem Filter), darum
  // wird nach jedem Board-Wechsel neu angebunden.
  //
  // Ein Drag traegt genau EINE Aussage: den neuen Status. Die Bahn bleibt, wie
  // sie ist — sie IST der Anker im Buch, und den verschiebt man nicht per
  // Kanban-Zug quer durchs Manuskript (dafuer gibt es „Verschieben" auf der
  // Ideen-Karte, das within-kind bleibt). Darum `put` nur aus derselben Bahn.
  async _ensureBoardSortables() {
    if (!window.__app?.showIdeenBoardCard) { this._destroyBoardSortables(); return; }
    try { await loadSortable(); } catch { return; }
    await this.$nextTick();
    this._initBoardSortables();
  },

  _destroyBoardSortables() {
    for (const s of (this._boardSortables || [])) { try { s.destroy(); } catch { /* schon weg */ } }
    this._boardSortables = [];
    document.body.classList.remove('ideen-dnd-active');
  },

  _initBoardSortables() {
    const Sortable = window.Sortable;
    if (!Sortable) return;
    patchSortableOnce(Sortable);
    this._destroyBoardSortables();
    const cells = this.$root?.querySelectorAll('[data-idee-status-cell]') || [];
    for (const el of cells) {
      const laneKey = el.dataset.ideeLane || '';
      this._boardSortables.push(new Sortable(el, {
        ...BASE_SORTABLE_OPTS,
        emptyInsertThreshold: 24,
        scroll: true,
        draggable: '.idee-board-card',
        handle: '.idee-board-grip',
        // Gruppenname pro Bahn: eine Karte bleibt in ihrer Zeile.
        group: { name: `idee-lane-${laneKey}`, pull: true, put: [`idee-lane-${laneKey}`] },
        chosenClass: 'idee-board-card--chosen',
        ghostClass: 'idee-board-card--ghost',
        dragClass: 'idee-board-card--dragging',
        onChoose: markDragIgnore,
        onUnchoose: unmarkDragIgnore,
        onStart: () => {
          document.body.classList.add('ideen-dnd-active');
          const fsEl = document.fullscreenElement;
          const ghost = Sortable.ghost;
          if (fsEl && ghost && !fsEl.contains(ghost)) fsEl.appendChild(ghost);
        },
        onEnd: (evt) => {
          document.body.classList.remove('ideen-dnd-active');
          unmarkDragIgnore(evt);
          this.onBoardSortEnd(evt);
        },
      }));
    }
  },

  // Immer zuerst reverten: Alpine x-for ist alleiniger DOM-Besitzer, und eine
  // Reihenfolge INNERHALB einer Spalte gibt es nicht (`ideen` hat keine
  // sort_order) — gleiche Regel wie im Recherche-Status-Board.
  async onBoardSortEnd(evt) {
    const ideeId = parseInt(evt.item?.dataset?.ideeCardId, 10);
    const target = evt.to?.dataset?.ideeStatusCell || '';
    revertSortable(evt);
    if (this.busy || !Number.isFinite(ideeId)) return;
    if (evt.from === evt.to) return;
    const idee = (this.ideen || []).find(i => i.id === ideeId);
    if (!idee) return;
    await this.setIdeeStatus(idee, target);
  },
};
