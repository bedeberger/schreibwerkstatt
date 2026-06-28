import { escHtml } from './utils.js';

import { historyMethods } from './book/history.js';
import { treeMethods } from './book/tree.js';
import { treeContextMenuMethods } from './book/tree-context-menu.js';
import { diaryCalendarMethods } from './book/diary-calendar.js';
import { lektoratMethods } from './editor/lektorat.js';
// readNormalSnapshot/clearNormalSnapshot werden in editor-notebook-card.js via
// notebook/card.js konsumiert (Restore-Lifecycle dort).
import { kapitelReviewMethods } from './book/kapitel-review.js';
import { figurenMethods } from './book/figuren.js';
import { ereignisseMethods } from './book/ereignisse.js';
import { writingTimeMethods } from './book/writing-time.js';
import { sttTimeMethods } from './book/stt-time.js';
import { lektoratTimeMethods } from './book/lektorat-time.js';
import { szenenMethods } from './book/szenen.js';
import { orteMethods } from './book/orte.js';
import { songsMethods } from './book/songs.js';
import { i18nMethods } from './i18n.js';
import { pageViewMethods } from './book/page-view.js';
import { notebookTrampoline } from './editor/notebook/trampoline.js';
import { focusMethods } from './editor/focus.js';
import { sttDictationMethods } from './editor/notebook/stt-dictation.js';
import { ttsProofMethods } from './editor/notebook/tts-proof.js';
import { synonymMethods } from './editor/synonyme.js';
import { figurLookupMethods } from './editor/figur-lookup.js';
import { shortcutsMethods } from './editor/shortcuts.js';
import { featuresUsageMethods } from './features-usage.js';
import { initialLektoratState } from './app/app-state.js';
import { appUiMethods, applySzenenFilters, applySongsFilters } from './app/app-ui.js';
import { appChromeMethods } from './app/app-chrome.js';
import { appKomplettMethods } from './app/app-komplett.js';
import { appJobsCoreMethods } from './app/app-jobs-core.js';
import { appCollabMethods } from './app/app-collab.js';
import { appViewMethods } from './app/app-view.js';
import { appNavigationMethods } from './app/app-navigation.js';
import { appHashRouterMethods } from './app/app-hash-router.js';
import { bookCreateMethods } from './book/book-create.js';
import { rootGetterDescriptors } from './app/app-root-getters.js';
import { appInitMethods } from './app/app-init.js';
import { installFetchGuard } from './app/boot/fetch-guard.js';
import { registerServiceWorker } from './app/boot/sw-register.js';
import { setupInternalLinkA11y } from './app/boot/internal-links.js';
import { registerAppMagics, registerAllCards } from './app/register-cards.js';

// ── Boot (vor alpine:init) ───────────────────────────────────────────────────
installFetchGuard();
registerServiceWorker();
setupInternalLinkA11y();

