// Tests für app-view: Karten-Exklusivität.
//   - _closeOtherMainCards(keep) schliesst alle Hauptkarten ausser `keep`
//   - Toggle-Funktionen rufen _closeOtherMainCards beim Öffnen
//   - Toggle auf bereits offene Karte: schliesst (Settings/UserSettings/Stil/Heatmap/BookStats/Finetune/BookSettings)
//     oder dispatched card:refresh (Figuren/Orte/Szenen/Ereignisse/Kontinuität/BookReview/BookChat)
//   - Seiten-Chat (showChatCard) ist NICHT in _closeOtherMainCards →
//     bleibt neben Editor offen
import test from 'node:test';
import assert from 'node:assert/strict';
import { appViewMethods } from '../../public/js/app/app-view.js';

// Minimal-DOM-Stubs für Module die window.dispatchEvent nutzen.
globalThis.window = globalThis.window || { dispatchEvent: () => {} };
globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

function makeCtx() {
  // Spiegelt cards-Flags aus app-state.js. Default: alles geschlossen.
  // Nav-State lebt in Alpine.store('nav') (kein Root-Proxy mehr): nav-Objekt
  // unter $store.nav + Getter/Setter-Aliasse fuer c.selectedBookId-Mutationen.
  const nav = { selectedBookId: 42, books: [], pages: [], tree: [] };
  return {
    get selectedBookId() { return nav.selectedBookId; },
    set selectedBookId(v) { nav.selectedBookId = v; },
    get pages() { return nav.pages; },
    set pages(v) { nav.pages = v; },
    get tree() { return nav.tree; },
    set tree(v) { nav.tree = v; },
    get books() { return nav.books; },
    set books(v) { nav.books = v; },
    showBookOverviewCard: false,
    showBookReviewCard: false,
    showKapitelReviewCard: false,
    showFiguresCard: false,
    showFigurWerkstattCard: false,
    showSzenenCard: false,
    showEreignisseCard: false,
    showBookStatsCard: false,
    showStilCard: false,
    showFehlerHeatmapCard: false,
    showBookChatCard: false,
    showOrteCard: false,
    showKontinuitaetCard: false,
    showBookSettingsCard: false,
    showUserSettingsCard: false,
    showFinetuneExportCard: false,
    showExportCard: false,
    showPdfExportCard: false,
    showBookOrganizerCard: false,
    showEditorCard: false,
    showChatCard: false,
    showIdeenCard: false,
    showTreeCard: false,
    // resetView-Pflichtdaten
    bookReviewHistory: [],
    figurenStatus: '',
    figurenProgress: 0,
    selectedFigurId: null,
    figurenFilters: { kapitel: '', seite: '' },
    showGlobalZeitstrahl: false,
    ereignisseFilters: { figurId: '', kapitel: '', seite: '' },
    szenenUpdatedAt: null,
    selectedSzeneId: null,
    szenenFilters: { wertung: '', figurId: '', kapitel: '', ortId: '' },
    orteFilters: { figurId: '', kapitel: '', szeneId: '' },
    selectedSongId: null,
    songsFilters: { figurId: '', kapitel: '', szeneId: '', genre: '', kontextTyp: '', suche: '' },
    // Katalog- + Job-Daten leben in Alpine.store('catalog') bzw. Alpine.store('jobs');
    // resetView schreibt via this.$store.catalog.* / this.$store.jobs.* — das Mock
    // spiegelt diese Struktur.
    $store: {
      nav,
      catalog: { figuren: [], orte: [], songs: [], szenen: [], globalZeitstrahl: [], zeitstrahlChronology: null },
      jobs: {
        alleAktualisierenLoading: false, alleAktualisierenStatus: '', alleAktualisierenProgress: 0,
        alleAktualisierenTokIn: 0, alleAktualisierenTokOut: 0, alleAktualisierenTps: null,
        alleAktualisierenLastRun: null,
      },
    },
    batchLoading: false,
    batchProgress: 0,
    batchStatus: '',
    _batchPollTimer: null,
    _komplettPollTimer: null,
    clearBookstackSearch() {},
    currentPage: { id: 7 },
    resetPage() { /* noop */ },
    loadFiguren: async () => {},
    loadOrte: async () => {},
    _ensurePartial: async () => true,
    ...appViewMethods,
  };
}

test('_closeOtherMainCards: keep="figures" → schliesst alle anderen', () => {
  const c = makeCtx();
  c.showBookReviewCard = true;
  c.showFiguresCard = true;
  c.showOrteCard = true;
  c.showStilCard = true;
  c.showBookStatsCard = true;
  c._closeOtherMainCards('figures');
  assert.equal(c.showFiguresCard, true, 'keep-Karte bleibt offen');
  assert.equal(c.showBookReviewCard, false);
  assert.equal(c.showOrteCard, false);
  assert.equal(c.showStilCard, false);
  assert.equal(c.showBookStatsCard, false);
});

test('_closeOtherMainCards: keep="none" → schliesst alle Hauptkarten', () => {
  const c = makeCtx();
  c.showBookReviewCard = true;
  c.showFiguresCard = true;
  c.showOrteCard = true;
  c.showStilCard = true;
  c.showBookChatCard = true;
  c._closeOtherMainCards('none');
  assert.equal(c.showBookReviewCard, false);
  assert.equal(c.showFiguresCard, false);
  assert.equal(c.showOrteCard, false);
  assert.equal(c.showStilCard, false);
  assert.equal(c.showBookChatCard, false);
});

