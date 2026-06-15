import { fetchJson, configureTokenEstimate, configureAppTimezone, escHtml } from './utils.js';
import { configurePrompts } from './prompts.js';
import { setFilters } from './local-prefs.js';

import { historyMethods } from './book/history.js';
import { treeMethods } from './book/tree.js';
import { treeContextMenuMethods } from './book/tree-context-menu.js';
import { diaryCalendarMethods } from './book/diary-calendar.js';
import { lektoratMethods } from './editor/lektorat.js';
// readNormalSnapshot/clearNormalSnapshot werden in editor-notebook-card.js via
// notebook/card.js konsumiert (Restore-Lifecycle dort).
import { kapitelReviewMethods } from './book/kapitel-review.js';
import { registerBookReviewCard } from './cards/book-review-card.js';
import { registerKapitelReviewCard } from './cards/kapitel-review-card.js';
import { figurenMethods } from './book/figuren.js';
import { ereignisseMethods } from './book/ereignisse.js';
import { registerBookOverviewCard } from './cards/book-overview-card.js';
import { registerBookStatsCard } from './cards/book-stats-card.js';
import { writingTimeMethods } from './book/writing-time.js';
import { sttTimeMethods } from './book/stt-time.js';
import { lektoratTimeMethods } from './book/lektorat-time.js';
import { registerCatalogStore } from './cards/catalog-store.js';
import { registerEreignisseCard } from './cards/ereignisse-card.js';
import { registerOrteCard } from './cards/orte-card.js';
import { registerSongsCard } from './cards/songs-card.js';
import { registerSzenenCard } from './cards/szenen-card.js';
import { registerPlotCard } from './cards/plot-card.js';
import { registerWorldFactsCard } from './cards/world-facts-card.js';
import { registerFigurenCard } from './cards/figuren-card.js';
import { registerFigurWerkstattCard } from './cards/figur-werkstatt-card.js';
import { registerStilCard } from './cards/stil-card.js';
import { registerFehlerHeatmapCard } from './cards/fehler-heatmap-card.js';
import { registerChatCard } from './cards/chat-card.js';
import { registerIdeenCard } from './cards/ideen-card.js';
import { registerBookChatCard } from './cards/book-chat-card.js';
import { szenenMethods } from './book/szenen.js';
import { orteMethods } from './book/orte.js';
import { songsMethods } from './book/songs.js';
import { registerKontinuitaetCard } from './cards/kontinuitaet-card.js';
import { registerTagebuchRueckblickCard } from './cards/tagebuch-rueckblick-card.js';
import { registerBookSettingsCard } from './cards/book-settings-card.js';
import { registerUserSettingsCard } from './cards/user-settings-card.js';
import { registerAdminUsersCard } from './cards/admin-users-card.js';
import { registerAdminSettingsCard } from './cards/admin-settings-card.js';
import { registerAdminUsageCard } from './cards/admin-usage-card.js';
import { registerAdminCategoriesCard } from './cards/admin-categories-card.js';
import { registerAdminBooksCard } from './cards/admin-books-card.js';
import { registerAdminLogsCard } from './cards/admin-logs-card.js';
import { registerAdminParseFailsCard } from './cards/admin-parse-fails-card.js';
import { registerAdminJsErrorsCard } from './cards/admin-js-errors-card.js';
import { registerFinetuneExportCard } from './cards/finetune-export-card.js';
import { registerExportCard } from './cards/export-card.js';
import { registerPdfExportCard } from './cards/pdf-export-card.js';
import { registerEpubExportCard } from './cards/epub-export-card.js';
import { registerBookOrganizerCard } from './cards/book-organizer-card.js';
import { registerBookEditorCard } from './cards/book-editor-card.js';
import { registerSearchCard } from './cards/search-card.js';
import { registerFolderImportCard } from './cards/folder-import-card.js';
import { registerShareLinksCard } from './cards/share-links-card.js';
import { configureI18n, i18nMethods, getSupportedLocales } from './i18n.js';
import { pageViewMethods } from './book/page-view.js';
import { notebookTrampoline } from './editor/notebook/trampoline.js';
import { registerEditorFindCard } from './cards/editor-find-card.js';
import { focusMethods } from './editor/focus.js';
import { sttDictationMethods } from './editor/notebook/stt-dictation.js';
import { synonymMethods } from './editor/synonyme.js';
import { registerEditorSynonymeCard } from './cards/editor-synonyme-card.js';
import { figurLookupMethods } from './editor/figur-lookup.js';
import { registerEditorFigurLookupCard } from './cards/editor-figur-lookup-card.js';
import { registerEditorToolbarCard } from './cards/editor-toolbar-card.js';
import { registerEditorFocusCard } from './cards/editor-focus-card.js';
import { registerEditorNotebookCard } from './cards/editor-notebook-card.js';
import { registerEditorEntitiesCard } from './cards/editor-entities-card.js';
import { registerEditorSpellcheckCard } from './cards/editor-spellcheck-card.js';
import { setupSpellcheckDispatch } from './cards/editor-spellcheck/dispatch.js';
import { registerLektoratFindingsCard } from './cards/lektorat-findings-card.js';
import { registerPageHistoryCard } from './cards/page-history-card.js';
import { registerPageRevisionsCard } from './cards/page-revisions-card.js';
import { registerPaletteCard } from './cards/palette-card.js';
import { registerBlogSyncCard } from './cards/blog-sync-card.js';
import { registerHubspotSyncCard } from './cards/hubspot-sync-card.js';
import { registerNumInput } from './num-input.js';
import { registerCombobox } from './combobox.js';
import { registerSortableTable } from './sortable-table.js';
import { registerCatalogFilter } from './catalog-filter.js';
import { shortcutsMethods } from './editor/shortcuts.js';
import { featuresUsageMethods } from './features-usage.js';
import { initialLektoratState } from './app/app-state.js';
import { appUiMethods, applySzenenFilters, applySongsFilters } from './app/app-ui.js';
import { appChromeMethods } from './app/app-chrome.js';
import { appKomplettMethods } from './app/app-komplett.js';
import { appJobsCoreMethods } from './app/app-jobs-core.js';
import { appCollabMethods } from './app/app-collab.js';
import { appViewMethods, FILTER_SCOPES } from './app/app-view.js';
import { appNavigationMethods } from './app/app-navigation.js';
import { appHashRouterMethods } from './app/app-hash-router.js';
import { bookCreateMethods } from './book/book-create.js';
import { rootGetterDescriptors } from './app/app-root-getters.js';

