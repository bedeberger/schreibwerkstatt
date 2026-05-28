import { htmlToText, CHARS_PER_TOKEN, fetchJson, localeTag, relativeDay, tzOpts } from '../utils.js';
import { htmlToPlainText } from '../html-text.js';
import { contentRepo } from '../repo/content.js';

// Buch-/Seiten-Lade-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

const STALE_THRESHOLD_DAYS = 30;

// Tag-Differenz auf Basis lokaler Mitternacht – analog zu fmtLastRun in
// routes/jobs/shared.js. Verhindert Off-by-one bei Checks <24h, die aber
// bereits am Vortag stattfanden.
function _diffDays(then, now = new Date()) {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

function _fmtTime(d, locale) {
  return d.toLocaleTimeString(localeTag(locale), tzOpts({ hour: '2-digit', minute: '2-digit' }));
}
function _fmtDateShort(d, locale) {
  return d.toLocaleDateString(localeTag(locale), tzOpts({ day: '2-digit', month: '2-digit' }));
}

// Tree-Sort-Invariante: Solo-Seiten (ohne Kapitel) immer vor Kapiteln.
// Innerhalb der Gruppen nach `priority`.
export function _sortSoloFirst(a, b) {
  if (!!a.solo !== !!b.solo) return a.solo ? -1 : 1;
  return (a.priority ?? 0) - (b.priority ?? 0);
}

export const treeMethods = {
  pageStatus(page) {
    const rec = this.pageLastChecked?.[page.id];
    if (!rec) return 'none';
    const checkedAt = new Date(rec.at);
    const updatedMs = page.updated_at ? new Date(page.updated_at).getTime() : 0;
    if (updatedMs > checkedAt.getTime()) return 'warn';
    if (_diffDays(checkedAt) >= STALE_THRESHOLD_DAYS) return 'warn';
    if (rec.pending) return 'pending';
    return 'ok';
  },

  // Erwartete Keys: `${prefix}Rel` ({rel, time}) und `${prefix}On` ({date, time}).
  // `rel` kommt aus Intl.RelativeTimeFormat (heute / gestern / vor N Tagen).
  _fmtRelativeLine(d, prefix) {
    const diff = Math.max(0, _diffDays(d));
    const time = _fmtTime(d, this.uiLocale);
    if (diff < 7) return this.t(`${prefix}Rel`, { rel: relativeDay(diff, this.uiLocale), time });
    return this.t(`${prefix}On`, { date: _fmtDateShort(d, this.uiLocale), time });
  },

  pageStatusTooltip(page) {
    const rec = this.pageLastChecked?.[page.id];
    const updatedAt = page.updated_at ? new Date(page.updated_at) : null;
    const pageLine = updatedAt ? this._fmtRelativeLine(updatedAt, 'sidebar.status.pageUpdated') : '';
    if (!rec) {
      const lines = [this.t('sidebar.status.noLektorat')];
      if (pageLine) lines.push(pageLine);
      return lines;
    }
    const checkedAt = new Date(rec.at);
    const lektLine = this._fmtRelativeLine(checkedAt, 'sidebar.status.lektorat');
    const editedSince = updatedAt && updatedAt.getTime() > checkedAt.getTime();
    const lines = [];
    if (editedSince) lines.push(this.t('sidebar.status.editedSince'));
    else if (rec.pending) lines.push(this.t('sidebar.status.pending'));
    lines.push(lektLine);
    const myEmail = this.currentUser?.email || null;
    if (rec.by && myEmail && rec.by !== myEmail) {
      lines.push(this.t('sidebar.status.lektoratBy', { user: rec.by }));
    }
    if (pageLine) lines.push(pageLine);
    return lines;
  },

  markPageChecked(pageId, { pending = false } = {}) {
    if (pageId == null) return;
    this.pageLastChecked = {
      ...this.pageLastChecked,
      [pageId]: {
        at: new Date().toISOString(),
        pending: !!pending,
        by: this.currentUser?.email || null,
      },
    };
  },

  // Nach einem Page-Save tokEsts neu berechnen, damit der Baum den
  // "leer"-Badge sofort verliert und die Zeichenzahl stimmt. Persistiert
  // den frischen Stat-Eintrag auch in der History-DB.
  //
  // WICHTIG: Char/Word-Count via lib/html-text.js / public/js/html-text.js
  // (SSoT). Servers- und Frontend-Pendant dekodieren HTML-Entities, strippen
  // Tags zu Single-Space, collapse \s+, trim — sonst zaehlt trailing NBSP aus
  // dem Editor (`&#160;`) als 6 Zeichen mit und treibt Heute-Ring/7-Tage-Bars
  // gegen den Cron-Snapshot.
  //
  // Nur Seiten-HTML zählt — Seitennamen sind kein Teil des Umfangs (analog
  // routes/sync.js#computeStats). tok = chars / CHARS_PER_TOKEN.
  _syncPageStatsAfterSave(page, html) {
    if (!page?.id) return;
    const normalized = htmlToPlainText(String(html || ''));
    const words = normalized === '' ? 0 : normalized.split(/\s+/).length;
    const stat = {
      tok: Math.round(normalized.length / CHARS_PER_TOKEN),
      words,
      chars: normalized.length,
    };
    this.tokEsts = { ...this.tokEsts, [page.id]: stat };
    if (!this.selectedBookId) return;
    fetch('/history/page-stats/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        page_id: page.id,
        book_id: parseInt(this.selectedBookId),
        tok: stat.tok,
        words: stat.words,
        chars: stat.chars,
        updated_at: page.updated_at || null,
      }]),
    }).catch(() => {});
  },

  async refreshPageAges() {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson('/history/page-ages/' + bookId);
      if (this.selectedBookId === bookId) this.pageLastChecked = map || {};
    } catch { /* ignore */ }
  },

  // Setzt `item.stats` für jedes Kapitel der aktuellen Tree-Struktur.
  // Aufruf: nach Tree-Build (loadPages) und nach jeder tokEsts-Reassignment
  // (loadTokenEstimates / _syncPageStatsAfterSave). Mutiert direkt die
  // Kapitel-Items — Alpine-Reaktivität trägt das Update an die Sidebar.
  _refreshChapterStats() {
    const ts = this.tokEsts || {};
    const items = (this.tree || []).filter(it => it.type === 'chapter');
    const childMap = new Map();
    for (const it of items) {
      if (it.solo || !it.parent_id) continue;
      const arr = childMap.get(it.parent_id) || [];
      arr.push(it);
      childMap.set(it.parent_id, arr);
    }
    const cache = new Map();
    const subtree = (item) => {
      if (cache.has(item.id)) return cache.get(item.id);
      let words = 0, chars = 0, tok = 0, count = 0;
      for (const p of item.pages) {
        const e = ts[p.id];
        if (e) { words += e.words; chars += e.chars; tok += e.tok; count++; }
      }
      for (const child of (childMap.get(item.id) || [])) {
        const s = subtree(child);
        words += s.words; chars += s.chars; tok += s.tok; count += s.count;
      }
      const res = { words, chars, tok, count };
      cache.set(item.id, res);
      return res;
    };
    for (const item of items) {
      const { words, chars, tok, count } = subtree(item);
      item.stats = count
        ? {
            words, chars, tok,
            normseiten: Math.round((chars / 1500) * 10) / 10,
            badge: chars >= 1000 ? '~' + Math.round(chars / 1000) + 'k Z' : chars + ' Z',
          }
        : null;
    }
  },

  async _onChapterHeaderActivate(item) {
    if (this.pageSearch) return;
    // Leeres Kapitel → kapitel-review-card öffnen, damit User direkt eine
    // erste Seite anlegen kann. openKapitelReviewForChapter filtert 0-Seiten-
    // Kapitel via kapitelReviewChapterOptions() raus, deswegen direkt setzen.
    // chapterId zuerst am Root setzen, dann toggle awaiten — toggle lädt das
    // Partial via `_ensurePartial`; ohne await bleibt die Karte leer.
    if (item.pages.length === 0 && !item.hasChildren) {
      this.kapitelReviewChapterId = String(item.id);
      if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
      else this._closeOtherMainCards('kapitelReview');
      return;
    }
    // Parent-Kapitel ohne direkte Pages, aber mit Sub-Kapiteln, öffnen das
    // Review (include_subchapters greift dann automatisch, siehe kapitelReviewIncludeSubchapters).
    if (this._bookQualifiesForChapterReview()) await this.openKapitelReviewForChapter(item.id);
    else this.toggleChapterOpen(item);
  },

  // Persistenter Collapse-State des Sidebar-Trees pro (User, Buch). Default
  // ist `open: true` (Erstaufruf). Solo-Items werden nicht persistiert —
  // sie sind reine Page-Wrapper ohne Toggle.
  _treeOpenStorageKey(bookId) {
    if (!bookId) return '';
    return `sw:treeOpen:${this.currentUser?.email || ''}:${bookId}`;
  },
  _loadTreeOpenState(bookId) {
    try {
      const key = this._treeOpenStorageKey(bookId);
      if (!key) return {};
      const raw = localStorage.getItem(key);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  },
  _persistTreeOpenState() {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    try {
      const key = this._treeOpenStorageKey(bookId);
      if (!key) return;
      const state = {};
      for (const item of this.tree) {
        if (item.type === 'chapter' && !item.solo) state[item.id] = !!item.open;
      }
      localStorage.setItem(key, JSON.stringify(state));
    } catch { /* quota / disabled storage — ignore */ }
  },
  setChapterOpen(item, value) {
    if (!item || item.solo) return;
    item.open = !!value;
    this._persistTreeOpenState();
  },
  toggleChapterOpen(item) {
    if (!item || item.solo) return;
    this.setChapterOpen(item, !item.open);
  },
  setAllChaptersOpen(value) {
    for (const item of this.tree) {
      if (item.type === 'chapter' && !item.solo) item.open = !!value;
    }
    this._persistTreeOpenState();
  },

  // Sidebar-Tooltip-Helper (Token-Badge + Page-Status). Halten Layout-Code
  // aus dem Template fern; die im Root liegenden Show-Flags + Pos werden
  // direkt mutiert.
  _showTokTip(el, data, opts = {}) {
    if (!el || !data) return;
    const r = el.getBoundingClientRect();
    this.tokLegendPos = { x: r.left, y: r.top };
    this.tokTooltipData = { ...data, ...opts };
    this.showTokLegend = true;
  },
  _hideTokTip() {
    this.showTokLegend = false;
    this.tokTooltipData = null;
  },
  _showStatusTip(el, page) {
    if (!el || !page) return;
    const r = el.getBoundingClientRect();
    this.pageStatusTipPos = { x: r.left, y: r.top };
    this.pageStatusTipLines = this.pageStatusTooltip(page);
    this.showPageStatusTip = true;
  },
  _hideStatusTip() {
    this.showPageStatusTip = false;
  },

  async loadBooks(opts = {}) {
    try {
      this.setStatus(this.t('tree.connecting'), true);
      this.books = await contentRepo.listBooks({ fresh: opts.fresh === true });
      // Wake-Refresh: Caller (_refreshAfterWake) triggert loadPages selbst mit source='wake'.
      // Hier weiterzureichen würde Tree erneut clearen (loadPages ohne source) → Flicker.
      // skipPages: für Metadaten-only-Refreshes (Kategorie/Tag/Rename) — Pagetree bleibt stehen.
      const skipLoadPages = opts.source === 'wake' || opts.skipPages === true;
      // Pool fuer Filter-Pills aus aktuellem Bestand ableiten.
      const catIds = new Set();
      for (const b of this.books) {
        if (b.category_id) catIds.add(b.category_id);
      }
      // Kategorie-Namen aus globalem Pool nachladen (kein Snapshot pro Buch).
      if (catIds.size > 0 && this.bookFilterCategoryPool.length === 0) {
        try {
          const r = await fetch('/local/categories');
          if (r.ok) this.bookFilterCategoryPool = (await r.json()).categories || [];
        } catch (_) {}
      }
      // Filter aus localStorage restoren (per-User). Nur valide IDs (im Pool und mit Büchern) übernehmen.
      if (!this.bookFilterCategoryId) {
        try {
          const stored = localStorage.getItem(`sw:bookFilterCategoryId:${this.currentUser?.email || ''}`);
          if (stored && catIds.has(Number(stored))) this.bookFilterCategoryId = String(stored);
        } catch (_) {}
      }
      if (!this.selectedBookId || !this.books.some(b => String(b.id) === String(this.selectedBookId))) {
        let restored = '';
        try {
          const key = `sw:lastBookId:${this.currentUser?.email || ''}`;
          const stored = localStorage.getItem(key);
          if (stored && this.books.some(b => String(b.id) === String(stored))) restored = String(stored);
        } catch (_) {}
        // Filter aktiv → erstes Buch aus gefilterter Liste bevorzugen (z.B. nach deleteBook).
        let filteredFallback = '';
        if (this.bookFilterCategoryId) {
          const filtered = this.filteredBooks();
          filteredFallback = String(filtered[0]?.id || '');
          if (restored && !filtered.some(b => String(b.id) === restored)) restored = '';
        }
        this.selectedBookId = restored || filteredFallback || String(this.books[0]?.id || '');
      }
      this.showBookCard = true;
      this.setStatus(this.t('tree.booksFound', { n: this.books.length }), false, 4000);
      if (this.selectedBookId) this._loadBookRole(this.selectedBookId);
      if (!skipLoadPages) await this.loadPages();
    } catch (e) {
      console.error('[loadBooks]', e);
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  // Filter-Logik fuer Buchliste. Leere Filter = kein Filter.
  filteredBooks() {
    const cat = this.bookFilterCategoryId;
    if (!cat) return this.books;
    return this.books.filter(b => String(b.category_id) === String(cat));
  },

  bookCountForCategory(catId) {
    if (!catId) return 0;
    const key = String(catId);
    let n = 0;
    for (const b of this.books) if (String(b.category_id) === key) n++;
    return n;
  },

  clearBookFilters() {
    this.bookFilterCategoryId = '';
  },

  // Entity-Linking-Toggle pro Buch laden — Spiegel von
  // book_settings.entities_enabled. Wird beim Buchwechsel gesetzt; der
  // Toolbar-Toggle pflegt die Flag danach selbst (optimistisch + PUT).
  // Failsafe: bei Netz/Permission-Fehler aus.
  async _loadEntitiesEnabledForBook(bookId) {
    const id = bookId ? String(bookId) : '';
    if (!id) { this.entitiesEnabledForCurrentBook = false; return; }
    try {
      const res = await fetch('/booksettings/' + encodeURIComponent(id), {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) { this.entitiesEnabledForCurrentBook = false; return; }
      const data = await res.json();
      if (String(this.selectedBookId) === id) {
        this.entitiesEnabledForCurrentBook = !!data.entities_enabled;
      }
    } catch (_) {
      this.entitiesEnabledForCurrentBook = false;
    }
  },

  // Toolbar-Toggle aus dem Notebook-Editor — PUTtet nur entities_enabled,
  // dispatcht book:settings:updated damit die Entities-Sub neu rechnet.
  async toggleEntitiesEnabledForCurrentBook() {
    const id = this.selectedBookId;
    if (!id) return;
    if (this._entitiesBusy) return;
    this._entitiesBusy = true;
    const next = !this.entitiesEnabledForCurrentBook;
    this.entitiesEnabledForCurrentBook = next;
    try {
      const res = await fetch('/booksettings/' + encodeURIComponent(id) + '/entities-enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next ? 1 : 0 }),
      });
      if (!res.ok) {
        this.entitiesEnabledForCurrentBook = !next;
        throw new Error('HTTP ' + res.status);
      }
      window.dispatchEvent(new CustomEvent('book:settings:updated', { detail: {
        bookId: id, entities_enabled: next ? 1 : 0,
      }}));
    } catch (e) {
      this.entitiesEnabledForCurrentBook = !next;
      console.error('[entities] Toggle fehlgeschlagen:', e);
    } finally {
      this._entitiesBusy = false;
    }
  },

  // ACL-Rolle aus /books/:id/access laden + cachen. Getter
  // `canEdit`/`canReview`/`isViewer` lesen ausschliesslich `currentBookRole`.
  async _loadBookRole(bookId) {
    const id = bookId ? String(bookId) : '';
    if (!id) { this.currentBookRole = null; return; }
    if (Object.prototype.hasOwnProperty.call(this.bookRoles, id)) {
      if (String(this.selectedBookId) === id) this.currentBookRole = this.bookRoles[id];
      return;
    }
    let role = null;
    let shared = false;
    try {
      const res = await fetch('/books/' + encodeURIComponent(id) + '/access', {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        role = data?.my_role || null;
        shared = Array.isArray(data?.access) && data.access.length > 1;
      }
    } catch (e) {
      // Netzwerk-Fehler → role bleibt null (Legacy-Fallback: canEdit=true)
    }
    this.bookRoles[id] = role;
    this.bookSharedFlags[id] = shared;
    if (String(this.selectedBookId) === id) {
      this.currentBookRole = role;
      // Shared-Flag steht jetzt fest → vollen Poll ggf. starten, ohne den schon
      // laufenden leichten Geraete-Ping (aus _startCollabPoll) abzureissen.
      this._reconcileFullCollabPoll?.(id);
    }
  },

  // Edit-Recht (Page-HTML schreiben): editor + owner. lektor + viewer nein.
  // null = unbekannt → Legacy-Fallback erlaubt Edit (4b enforced serverseitig
  // ohnehin; Frontend-Check ist nur UX, kein Sicherheitsanker).
  canEdit() {
    const r = this.currentBookRole;
    return r === null || r === 'editor' || r === 'owner';
  },
  // Review-Recht (Lektorat-Check, Page-Chat): lektor + editor + owner.
  canReview() {
    const r = this.currentBookRole;
    return r === null || r === 'lektor' || r === 'editor' || r === 'owner';
  },
  isViewer() {
    return this.currentBookRole === 'viewer';
  },

  currentBuchtyp() {
    const id = String(this.selectedBookId || '');
    if (!id) return null;
    const book = (this.books || []).find(b => String(b.id) === id);
    return book?.buchtyp || null;
  },
  isTagebuch() {
    return this.currentBuchtyp?.() === 'tagebuch';
  },

  async loadPages(opts = {}) {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    // Laufenden Figuren-Job-Poll abbrechen (Buch könnte gewechselt haben).
    // checkPendingJobs am Ende reconnectet korrekt für das neue Buch.
    if (this._figuresPollTimer) { clearInterval(this._figuresPollTimer); this._figuresPollTimer = null; }
    this.figurenLoading = false;
    this.figurenProgress = 0;
    this.figurenStatus = '';
    // Vorherigen Buch-Load abbrechen (Buchwechsel während laufendem bookTree
    // bei grossem Buch sonst: Request hängt 30s am Netz, Server verarbeitet
    // weiter, Browser-Slot blockiert). Stale-Guards verwerfen zwar Resultate,
    // brechen aber nichts ab. Re-Entry-Guard, nur in dieser Methode + dem
    // book-switch-Reset gelesen — daher keine Initial-Feld-Deklaration.
    this._bookLoadAbort?.abort(new DOMException('book switch', 'AbortError'));
    const loadCtrl = new AbortController();
    this._bookLoadAbort = loadCtrl;
    const signal = loadCtrl.signal;
    this.treeLoading = true;
    // Sidebar-Mode SYNCHRON vor dem Page-Fetch setzen: Tagebuch öffnet Kalender,
    // sonst Tree. Buchtyp ist aus der bereits geladenen `books`-Liste sofort
    // bekannt (currentBuchtyp), daher kein Warten auf den Fetch nötig — sonst
    // sieht der User für die Fetch-Dauer den Tree und es springt danach in den
    // Kalender. User-Auswahl überlebt Buchwechsel/Reload bewusst nicht, damit
    // Tagebuch-User den Kalender verlässlich beim Aufruf sehen.
    this.sidebarMode = this.isTagebuch() ? 'calendar' : 'tree';
    this.diaryCalendarYearMonth = null;
    try {
      this.setStatus(this.t('tree.loadingPages'), true);
      // Tree/Pages werden NICHT vorab geleert — alter Tree bleibt sichtbar
      // (CSS dimmt + blockiert Klicks via .tree-card--loading), bis der neue
      // Tree da ist. Bei Fetch-Fail (Session, Timeout) räumt der catch-Block
      // explizit auf, statt einen Sackgassen-Tree mit Seiten aus dem alten
      // Buch stehen zu lassen. Wake-Refresh clear't ohnehin nichts.
      if (opts.source !== 'wake') {
        this.pageSearch = '';
        this.pageSearchActiveIndex = 0;
        this._pageSearchActiveId = null;
        this._filteredTreeMemo = null;
        this.tokEsts = {};
        this.pageLastChecked = {};
        this.ideenCounts = {};
        this.chapterIdeenCounts = {};
      }
      this._tokenEstGen++;
      // Buchwechsel: SW-CONTENT_CACHE (SWR) kann stale Listen liefern, daher fresh.
      // Initialer Load greift normal aufs Cache (offline-resilient).
      const fresh = opts.source === 'bookSwitch';
      const tree = await contentRepo.bookTree(bookId, { fresh, signal });

      // Buch wurde gewechselt während die Anfrage lief → veraltete Daten verwerfen.
      if (this.selectedBookId !== bookId) return;

      // pages-Cache im Hintergrund aktualisieren (fire-and-forget)
      const qs = opts.source ? `?source=${encodeURIComponent(opts.source)}` : '';
      fetch('/sync/pages/' + bookId + qs, { method: 'POST', signal }).catch(() => {});

      // contentRepo.bookTree liefert Kapitel nested (subchapters[]) + topPages
      // fuer Seiten ohne Kapitel. UI-Items behalten internes `priority`-Feld
      // als Sort-Schluessel. Sidebar-Tree wird flach + depth-annotiert gebaut:
      // jedes Kapitel kennt seine Tiefe (1-3) und parent_id; Reihenfolge ist
      // Depth-First, damit Sub-Kapitel visuell unter ihrem Parent stehen.
      const sortedChapters = tree.chapters;
      const flatChapters = []; // [{ id, name, position, _depth, _parent_id, pages }]
      const walkChapters = (chapters, depth, parentId) => {
        for (const c of chapters) {
          flatChapters.push({
            id: c.id,
            name: c.name,
            position: c.position,
            pages: c.pages || [],
            _depth: depth,
            _parent_id: parentId,
          });
          walkChapters(c.subchapters || [], depth + 1, c.id);
        }
      };
      walkChapters(sortedChapters, 1, null);
      const chMap = Object.fromEntries(flatChapters.map(c => [c.id, c.name]));
      const childCountMap = new Map();
      for (const c of flatChapters) {
        if (c._parent_id) childCountMap.set(c._parent_id, (childCountMap.get(c._parent_id) || 0) + 1);
      }

      const decoratePage = (p) => ({
        ...p,
        priority: p.position, // legacy alias fuer UI-Sortierung + drag/drop
        chapterName: p.chapter_id ? (chMap[p.chapter_id] || this.t('tree.chapterFallback')) : null,
      });

      // Seiten ohne Kapitel immer zuerst — danach Kapitel in Tree-Reihenfolge.
      this.pages = [
        ...tree.topPages.map(decoratePage),
        ...flatChapters.flatMap(c => c.pages.map(decoratePage)),
      ];

      const openState = this._loadTreeOpenState(bookId);
      this.tree = [
        ...this.pages.filter(p => !p.chapter_id).map(p => ({
          type: 'chapter',
          id: 'solo-' + p.id,
          name: p.name,
          priority: p.priority,
          depth: 1,
          parent_id: null,
          open: true,
          solo: true,
          pages: [p],
        })),
        ...flatChapters.map(c => ({
          type: 'chapter',
          id: c.id,
          name: c.name,
          priority: c.position,
          depth: c._depth,
          parent_id: c._parent_id,
          open: Object.prototype.hasOwnProperty.call(openState, c.id) ? !!openState[c.id] : true,
          solo: false,
          hasChildren: (childCountMap.get(c.id) || 0) > 0,
          pages: this.pages.filter(p => p.chapter_id === c.id),
        })),
      ];

      // Persistent sort maps – built once per book load, used by all filter sorting
      this._chapterOrderMap = new Map();
      let chIdx = 0;
      for (const item of this.tree) {
        if (item.type === 'chapter' && !item.solo) this._chapterOrderMap.set(item.name, chIdx++);
      }
      this._pageOrderMap = new Map();
      this._pageIdOrderMap = new Map();
      for (let i = 0; i < this.pages.length; i++) {
        const p = this.pages[i];
        if (!this._pageOrderMap.has(p.name)) this._pageOrderMap.set(p.name, i);
        this._pageIdOrderMap.set(p.id, i);
      }
      this._refreshChapterStats();

      // Gecachte Stats + Page-Ages + Ideen-Counts (Page + Chapter) aus DB laden
      try {
        const [statsCache, ageMap, ideenMap, chapterIdeenMap] = await Promise.all([
          fetchJson('/history/page-stats/' + bookId, { signal }),
          fetchJson('/history/page-ages/' + bookId, { signal }),
          fetchJson('/ideen/counts?book_id=' + bookId, { signal }).catch(() => ({})),
          fetchJson('/ideen/counts?book_id=' + bookId + '&kind=chapter', { signal }).catch(() => ({})),
        ]);
        this.pageLastChecked = ageMap || {};
        this.ideenCounts = ideenMap || {};
        this.chapterIdeenCounts = chapterIdeenMap || {};
        // Cache-Hits in einem Rutsch zuweisen (statt Index-Assign in der Loop),
        // damit der tokEsts-$watch in app.js#init feuert und die Kapitel-Stats
        // synchron mit dem ersten Tree-Render aktualisiert.
        const initialTokEsts = {};
        for (const p of this.pages) {
          const c = statsCache[p.id];
          if (c && c.updated_at === p.updated_at) {
            initialTokEsts[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
          }
        }
        if (Object.keys(initialTokEsts).length) this.tokEsts = initialTokEsts;
      } catch { /* Cache-Fehler ignorieren, Fallback auf Live-Berechnung */ }

      this.showTreeCard = true;
      // sidebarMode + diaryCalendarYearMonth werden bereits synchron vor dem
      // Fetch gesetzt (siehe oben), damit der Kalender nicht erst nach dem
      // Page-Load aus dem Tree aufpoppt.
      this.setStatus('');
      // Geöffnete Seite frisch nachziehen (User klickt "Neuladen" → erwartet
      // auch im Editor den aktuellen Server-Stand). Aktive Edits nicht
      // überschreiben — gleiche Regel wie beim Re-Klick auf offene Seite.
      if (this.currentPage
          && String(this.currentPage.book_id) === String(bookId)
          && !this.editMode && !this.editDirty) {
        this._refetchCurrentPage();
      }
      await Promise.all([
        this.loadBookReviewHistory(bookId, { signal }),
        // loadKapitelReviewHistory lebt jetzt in Alpine.data('kapitelReviewCard')
        // und wird beim Öffnen der Karte (bzw. book:changed-Event) geladen.
        this.loadFiguren(bookId, { signal }),
        this.loadLastKomplettRun(bookId, { signal }),
      ]);
      this.checkPendingJobs(bookId); // Reconnect nach Tab-Schliessen, kein await
      this.loadTokenEstimates(this._tokenEstGen, signal); // Hintergrund, kein await
      // Karten, die einen frischen Tree brauchen (Buchorganizer), reagieren
      // explizit auf diesen Event statt auf einen $watch der Tree-Identität —
      // so können dieselben Karten auch In-Place-Mutationen am Tree machen,
      // ohne sich selbst rekursiv neu zu rendern.
      window.dispatchEvent(new CustomEvent('pages:loaded', { detail: { bookId } }));
    } catch (e) {
      // AbortError = Buchwechsel hat laufenden Load gekillt — kein User-Fehler.
      // Nachfolge-Call managed treeLoading + Tree selbst, hier nichts touchen.
      if (e?.name === 'AbortError' || signal.aborted) return;
      console.error('[loadPages]', e);
      // Endgültiger Fail (Session expired, Timeout, Netz weg): alten Tree
      // verwerfen. Sonst sieht User Sackgassen-Tree mit Seiten aus dem alten
      // Buch und kann nicht navigieren (Klick → Page aus fremdem Buch).
      this.tree = [];
      this.pages = [];
      this.setStatus(this.t('common.errorColon') + e.message);
    } finally {
      if (this._bookLoadAbort === loadCtrl) {
        this._bookLoadAbort = null;
        this.treeLoading = false;
      }
    }
  },

  async createChapter({ afterChapterId } = {}) {
    const bookId = this.selectedBookId;
    const title = (this.newChapterTitle || '').trim();
    if (!bookId || !title || this.newChapterCreating) return null;
    this.newChapterCreating = true;
    this.newChapterError = '';
    try {
      const afterItem = afterChapterId
        ? this.tree.find(i => i.type === 'chapter' && !i.solo && String(i.id) === String(afterChapterId))
        : null;
      const body = { book_id: parseInt(bookId), name: title };
      if (afterItem && Number.isFinite(afterItem.priority)) body.position = afterItem.priority + 1;
      const created = await contentRepo.createChapter(body);
      this.newChapterTitle = '';
      if (!created?.id) return null;
      const localPriority = afterItem && Number.isFinite(afterItem.priority)
        ? afterItem.priority + 0.5
        : (created.position ?? Number.MAX_SAFE_INTEGER);
      const chapterItem = {
        type: 'chapter',
        id: created.id,
        name: created.name,
        priority: localPriority,
        open: true,
        solo: false,
        pages: [],
      };
      this.tree = [...this.tree, chapterItem].sort(_sortSoloFirst);
      if (this._chapterOrderMap) this._chapterOrderMap.set(chapterItem.name, this._chapterOrderMap.size);
      this._persistTreeOpenState();
      return chapterItem;
    } catch (e) {
      console.error('[createChapter]', e);
      this.newChapterError = e.message || this.t('common.unknownError');
      return null;
    } finally {
      this.newChapterCreating = false;
    }
  },

  // Token-Estimates befüllen die Sidebar-Badges + Σ-Totals. Strategie:
  //   1) Server-Backfill (`POST /sync/page-stats/:bookId`) — ein einzelner
  //      Request, Server holt fehlende Stats parallel von BookStack und
  //      persistiert sie in `page_stats`. Erspart 429 Browser-Roundtrips bei
  //      einem grossen Buch.
  //   2) IntersectionObserver auf den Sidebar-Items — fehlende Stats für
  //      sichtbare Seiten werden bevorzugt nachgereicht (ids-Lazy-Pfad
  //      derselben Route), damit Badges ohne Warten auf den Vollabgleich
  //      erscheinen, sobald der User scrollt.
  // Beide Pfade sind idempotent; der Generations-Counter `_tokenEstGen`
  // verwirft Resultate aus alten Buch-Läufen.
  async loadTokenEstimates(gen, signal) {
    if (this._tokenEstGen !== gen) return;
    if (signal?.aborted) return;
    const bookId = this.selectedBookId;
    if (!bookId || !this.pages.length) return;
    const missing = this.pages.some(p => !this.tokEsts[p.id]);
    if (!missing) return;

    this._setupStatsObserver(bookId, gen);

    try {
      const r = await fetch('/sync/page-stats/' + bookId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal,
      });
      if (!r.ok) return;
      const data = await r.json();
      if (this._tokenEstGen !== gen) return;
      if (data && data.stats) this.tokEsts = { ...this.tokEsts, ...data.stats };
    } catch { /* Observer-Pfad übernimmt sukzessive */ }
  },

  _setupStatsObserver(bookId, gen) {
    this._teardownStatsObserver();
    if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') return;

    const state = { queue: new Set(), flushTimer: null };

    const flush = async () => {
      state.flushTimer = null;
      if (this._tokenEstGen !== gen) return;
      if (!state.queue.size) return;
      const ids = [...state.queue];
      state.queue.clear();
      try {
        const r = await fetch('/sync/page-stats/' + bookId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!r.ok) return;
        const data = await r.json();
        if (this._tokenEstGen !== gen) return;
        if (data && data.stats) this.tokEsts = { ...this.tokEsts, ...data.stats };
      } catch { /* einzelner Batch-Fail ist nicht kritisch */ }
    };

    const io = new IntersectionObserver((entries) => {
      if (this._tokenEstGen !== gen) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = parseInt(e.target.dataset.pageId, 10);
        if (!id || this.tokEsts[id]) { io.unobserve(e.target); continue; }
        state.queue.add(id);
        io.unobserve(e.target);
      }
      if (state.queue.size && !state.flushTimer) state.flushTimer = setTimeout(flush, 200);
    }, { rootMargin: '200px 0px' });

    const observe = (node) => {
      if (!(node instanceof Element)) return;
      if (node.matches?.('.page-item[data-page-id]')) io.observe(node);
      node.querySelectorAll?.('.page-item[data-page-id]').forEach(n => io.observe(n));
    };
    // Auf `#partial-sidebar` einengen, damit der MutationObserver nicht auf
    // Editor-/Karten-Renderings reagiert. Fallback document.body falls Mount
    // (noch) nicht existiert.
    const root = document.getElementById('partial-sidebar') || document.body;
    observe(root);

    const mo = new MutationObserver(muts => {
      for (const m of muts) for (const node of m.addedNodes) observe(node);
    });
    mo.observe(root, { childList: true, subtree: true });

    this._statsObserver = io;
    this._statsObserverMutation = mo;
    this._statsObserverState = state;
  },

  _teardownStatsObserver() {
    if (this._statsObserver) { this._statsObserver.disconnect(); this._statsObserver = null; }
    if (this._statsObserverMutation) { this._statsObserverMutation.disconnect(); this._statsObserverMutation = null; }
    if (this._statsObserverState?.flushTimer) clearTimeout(this._statsObserverState.flushTimer);
    this._statsObserverState = null;
  },
};
