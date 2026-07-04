// Alpine.data('referenceCard') — Referenz-Slot: read-only Begleitpanel neben dem
// Notebook-Editor (Companion, Mutex mit Seiten-Chat + Ideen im 420px-Slot).
// Fünf Tabs — Figuren · Orte · Szenen · Ereignisse · Recherche — wahlweise auf
// den aktuellen Kontext (Seite/Kapitel) oder das ganze Buch. Nie schreibend
// (rückwärtsgewandt — nie generativ in den Buchtext).
//
// Datenquellen: Figuren/Orte/Szenen/globalZeitstrahl aus Alpine.store('catalog');
// Figuren-Kontext bevorzugt aus $app.chapterFigures (server-geladene Kapitel-
// Figuren, gleiche Quelle wie der Editor-Highlighter), sonst Namens-Treffer im
// Seitentext; Szenen-Kontext aus selectScenesForView (geteilt mit dem Highlighter);
// Recherche lazy via /research. Löst das alte „Auf dieser Seite"-Panel ab; die
// Inline-Highlights + Popover bleiben im editorEntitiesCard.

import { fetchJson } from '../utils.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { selectScenesForView } from '../editor/notebook/entities.js';

const TABS = ['figuren', 'orte', 'szenen', 'ereignisse', 'recherche'];