// Globaler fetch-Wrapper: fängt 401-Antworten ab und signalisiert Session-Ablauf
// via 'session-expired'-Event. Alpine zeigt daraufhin einen Banner. Kein Auto-
// Redirect – User soll ungespeicherte Änderungen (Editor, Chat) retten können.
const __origFetch = window.fetch.bind(window);
window.fetch = async function(...args) {
  const res = await __origFetch(...args);
  if (res.status === 401 && !window.__sessionExpiredNotified) {
    window.__sessionExpiredNotified = true;
    window.dispatchEvent(new CustomEvent('session-expired'));
  }
  return res;
};

// Service Worker: cached SPA-Shell für Offline/Zug-Modus. Nur über HTTPS bzw.
// localhost registrierbar. Fehler schlucken – SW ist Progressive Enhancement.
// Dev/Localhost: SW deaktiviert (Cache-Artefakte beim Entwickeln eklig).
// Override pro Browser via `localStorage.setItem('sw', '1')` (an) bzw. `'0'` (aus).
if ('serviceWorker' in navigator) {
  const swPref = localStorage.getItem('sw');
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const swEnabled = swPref === '1'
    || (swPref !== '0' && location.protocol === 'https:' && !isLocal);

  if (swEnabled) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        // Periodisch nach Updates fragen — ohne aktiven update()-Call wartet
        // der Browser u.U. Stunden bis Tage, bis er einen neuen SW
        // einspielt; v.a. auf Mobile (Tab im Hintergrund / SW gekillt) sieht
        // der User Frontend-Updates dann nie. 60s ist günstig: minimale
        // Bandbreite (nur sw.js wird revalidiert), schnelle Sichtbarkeit.
        setInterval(() => { reg.update().catch(() => {}); }, 60_000);
        const notify = (worker) => {
          if (!worker || !navigator.serviceWorker.controller) return;
          window.__pendingWorker = worker;
          window.dispatchEvent(new CustomEvent('app:update-available'));
        };
        if (reg.waiting) notify(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw?.addEventListener('statechange', () => {
            if (nw.state === 'installed') notify(nw);
          });
        });
        // Controllerchange feuert erst, nachdem der User das Update-Banner
        // bestätigt hat (applyUpdate → 'skip-waiting' → SW aktiviert; sw.js
        // macht bewusst kein skipWaiting/clients.claim beim Deploy). Bis dahin
        // bedient der ALTE SW die laufende Seite kohärent (alte Partials + alte
        // Module). Auto-Reload hier nur, wenn der Editor nicht dirty ist —
        // sonst Banner stehen lassen, damit der User erst speichern kann.
        // hadController-Snapshot: beim First-Install (Tab ohne Controller
        // geladen) feuert clients.claim() ein controllerchange — ohne Snapshot
        // würde die Seite direkt nach dem ersten Laden nochmal reloaden.
        const hadController = !!navigator.serviceWorker.controller;
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadController) return;
          if (reloaded) return;
          reloaded = true;
          const app = window.__app;
          // Niemals auto-reloaden, wenn der User aktiv editiert oder im
          // Fokusmodus liest/schreibt. Auto-Save kann editDirty zwischendurch
          // auf false flippen — focusActive/editMode als härteres Signal.
          if (app?.editMode || app?.focusActive || app?.editDirty) {
            app.updateAvailable = true;
            return;
          }
          // Offline nicht reloaden: der frisch aktivierte SW hat die alte
          // SHELL_CACHE-Version (mit allen JS-Modulen) gelöscht, der neue Cache
          // hält nur die Shell. Ein Reload würde die Module per Netz nachladen —
          // offline scheitert das, Alpine bootet nicht, der Body bleibt hinter
          // dem data-app-loading-Gate unsichtbar (schwarz). Stattdessen Banner;
          // Reload kommt beim nächsten Online-Wechsel.
          if (!navigator.onLine) {
            if (app) app.updateAvailable = true;
            window.addEventListener('online', () => location.reload(), { once: true });
            return;
          }
          location.reload();
        });
      } catch {}
    });
  } else {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
    if (window.caches) {
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .catch(() => {});
    }
  }
}