test('_closeOtherMainCards: schliesst Editor + Seiten-Chat (Seitenebene exklusiv mit Buchebene)', () => {
  // CLAUDE.md: Buch- und Seitenebene sind gegenseitig exklusiv.
  // _closeOtherMainCards ruft resetPage(), das den Editor + Seiten-Chat
  // schliesst. Tree bleibt aktiv (eigener Bereich).
  const c = makeCtx();
  c.showEditorCard = true;
  c.showChatCard = true;
  c.showTreeCard = true;
  c.showFiguresCard = true;
  c._closeOtherMainCards('figures');
  assert.equal(c.showEditorCard, false, 'Editor schliesst beim Wechsel auf Buch-Karte');
  assert.equal(c.showChatCard, false, 'Seiten-Chat schliesst mit dem Editor');
  assert.equal(c.showTreeCard, true, 'Tree bleibt aktiv');
});

test('toggleChatCard: lebt parallel zum Editor (Seiten-Chat-Ausnahme)', async () => {
  // Anders als Hauptkarten ruft toggleChatCard KEIN _closeOtherMainCards.
  // Editor bleibt offen, Tree bleibt offen.
  const c = makeCtx();
  c.showEditorCard = true;
  c.showTreeCard = true;
  await c.toggleChatCard();
  assert.equal(c.showChatCard, true);
  assert.equal(c.showEditorCard, true,
    'Seiten-Chat schliesst Editor NICHT – läuft daneben');
  assert.equal(c.showTreeCard, true);
});

test('toggleStilCard: öffnet & schliesst andere Karten', async () => {
  const c = makeCtx();
  c.showBookReviewCard = true;
  await c.toggleStilCard();
  assert.equal(c.showStilCard, true);
  assert.equal(c.showBookReviewCard, false, 'Andere Hauptkarte muss schliessen');
});

test('toggleStilCard: zweiter Klick schliesst (Settings-Pattern)', async () => {
  const c = makeCtx();
  await c.toggleStilCard();
  await c.toggleStilCard();
  assert.equal(c.showStilCard, false);
});

test('toggleFiguresCard: zweiter Klick dispatcht card:refresh statt zu schliessen', async () => {
  const c = makeCtx();
  const events = [];
  globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
  await c.toggleFiguresCard();
  assert.equal(c.showFiguresCard, true);
  await c.toggleFiguresCard();
  assert.equal(c.showFiguresCard, true,
    'Refresh-Pattern: erneuter Klick schliesst NICHT, sondern dispatcht card:refresh');
  assert.deepEqual(events.pop(), { type: 'card:refresh', detail: { name: 'figuren' } });
});

test('toggleBookChatCard: braucht selectedBookId – ohne Buch kein Open', async () => {
  const c = makeCtx();
  c.selectedBookId = null;
  await c.toggleBookChatCard();
  assert.equal(c.showBookChatCard, false,
    'BookChat ohne Buch-Auswahl darf nicht öffnen');
});

test('toggleChatCard: schliesst Ideen-Card (gleicher Slot neben Editor)', async () => {
  const c = makeCtx();
  c.showIdeenCard = true;
  await c.toggleChatCard();
  assert.equal(c.showChatCard, true);
  assert.equal(c.showIdeenCard, false,
    'Ideen und Chat teilen den Slot – nur eines aktiv');
});

test('toggleChatCard: ohne currentPage nicht öffnen', async () => {
  const c = makeCtx();
  c.currentPage = null;
  await c.toggleChatCard();
  assert.equal(c.showChatCard, false);
});

test('resetView: schliesst alle Hauptkarten und öffnet bookOverview (Home-Klick)', async () => {
  // Regression: figurWerkstatt war früher nicht in resetView gelistet → Home-Klick
  // aus Werkstatt liess Flag true → _maybeOpenBookOverview skipte → keine Übersicht.
  // Mit Registry-driven Reset darf das nicht mehr passieren — neue Karten kommen
  // automatisch durch EXCLUSIVE_CARDS.
  const c = makeCtx();
  c.showFigurWerkstattCard = true;
  await c.resetView();
  assert.equal(c.showFigurWerkstattCard, false, 'Werkstatt-Flag muss nach resetView false sein');
  assert.equal(c.showBookOverviewCard, true, 'bookOverview ist Default-Home');
});

test('resetView: kein zweiter Tab offen → bookOverview öffnet', async () => {
  const c = makeCtx();
  c.showBookOrganizerCard = true;
  c.showExportCard = true;
  c.showPdfExportCard = true;
  await c.resetView();
  assert.equal(c.showBookOrganizerCard, false);
  assert.equal(c.showExportCard, false);
  assert.equal(c.showPdfExportCard, false);
  assert.equal(c.showBookOverviewCard, true);
});

test('toggleKontinuitaetCard: refresh-Pattern beim erneuten Klick', async () => {
  const c = makeCtx();
  const events = [];
  globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
  await c.toggleKontinuitaetCard();
  assert.equal(c.showKontinuitaetCard, true);
  await c.toggleKontinuitaetCard();
  assert.equal(c.showKontinuitaetCard, true);
  const last = events.pop();
  assert.equal(last.type, 'card:refresh');
  assert.equal(last.detail.name, 'kontinuitaet');
});