export function registerReferenceCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('referenceCard', () => ({
    referenceTab: 'figuren',
    referenceScope: 'page',            // 'page' (aktueller Kontext) | 'book'
    referenceRecherche: [],
    referenceRechercheLoading: false,
    _refPageText: '',
    _refPageTextKey: null,
    _memos: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showReferenceCard',
        onShow: () => this._onVisibleReference(),
        onBookChanged: () => this._resetReference(),
        onViewReset: () => this._resetReference(),
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    _resetReference() {
      this.referenceRecherche = [];
      this._refPageText = '';
      this._refPageTextKey = null;
      this._memos = {};
    },

    // Beim Sichtbarwerden: Katalog-Daten defensiv nachladen (der Slot lebt
    // eigenständig neben dem Editor — die Fach-Karten wurden evtl. nie geöffnet)
    // + Recherche fetchen.
    _onVisibleReference() {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      const cat = Alpine.store('catalog');
      if (!(cat.figuren || []).length) app.loadFiguren?.(bookId);
      if (!(cat.orte || []).length) app.loadOrte?.(bookId);
      if (!(cat.szenen || []).length) app.loadSzenen?.(bookId);
      if (!(cat.globalZeitstrahl || []).length) app._reloadZeitstrahl?.();
      this._loadReferenceRecherche();
    },

    async _loadReferenceRecherche() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) { this.referenceRecherche = []; return; }
      this.referenceRechercheLoading = true;
      try {
        const rows = await fetchJson(`/research?book_id=${bookId}`);
        this.referenceRecherche = Array.isArray(rows) ? rows : [];
      } catch { this.referenceRecherche = []; }
      finally { this.referenceRechercheLoading = false; }
    },

    // ── Tabs + Scope ────────────────────────────────────────────────────────
    referenceTabs() { return TABS; },
    setReferenceTab(tab) { if (TABS.includes(tab)) this.referenceTab = tab; },
    toggleReferenceScope() {
      this.referenceScope = this.referenceScope === 'page' ? 'book' : 'page';
    },
    referenceHasContext() { return !!window.__app?.currentPage; },
    // Kontext-Filter greift nur, wenn Scope='page' UND eine Seite offen ist —
    // sonst wird immer das ganze Buch gezeigt (nichts zu filtern).
    _contextActive() { return this.referenceScope === 'page' && this.referenceHasContext(); },

    // ── Memo (ein Helper pro Modul, Array-Deps mit ===) ──────────────────────
    _memo(key, deps, fn) {
      const prev = this._memos[key];
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
        return prev.val;
      }
      const val = fn();
      this._memos[key] = { deps, val };
      return val;
    },

    _pageKey() {
      const p = window.__app?.currentPage;
      return p ? (p.id + ':' + (p.updated_at || '')) : '';
    },

    // Plaintext der aktuellen Seite (Namens-Treffer für Figuren/Orte im Kontext).
    _pageText() {
      const app = window.__app;
      if (!app?.currentPage) return '';
      const key = this._pageKey();
      if (this._refPageTextKey === key) return this._refPageText;
      const html = app.originalHtml || '';
      this._refPageText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
      this._refPageTextKey = key;
      return this._refPageText;
    },

    _nameInPage(names) {
      const txt = this._pageText();
      if (!txt) return false;
      return names.some(n => n && txt.includes(String(n).toLowerCase()));
    },

    _currentChapterName() {
      const cid = window.__app?.currentPage?.chapter_id;
      if (!cid) return '';
      const ch = (Alpine.store('nav').tree || []).find(c => c.id === cid);
      return ch?.name || '';
    },

    // ── Gefilterte Listen (memoized — im Template + in referenceCount genutzt) ─
    referenceFiguren() {
      const app = window.__app;
      const all = Alpine.store('catalog').figuren || [];
      const chapterFigs = app?.chapterFigures || [];
      return this._memo('figuren', [this.referenceScope, this._pageKey(), all, chapterFigs], () => {
        if (!this._contextActive()) return all;
        if (chapterFigs.length) return chapterFigs;
        return all.filter(f => this._nameInPage([f.name, f.kurzname]));
      });
    },

    referenceOrte() {
      const all = Alpine.store('catalog').orte || [];
      return this._memo('orte', [this.referenceScope, this._pageKey(), all], () => {
        if (!this._contextActive()) return all;
        return all.filter(o => this._nameInPage([o.name]));
      });
    },

    referenceSzenen() {
      const all = Alpine.store('catalog').szenen || [];
      const app = window.__app;
      const pid = app?.currentPage?.id;
      const cid = app?.currentPage?.chapter_id;
      return this._memo('szenen', [this.referenceScope, pid, cid, all], () => {
        if (!this._contextActive()) return all;
        const v = selectScenesForView(all, pid, cid);
        return [...v.onPage, ...v.inChapter];
      });
    },

    referenceEreignisse() {
      const all = Alpine.store('catalog').globalZeitstrahl || [];
      const chapName = this._currentChapterName();
      return this._memo('ereignisse', [this.referenceScope, chapName, all], () => {
        if (!this._contextActive() || !chapName) return all;
        const cl = chapName.toLowerCase();
        return all.filter(ev => {
          const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
          return kap.some(k => String(k).toLowerCase() === cl);
        });
      });
    },

    referenceRechercheItems() {
      const all = this.referenceRecherche || [];
      const app = window.__app;
      const pid = app?.currentPage?.id;
      const cid = app?.currentPage?.chapter_id;
      return this._memo('recherche', [this.referenceScope, pid, cid, all], () => {
        if (!this._contextActive()) return all;
        return all.filter(it => (it.links || []).some(l =>
          (l.target_kind === 'page' && l.target_id === pid) ||
          (l.target_kind === 'chapter' && cid != null && l.target_id === cid)));
      });
    },

    referenceCount(tab) {
      switch (tab) {
        case 'figuren':    return this.referenceFiguren().length;
        case 'orte':       return this.referenceOrte().length;
        case 'szenen':     return this.referenceSzenen().length;
        case 'ereignisse': return this.referenceEreignisse().length;
        case 'recherche':  return this.referenceRechercheItems().length;
        default:           return 0;
      }
    },

    // ── Render-Helfer ─────────────────────────────────────────────────────────
    referenceEventDate(ev) {
      if (ev?.datum_label) return ev.datum_label;
      if (ev?.datum_year != null) return String(ev.datum_year);
      return '';
    },
    referenceRechercheKind(item) {
      const app = window.__app;
      return item?.kind ? app.t('recherche.kind.' + item.kind) : '';
    },
    referenceRechercheText(item) {
      return item?.title || item?.body || '';
    },
  }));
}