// `.internal-link`-Spans verhalten sich wie Buttons (z.B. Kapitel-Sprünge,
// Figuren-Öffnen). Per Delegation und MutationObserver machen wir sie
// tastatur-erreichbar (Tab/Enter/Space), ohne in jedem Partial role/tabindex
// setzen zu müssen. `:focus-visible`-Stil kommt aus style.css.
const decorateInternalLinks = (root) => {
  root.querySelectorAll?.('.internal-link').forEach(el => {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  });
};
new MutationObserver(muts => {
  for (const m of muts) {
    if (m.type === 'attributes') {
      // `:class="…internal-link…"`-Toggles auf bereits gemounteten Elementen
      // tauchen nicht in addedNodes auf; ohne attributeFilter würde A11y dort
      // nie greifen (Tab/Enter würde den Klick nicht auslösen).
      const t = m.target;
      if (t?.nodeType === 1 && t.classList?.contains('internal-link')) {
        if (!t.hasAttribute('role')) t.setAttribute('role', 'button');
        if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '0');
      }
      continue;
    }
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList?.contains('internal-link')) {
        if (!n.hasAttribute('role')) n.setAttribute('role', 'button');
        if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
      }
      decorateInternalLinks(n);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t?.classList?.contains?.('internal-link')) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    t.click();
  }
});