document.addEventListener('alpine:init', () => {
  registerAppMagics();
  registerAllCards();

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
    get zeitstrahlChronology() { return Alpine.store('catalog').zeitstrahlChronology; },
    set zeitstrahlChronology(v) { Alpine.store('catalog').zeitstrahlChronology = v; },

    // ── Nav-Proxy ──────────────────────────────────────────────────────────────
    // books, selectedBookId, pages, tree leben in Alpine.store('nav') (geteilt
    // mit ~29 Reader-Modulen). Root exponiert sie als direkt adressierbare
    // Properties, damit this.selectedBookId= / this.tree.push weiter
    // funktionieren. Karten können auch direkt via $store.nav zugreifen.
    get books() { return Alpine.store('nav').books; },
    set books(v) { Alpine.store('nav').books = v; },
    get selectedBookId() { return Alpine.store('nav').selectedBookId; },
    set selectedBookId(v) { Alpine.store('nav').selectedBookId = v; },
    get pages() { return Alpine.store('nav').pages; },
    set pages(v) { Alpine.store('nav').pages = v; },
    get tree() { return Alpine.store('nav').tree; },
    set tree(v) { Alpine.store('nav').tree = v; },

    // ── STT-Proxy ──────────────────────────────────────────────────────────────
    // STT-Diktat-State lebt in Alpine.store('stt'). Root exponiert ihn unter den
    // gewohnten Namen (this.sttRecording = …), damit stt-dictation.js/stt-time.js/
    // Edit-Lifecycle/figur-lookup.js und die bare Template-Bindings unverändert
    // bleiben (inkl. $watch('sttRecording')). Karten greifen via $store.stt zu.
    get sttEnabled() { return Alpine.store('stt').enabled; },
    set sttEnabled(v) { Alpine.store('stt').enabled = v; },
    get sttVad() { return Alpine.store('stt').vad; },
    set sttVad(v) { Alpine.store('stt').vad = v; },
    get sttRecording() { return Alpine.store('stt').recording; },
    set sttRecording(v) { Alpine.store('stt').recording = v; },
    get sttPending() { return Alpine.store('stt').pending; },
    set sttPending(v) { Alpine.store('stt').pending = v; },
    get sttTranscribing() { return Alpine.store('stt').transcribing; },
    set sttTranscribing(v) { Alpine.store('stt').transcribing = v; },
    get sttBusy() { return Alpine.store('stt').busy; },
    set sttBusy(v) { Alpine.store('stt').busy = v; },
    get sttCaretUserSet() { return Alpine.store('stt').caretUserSet; },
    set sttCaretUserSet(v) { Alpine.store('stt').caretUserSet = v; },

    // ── Config-Proxy ─────────────────────────────────────────────────────────
    // Read-only /config-Settings leben in Alpine.store('config') (einmalig in
    // app-init.js aus /config gesetzt). Root exponiert sie unter denselben Namen,
    // damit Templates ($app.languagetoolEnabled), orte-map.js (window.__app.mapTiles)
    // und $watch('languagetoolEnabled') unverändert bleiben. Via $store.config lesbar.
    get mapTiles() { return Alpine.store('config').mapTiles; },
    set mapTiles(v) { Alpine.store('config').mapTiles = v; },
    get languagetoolEnabled() { return Alpine.store('config').languagetoolEnabled; },
    set languagetoolEnabled(v) { Alpine.store('config').languagetoolEnabled = v; },
    get languagetoolDebounceMs() { return Alpine.store('config').languagetoolDebounceMs; },
    set languagetoolDebounceMs(v) { Alpine.store('config').languagetoolDebounceMs = v; },
    get researchChatEnabled() { return Alpine.store('config').researchChatEnabled; },
    set researchChatEnabled(v) { Alpine.store('config').researchChatEnabled = v; },

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
    // Szenen-Anzahl pro Figur (nur Figuren mit ≥1 Szene), in Figuren-Reihenfolge.
    // `wenig` markiert unterrepräsentierte Figuren (< 3 Szenen) für die
    // Übersichts-Badges. Ersetzt die doppelte Inline-Filterung im Template.
    get szenenNachFigur() {
      const counts = new Map();
      for (const s of this.szenen) {
        for (const id of (s.fig_ids || [])) counts.set(id, (counts.get(id) || 0) + 1);
      }
      const out = [];
      for (const f of this.figuren) {
        const total = counts.get(f.id) || 0;
        if (total === 0) continue;
        out.push({ id: f.id, name: f.kurzname || f.name, total, wenig: total < 3 });
      }
      return out;
    },
    // Szenen-Anzahl pro Wertung (Default 'mittel' bei fehlender Wertung) für die
    // Filter-Tabs. Ein Scan statt 6 Inline-Filter-Durchläufen pro Render.
    get szenenWertungCounts() {
      const c = { stark: 0, mittel: 0, schwach: 0 };
      for (const s of this.szenen) {
        const w = s.wertung || 'mittel';
        if (w in c) c[w]++;
      }
      return c;
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
      // Memo: Schlüssel aus den Eingaben, die das Ergebnis bestimmen (orte-/
      // szenen-Referenz + Filterwerte). Bei Treffer dieselbe Array-Referenz →
      // stabile x-for-Keys, und orteMapped()/unlocatedOrte() teilen sich das eine
      // gefilterte Array statt es je neu zu rechnen. lat/lng-Mutationen ändern die
      // Referenz nicht, fliessen aber als Live-Reads in die nachgelagerten Karten-
      // Filter ein (kein Cache-Problem — Koordinaten sind hier kein Filterkriterium).
      const f = this.orteFilters;
      const sig = [this.orte, this.szenen, f.suche || '', f.figurId || '', f.kapitel || '', f.szeneId || ''];
      const c = this._orteFilteredCache;
      if (c && c.sig.length === sig.length && c.sig.every((v, i) => v === sig[i])) return c.val;
      const val = this._computeOrteFiltered();
      this._orteFilteredCache = { sig, val };
      return val;
    },
    _computeOrteFiltered() {
      const f = this.orteFilters;
      const q = f.suche ? f.suche.toLowerCase() : '';
      const matchText = (o) => !q || [o.name, o.typ, o.stimmung, o.beschreibung, o.land]
        .some(v => v && String(v).toLowerCase().includes(q));
      return this.orte.filter(o =>
        matchText(o) &&
        (!f.figurId || (o.figuren || []).includes(f.figurId)) &&
        (!f.kapitel || (o.kapitel || []).some(k => k.name === f.kapitel || String(k.chapter_id) === String(f.kapitel))) &&
        (!f.szeneId || this.szenen.some(s => String(s.id) === String(f.szeneId) && (s.ort_ids || []).includes(o.id)))
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

    // ── Methoden aus Modulen ─────────────────────────────────────────────────
    // init() + destroy() (Root-Lifecycle) leben in app/app-init.js.
    ...appInitMethods,
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
    ...ttsProofMethods,
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