document.addEventListener('alpine:init', () => {
  // Magic `$app` — verweist auf die `lektorat`-Root-Komponente am body. In
  // Alpine ist `$root` das nächste x-data-Element (bei Sub-Komponenten also die
  // Sub selbst), nicht die Top-Level-Komponente. Sub-Komponenten und Partials
  // greifen über $app auf Root-Methoden und geteilten State zu. Die Referenz
  // wird in Root.init() auf window.__app gesetzt (garantiert reactive proxy) —
  // Alpine.$data(document.body) liefert bei manchen Getter-Evaluationen undefined.
  Alpine.magic('app', () => window.__app || Alpine.$data(document.body));
  // Magic `$blog` — verweist auf den blogSyncCard-Anker (display-contents
  // <div x-data="blogSyncCard"> in index.html). Setzt sich in Card.init()
  // selbst auf window.__blogCard.
  Alpine.magic('blog', () => window.__blogCard);
  // Magic `$hubspot` — analog zu $blog, verweist auf den hubspotSyncCard-Anker.
  Alpine.magic('hubspot', () => window.__hubspotCard);
  // Magic `$syncProviders` — Liste aller verbundenen Sync-Provider, sortiert
  // nach Registrierungsreihenfolge (blog, hubspot, …). Templates iterieren
  // hierüber statt copy-paste pro Provider; jeder Eintrag hat `{ key, card }`.
  // Reaktiv via `.connected`-Lesen am Card-Proxy.
  Alpine.magic('syncProviders', () => {
    const candidates = [
      { key: 'blog', card: window.__blogCard },
      { key: 'hubspot', card: window.__hubspotCard },
    ];
    return candidates.filter(p => p.card && p.card.connected);
  });

  registerCatalogStore();
  registerStilCard();
  registerFehlerHeatmapCard();
  registerBookOverviewCard();
  registerBookStatsCard();
  registerBookSettingsCard();
  registerUserSettingsCard();
  registerAdminUsersCard();
  registerAdminSettingsCard();
  registerAdminUsageCard();
  registerAdminCategoriesCard();
  registerAdminBooksCard();
  registerAdminLogsCard();
  registerAdminParseFailsCard();
  registerAdminJsErrorsCard();
  registerFinetuneExportCard();
  registerExportCard();
  registerPdfExportCard();
  registerEpubExportCard();
  registerBookOrganizerCard();
  registerBookEditorCard();
  registerSearchCard();
  registerFolderImportCard();
  registerShareLinksCard();
  registerKontinuitaetCard();
  registerTagebuchRueckblickCard();
  registerEreignisseCard();
  registerOrteCard();
  registerSongsCard();
  registerSzenenCard();
  registerPlotCard();
  registerWorldFactsCard();
  registerFigurenCard();
  registerFigurWerkstattCard();
  registerBookReviewCard();
  registerKapitelReviewCard();
  registerChatCard();
  registerIdeenCard();
  registerBookChatCard();
  registerEditorFindCard();
  registerEditorFigurLookupCard();
  registerEditorSynonymeCard();
  registerEditorToolbarCard();
  registerEditorFocusCard();
  registerEditorNotebookCard();
  registerEditorEntitiesCard();
  registerEditorSpellcheckCard();
  registerLektoratFindingsCard();
  registerPageHistoryCard();
  registerPageRevisionsCard();
  registerPaletteCard();
  registerBlogSyncCard();
  registerHubspotSyncCard();
  registerNumInput();
  registerCombobox();
  registerSortableTable();
  registerCatalogFilter();

  Alpine.data('lektorat', () => {
    // Root-Getter (z.B. tokTotals) leben in app/app-root-getters.js als
    // Property-Descriptors. Object-Spread würde Getter zur Spread-Zeit
    // einmalig auswerten und als statischen Wert kopieren — darum
    // descriptor-basiertes Object.defineProperties auf dem fertigen Objekt.
    const obj = ({
    // ── State ────────────────────────────────────────────────────────────────
    ...initialLektoratState(),

    // ── Catalog-Proxy ────────────────────────────────────────────────────────
    // Figuren, Orte, Szenen, globalZeitstrahl leben in Alpine.store('catalog').
    // Root exponiert sie als direkt adressierbare Properties, damit this.figuren=
    // / this.orte.push weiter funktionieren. Karten können auch direkt via
    // $store.catalog zugreifen.
    get figuren() { return Alpine.store('catalog').figuren; },
    set figuren(v) { Alpine.store('catalog').figuren = v; },
    get orte() { return Alpine.store('catalog').orte; },
    set orte(v) { Alpine.store('catalog').orte = v; },
    get songs() { return Alpine.store('catalog').songs; },
    set songs(v) { Alpine.store('catalog').songs = v; },
    get szenen() { return Alpine.store('catalog').szenen; },
    set szenen(v) { Alpine.store('catalog').szenen = v; },
    get globalZeitstrahl() { return Alpine.store('catalog').globalZeitstrahl; },
    set globalZeitstrahl(v) { Alpine.store('catalog').globalZeitstrahl = v; },

    // ── Computed ─────────────────────────────────────────────────────────────
    // Admin-only View: Globaler Admin (global_role='admin') bekommt eine
    // reduzierte Oberfläche — keine Sidebar, keine Buchwahl, nur Admin-Tiles
    // als Landing. Dev-Mode-Admin (LOCAL_DEV_MODE) bleibt davon ausgenommen,
    // damit lokale Entwicklung mit Admin-Konto die volle UI behält.
    get isAdminOnly() {
      return !!this.currentUser?.isAdmin && !this.devMode;
    },
    // O(1)-Lookup-Maps für Figuren/Orte. Rebuild nur bei Referenz-Wechsel
    // (loadFiguren/loadOrte reassignen, pushen nie). In Render-Loops
    // (figuren.html, orte.html, szenen.html) ersetzen diese ein vielfaches
    // `.find(x => x.id === id)` pro Zeile durch einen Map-Lookup.
    get figurenById() {
      if (this._figMapRef !== this.figuren) {
        this._figMapRef = this.figuren;
        this._figMap = new Map((this.figuren || []).map(f => [f.id, f]));
      }
      return this._figMap;
    },
    get orteById() {
      if (this._ortMapRef !== this.orte) {
        this._ortMapRef = this.orte;
        this._ortMap = new Map((this.orte || []).map(o => [o.id, o]));
      }
      return this._ortMap;
    },
    get szenenById() {
      if (this._szeneMapRef !== this.szenen) {
        this._szeneMapRef = this.szenen;
        this._szeneMap = new Map((this.szenen || []).map(s => [s.id, s]));
      }
      return this._szeneMap;
    },

    get szenenNachKapitel() {
      const map = new Map();
      for (const s of this.szenen) {
        if (!s.kapitel) continue;
        if (!map.has(s.kapitel)) map.set(s.kapitel, { total: 0, stark: 0, mittel: 0, schwach: 0 });
        const e = map.get(s.kapitel);
        e.total++;
        if (s.wertung === 'stark')        e.stark++;
        else if (s.wertung === 'mittel')  e.mittel++;
        else if (s.wertung === 'schwach') e.schwach++;
      }
      return [...map.entries()].map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => this._chapterIdx(a.name) - this._chapterIdx(b.name));
    },
    get szenenNachSeite() {
      const map = new Map();
      for (const s of this.szenen) {
        if (!s.seite) continue;
        if (!map.has(s.seite)) map.set(s.seite, { total: 0, kapitel: s.kapitel });
        map.get(s.seite).total++;
      }
      return [...map.entries()].map(([name, d]) => ({ name, total: d.total, kapitel: d.kapitel }))
        .sort((a, b) => {
          const c = this._chapterIdx(a.kapitel) - this._chapterIdx(b.kapitel);
          return c !== 0 ? c : this._pageIdx(a.name) - this._pageIdx(b.name);
        });
    },
    get songsFiltered() {
      return applySongsFilters(this.songs, this.songsFilters).sort((a, b) => {
        const aK = Math.min(...(a.kapitel || []).map(k => this._chapterIdx(k.name)), 9999);
        const bK = Math.min(...(b.kapitel || []).map(k => this._chapterIdx(k.name)), 9999);
        if (aK !== bK) return aK - bK;
        return (a.titel || '').localeCompare(b.titel || '', 'de');
      });
    },
    get songsByFigurId() {
      const map = new Map();
      for (const s of (this.songs || [])) {
        for (const f of (s.figuren || [])) {
          const id = f.fig_id || f;
          if (!id) continue;
          if (!map.has(id)) map.set(id, []);
          map.get(id).push(s);
        }
      }
      return map;
    },
    get orteFiltered() {
      const q = this.orteFilters.suche ? this.orteFilters.suche.toLowerCase() : '';
      return this.orte.filter(o =>
        (!q || (o.name || '').toLowerCase().includes(q)) &&
        (!this.orteFilters.figurId || (o.figuren || []).includes(this.orteFilters.figurId)) &&
        (!this.orteFilters.kapitel || (o.kapitel || []).some(k => k.name === this.orteFilters.kapitel || String(k.chapter_id) === String(this.orteFilters.kapitel))) &&
        (!this.orteFilters.szeneId || this.szenen.some(s => String(s.id) === String(this.orteFilters.szeneId) && (s.ort_ids || []).includes(o.id)))
      ).sort((a, b) => {
        const aK = Math.min(...(a.kapitel || []).map(k => this._chapterIdx(k.name)), 9999);
        const bK = Math.min(...(b.kapitel || []).map(k => this._chapterIdx(k.name)), 9999);
        if (aK !== bK) return aK - bK;
        const aP = this._pageIdIdx(a.erste_erwaehnung_page_id);
        const bP = this._pageIdIdx(b.erste_erwaehnung_page_id);
        if (aP !== bP) return aP - bP;
        return (a.name || '').localeCompare(b.name || '', 'de');
      });
    },
    get szenenFiltered() {
      return applySzenenFilters(this.szenen, this.szenenFilters).sort((a, b) => {
        const c = this._chapterIdx(a.kapitel) - this._chapterIdx(b.kapitel);
        if (c !== 0) return c;
        const p = this._pageIdx(a.seite) - this._pageIdx(b.seite);
        if (p !== 0) return p;
        return (a.titel || '').localeCompare(b.titel || '', 'de');
      });
    },

    get statusHtml() {
      if (!this.status) return '';
      const safe = escHtml(this.status);
      return this.statusSpinner
        ? `<span class="spinner"></span>${safe}`
        : safe;
    },

    // Zielseiten/-kapitel für Ideen-Verschieben-Combobox.
    // Scope 'page': Seiten gleichen Kapitels, aktuelle Seite ausgeschlossen.
    // Scope 'chapter': andere Kapitel des Buches, aktuelles Kapitel ausgeschlossen.
    // Liegt am Root, weil x-effect der Combobox-Sub-x-data nur $app/Magics,
    // nicht Karten-Methoden sieht.
    ideenMovePickerOptions() {
      const tree = this.tree || [];
      if (this.ideenScope === 'chapter') {
        const curCid = this.ideenChapterId;
        return tree
          .filter(it => it.type === 'chapter' && !it.solo && it.id !== curCid)
          .map(it => ({ value: it.id, label: it.name }));
      }
      const cur = this.currentPage;
      if (!cur?.id) return [];
      const pages = cur.chapter_id
        ? (tree.find(it => it.type === 'chapter' && !it.solo && it.id === cur.chapter_id)?.pages || [])
            .filter(p => p.id !== cur.id)
        : tree
            .filter(it => it.type === 'chapter' && it.solo && it.pages[0]?.id !== cur.id)
            .map(it => it.pages[0])
            .filter(Boolean);
      return pages.map(p => ({ value: p.id, label: p.name }));
    },

    get selectedBookName() {
      const book = this.books.find(b => String(b.id) === String(this.selectedBookId));
      return book?.name || '';
    },

    get _numLocale() {
      const region = this.defaultRegion || (this.uiLocale === 'en' ? 'US' : 'CH');
      const lang = this.uiLocale || 'de';
      return `${lang}-${region}`;
    },

    get selectedBookUrl() {
      return null;
    },

    get filteredTree() {
      const tree = this.tree;
      if (!this.pageSearch) {
        const byId = new Map(tree.map(it => [it.id, it]));
        const isVisible = (item) => {
          let cur = item;
          while (cur.parent_id) {
            const parent = byId.get(cur.parent_id);
            if (!parent) break;
            if (!parent.open) return false;
            cur = parent;
          }
          return true;
        };
        return tree.filter(isVisible);
      }
      const q = this.pageSearch.toLowerCase();
      // Memo: Search-Branch ist N²-Gefahr (filteredTree wird pro Page-Row
      // gelesen). Ref-Vergleich `tree` + identische Query → Cache-Hit.
      const memo = this._filteredTreeMemo;
      if (memo && memo.tree === tree && memo.q === q) return memo.val;
      // Erste Pass: Kapitel mit matchenden Seiten finden.
      const matched = new Map(); // chapter-id -> filtered-pages[]
      for (const item of tree) {
        if (item.solo) {
          if (item.name.toLowerCase().includes(q) || item.pages[0]?.name?.toLowerCase().includes(q)) {
            matched.set(item.id, item.pages);
          }
          continue;
        }
        const pages = item.pages.filter(p => p.name.toLowerCase().includes(q));
        if (pages.length) matched.set(item.id, pages);
      }
      // Zweite Pass: Vorfahren matchender Kapitel auch aufnehmen (mit leerem
      // Page-Filter), damit nested-Subchapter-Treffer ihren Eltern-Header zeigen.
      const itemById = new Map(tree.map(it => [it.id, it]));
      const addAncestors = (id) => {
        const it = itemById.get(id);
        if (!it?.parent_id) return;
        if (!matched.has(it.parent_id)) matched.set(it.parent_id, []);
        addAncestors(it.parent_id);
      };
      for (const id of [...matched.keys()]) addAncestors(id);
      const val = tree
        .filter(item => matched.has(item.id))
        .map(item => ({ ...item, pages: matched.get(item.id), open: true }));
      this._filteredTreeMemo = { tree, q, val };
      return val;
    },

    // AbortController `_abortCtrl` (initialisiert via app-state.js) hält alle
    // globalen Listener dieser Komponente. `destroy()` (Alpine-Hook) ruft abort()
    // → alle Listener werden automatisch entfernt. Schützt vor doppelter
    // Registrierung bei Re-Init.
    destroy() {
      this._abortCtrl?.abort();
      if (this._jobQueueTimer) clearInterval(this._jobQueueTimer);
      if (this._statusTimer) clearTimeout(this._statusTimer);
      if (typeof this._teardownStatsObserver === 'function') this._teardownStatsObserver();
    },

    // ── Initialisierung ──────────────────────────────────────────────────────
    async init() {
      // Referenz für $app-Magic (siehe oben).
      window.__app = this;
      // Boot erfolgreich → Watchdog-Flag (failsafe-reveal.js) zurücksetzen,
      // damit ein künftiger echter Boot-Fehler wieder einmalig reloaden darf
      // und späte Lazy-Load-Fehler keinen Reload mehr auslösen.
      try { sessionStorage.removeItem('bootReloadDone'); } catch (_) {}
      this._abortCtrl?.abort();
      this._abortCtrl = new AbortController();
      const signal = this._abortCtrl.signal;
      // Tracking-Watcher früh registrieren, damit auch Karten-Öffnungen
      // während der initialen Hash-Anwendung erfasst werden.
      this.setupFeatureUsageWatchers();
      setupSpellcheckDispatch(this);
      // Plattform-Detect für Tasten-Hints (⌘ vs. Ctrl).
      const ua = navigator.userAgent || '';
      const plat = navigator.platform || '';
      this.isMac = /Mac|iPhone|iPad|iPod/.test(plat) || /Mac OS X/.test(ua);
      this.themePref = window.__themePref || 'auto';
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.themePref === 'auto') this._applyTheme();
      }, { signal });
      window.addEventListener('session-expired', () => { this.sessionExpired = true; }, { signal });
      window.addEventListener('job:finished', (e) => this._onJobFinished(e.detail), { signal });
      this._initSttDictation?.(signal);
      // Sleep/Wake-Recovery: bei längerer Hide-Phase (>30 s) Daten neu laden,
      // sonst bleiben Listen leer (in-flight Fetches sterben mit TCP-Socket).
      let _hiddenAt = 0;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { _hiddenAt = Date.now(); return; }
        if (!_hiddenAt) return;
        const delta = Date.now() - _hiddenAt;
        _hiddenAt = 0;
        if (delta < 30_000) return;
        this._refreshAfterWake();
      }, { signal });
      window.addEventListener('beforeunload', (e) => {
        if (this.editMode && this.editDirty) { e.preventDefault(); e.returnValue = ''; }
        // Best-Effort: eigenen Soft-Lock + Presence-Eintrag freigeben, damit
        // andere User nicht 30 Min auf einen verwaisten „X editiert"-Hinweis
        // schauen. fetch + keepalive:true ueberlebt den Unload.
        if (this.editMode && this.currentPage?.id) {
          this._beaconReleaseEditLock?.(this.currentPage.id);
          this._sendPresenceLeave?.(this.currentPage.id);
        }
        // Buch-Level-Geraete-Ping freigeben, damit das eigene Zweit-Geraet nicht
        // 90s lang einen verwaisten „auch hier offen"-Hinweis sieht.
        if (this._bookDevicePingBookId) this._sendBookDeviceLeave?.(this._bookDevicePingBookId);
      }, { signal });
      // Kapitel-Stats werden bei jeder tokEsts-Reassignment neu berechnet.
      // Mutationen via Index-Assign (this.tokEsts[id] = …) feuern den Watcher
      // nicht — solche Pfade müssen _refreshChapterStats() selbst aufrufen.
      // Kein $watch('tree') — refresh mutiert item.stats und würde sich rekursiv
      // selbst triggern (Alpine-Deep-Reactivity → Browser-Freeze).
      this.$watch('tokEsts', () => this._refreshChapterStats());
      // Seitenwechsel → page-scoped Presence neu melden (welche Seite dieses
      // Geraet jetzt offen hat). Steuert, ob der teure Collab-Poll laeuft.
      this.$watch(() => this.currentPage?.id, () => this._pingDevicePresenceNow?.());
      // Sidebar-Suche: bei jedem (debounced) pageSearch-Write Index auf
      // ersten Treffer und kbd-aktive Page-ID neu setzen.
      this.$watch('pageSearch', () => {
        this.pageSearchActiveIndex = 0;
        this._recomputePageSearchActiveId();
      });
      // Shell zuerst aufbauen: i18n + Partials brauchen nur statische Assets
      // (Service Worker cacht sie). /config kann danach scheitern, ohne dass
      // das UI leer bleibt – Offline-Banner erscheint stattdessen.
      //
      // Reveal-Gate: `html[data-app-loading]` versteckt Body bis kompletter
      // Boot durch. Attribut wird ausschliesslich im finally entfernt — egal
      // ob i18n scheitert, /config offline ist oder Bootstrap durchläuft.
      // Ergebnis: ein einziger Reveal-Frame, kein Pop-In zwischen
      // i18n-Ready → currentUser-Ready → Books-Ready.
      const browserLoc = (navigator.language || 'de').slice(0, 2);
      const supported  = getSupportedLocales();
      const fallbackLocale = supported.includes(browserLoc) ? browserLoc : 'de';
      try {
      try {
        await configureI18n(fallbackLocale);
        this.uiLocale = fallbackLocale;
        document.documentElement.setAttribute('lang', fallbackLocale);
        await this._loadEssentialPartials();
        this._initSidebarResize();
        this._initSidebarScrollFade();
      } catch (e) {
        console.error('[init:shell]', e);
      }

      let cfg = null;
      try {
        cfg = await fetchJson('/config');
      } catch (e) {
        console.error('[init:config]', e);
        this.serverOffline = true;
        return;
      }

      try {
        const preferred = cfg.userSettings?.locale || browserLoc || 'de';
        const locale = supported.includes(preferred) ? preferred : 'de';
        const region = cfg.userSettings?.default_region || (locale === 'en' ? 'US' : 'CH');
        this.defaultRegion = region;
        if (locale !== this.uiLocale) {
          await configureI18n(locale);
          this.uiLocale = locale;
        }
        document.documentElement.setAttribute('lang', `${locale}-${region}`);
        if (cfg.claudeModel) this.claudeModel = cfg.claudeModel;
        if (cfg.claudeMaxTokens) this.claudeMaxTokens = cfg.claudeMaxTokens;
        if (cfg.apiProvider) this.apiProvider = cfg.apiProvider;
        if (cfg.ollamaModel) this.ollamaModel = cfg.ollamaModel;
        if (cfg.openaiCompatModel) this.openaiCompatModel = cfg.openaiCompatModel;
        this.currentUser = cfg.user || null;
        this.devMode = !!cfg.devMode;
        this.promptConfig = cfg.promptConfig || {};
        if (cfg.userSettings?.theme && cfg.userSettings.theme !== this.themePref) {
          this.themePref = cfg.userSettings.theme;
          try { localStorage.setItem('theme', this.themePref); } catch (e) {}
          this._applyTheme();
        }
        const fg = cfg.userSettings?.focus_granularity;
        if (fg === 'paragraph' || fg === 'sentence' || fg === 'window-3' || fg === 'typewriter-only') {
          this.focusGranularity = fg;
        }
        configurePrompts(cfg.promptConfig, cfg.apiProvider || 'claude');
        configureTokenEstimate(cfg.charsPerToken);
        configureAppTimezone(cfg.appTimezone);
        if (cfg.appTimezone) this.appTimezone = cfg.appTimezone;
        if (cfg.appName) {
          this.appName = cfg.appName;
          document.title = cfg.appName;
          const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
          if (meta) meta.setAttribute('content', cfg.appName);
        }
        if (cfg.appVersion) this.appVersion = cfg.appVersion;
        this.languagetoolEnabled = !!cfg.languagetool?.enabled;
        if (Number.isFinite(cfg.languagetool?.debounceMs)) {
          this.languagetoolDebounceMs = cfg.languagetool.debounceMs;
        }
        this.sttEnabled = !!cfg.stt?.enabled;
        if (cfg.stt?.vad) {
          this.sttVad = {
            silenceMs:   Number(cfg.stt.vad.silenceMs)   || this.sttVad.silenceMs,
            threshold:   Number(cfg.stt.vad.threshold)   || this.sttVad.threshold,
            maxSegmentS: Number(cfg.stt.vad.maxSegmentS) || this.sttVad.maxSegmentS,
          };
        }
        if (cfg.mapTiles?.url) {
          this.mapTiles = {
            url: cfg.mapTiles.url,
            attribution: cfg.mapTiles.attribution || '',
          };
        }

        // Hash vorab auswerten, damit loadBooks das gewünschte Buch wählt.
        // _applyingHash unterdrückt Watcher/URL-Writes während der Initialisierung.
        this._applyingHash = true;
        const hashParts = (location.hash || '').replace(/^#/, '').split('/').filter(Boolean);
        if (hashParts[0] === 'book' && hashParts[1]) {
          this.selectedBookId = hashParts[1];
        }
        // Admin-only-View überspringt Buch-Bootstrap: keine Sidebar, keine
        // Buchwahl, Landing sind die Admin-Tiles (admin-home-Partial).
        if (this.isAdminOnly) {
          await this._ensurePartial('admin-home');
        } else {
          await this.loadBooks();
          // Top-3 Recency-Features für Quick-Pills laden (best-effort).
          this.loadRecentFeatures();
          if (this.selectedBookId) this.loadRecentPages(this.selectedBookId);
          if (this.selectedBookId) this.loadDailyProgress(this.selectedBookId);
          // Gespeicherte Filter pro Buch anwenden, bevor Hash-Router das
          // initiale View setzt (Filter-Restore + Hash-getriebene Argumente
          // koexistieren so deterministisch).
          if (this.selectedBookId) this._restoreBookPrefs(this.selectedBookId);
        }
        await this._applyHash();
        if (!this.isAdminOnly && this.selectedBookId) this._loadBookRole(this.selectedBookId);
        if (!this.isAdminOnly && this.selectedBookId) this._loadEntitiesEnabledForBook(this.selectedBookId);
        if (!this.isAdminOnly) await this._maybeOpenBookOverview();
        this._syncUrlNow();
        this._applyingHash = false;
        if (this.selectedBookId) {
          try {
            localStorage.setItem(`sw:lastBookId:${this.currentUser?.email || ''}`, String(this.selectedBookId));
          } catch (_) {}
        }
        this._setupHashRouting();
        // Buchwechsel (Combobox, Hash-Nav oder programmatisch) → Seiten/Tree neu laden.
        // _applyingHash unterdrückt Doppelladen während Hash-Anwendung.
        // _resetBookScopedState() räumt buchspezifische Daten/Caches ab, damit
        // keine Figuren/Orte/Chats/Stats des alten Buchs im UI stehenbleiben.
        // Filter-Persistenz: deep-watch jeden Filter-Scope, schreibt bei
        // jeder Mutation in localStorage. Restore beim Buchwechsel passiert
        // in `_resetBookScopedState`/`_restoreBookPrefs`; initialer Restore
        // im Hash-Router (isInitialApply-Branch), bevor View-Argumente Filter
        // setzen.
        for (const [key] of FILTER_SCOPES) {
          this.$watch(key, (val) => {
            if (!this.selectedBookId) return;
            setFilters(this.currentUser?.email, this.selectedBookId, key, val);
          }, { deep: true });
        }

        this.$watch('bookFilterCategoryId', (val) => {
          try {
            const key = `sw:bookFilterCategoryId:${this.currentUser?.email || ''}`;
            if (val) localStorage.setItem(key, String(val));
            else localStorage.removeItem(key);
          } catch (_) {}
        });
        this.$watch('entityPanelOpen', (val) => {
          try { localStorage.setItem('sw:entityPanelOpen', val ? '1' : '0'); } catch (_) {}
        });
        this.$watch('selectedBookId', async (newVal, oldVal) => {
          if (this._applyingHash) return;
          if (!newVal) return;
          // Alpine kann den Watcher mit identischem Wert feuern (z.B. bei
          // Combobox-Re-Selection oder String/Number-Coercion). Doppelter
          // _resetBookScopedState löscht User-Eingaben (Filter, offene Karten),
          // also überspringen.
          if (String(newVal) === String(oldVal)) return;
          try {
            localStorage.setItem(`sw:lastBookId:${this.currentUser?.email || ''}`, String(newVal));
          } catch (_) {}
          this._resetBookScopedState();
          this._loadBookRole(newVal);
          this._loadEntitiesEnabledForBook(newVal);
          await this.loadPages({ source: 'bookSwitch' });
          await this._reloadVisibleBookCards();
          this._maybeOpenBookOverview();
          this._startCollabPoll(newVal);
        });
        this._startJobQueuePoll();
        if (this.selectedBookId) this._startCollabPoll(this.selectedBookId);
        this._setupWritingTime();
        this._setupLektoratTime();
        this._setupSttTime();
        // _setupNotebookRestore lebt jetzt in editor-notebook-card.js#init.
      } catch (e) {
        console.error('[init]', e);
        this.setStatus(this.t('app.configLoadError'));
      }
      } finally {
        document.documentElement.removeAttribute('data-app-loading');
        this.appReady = true;
      }
    },

    // ── Methoden aus Modulen ─────────────────────────────────────────────────
    ...historyMethods,
    ...treeMethods,
    ...treeContextMenuMethods,
    ...diaryCalendarMethods,
    ...lektoratMethods,
    ...kapitelReviewMethods,
    ...figurenMethods,
    ...ereignisseMethods,
    // writingTimeMethods bleiben im Root: Schreibzeit-Heartbeat lauscht auf
    // editMode/focusActive, läuft unabhängig von der bookStatsCard-Sichtbarkeit.
    ...writingTimeMethods,
    // lektoratTimeMethods analog: lauscht auf checkDone (Prüfmodus) +
    // currentPage.id + selectedBookId; bucht Sekunden pro (User, Buch, Seite, Tag).
    ...lektoratTimeMethods,
    // sttTimeMethods: lauscht auf sttRecording (Mic aktiv); bucht Diktat-Sekunden
    // + diktierte Zeichen pro (User, Buch, Tag). _trackSttChars wird aus
    // stt-dictation.js beim Einfügen jedes Transkript-Segments aufgerufen.
    ...sttTimeMethods,
    ...szenenMethods,
    ...orteMethods,
    ...songsMethods,
    ...i18nMethods,
    ...pageViewMethods,
    ...notebookTrampoline,
    ...focusMethods,
    ...sttDictationMethods,
    ...synonymMethods,
    ...figurLookupMethods,
    ...shortcutsMethods,
    ...appUiMethods,
    ...appChromeMethods,
    ...appKomplettMethods,
    ...appJobsCoreMethods,
    ...appCollabMethods,
    ...appViewMethods,
    ...appNavigationMethods,
    ...appHashRouterMethods,
    ...featuresUsageMethods,
    ...bookCreateMethods,
    });
    Object.defineProperties(obj, rootGetterDescriptors);
    return obj;
  });
});
