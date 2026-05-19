// Initialer State der `lektorat`-Alpine-Komponente.
// Als Funktion, damit jede Komponenten-Instanz eigene Arrays/Objekte erhält
// (sonst teilen sich alle Instanzen dieselben Referenzen).
//
// Der Export `initialLektoratState()` bleibt ein flaches Objekt — Alpine
// spreadet das direkt in die Komponente. Die internen Slice-Funktionen sind
// rein organisatorisch und machen sichtbar, welche Felder fachlich
// zusammengehören. Neue Felder kommen in den passenden Slice.

import { blogState } from '../book/blog-sync.js';

const shellState = () => ({
  currentUser: null,
  devMode: false,
  // Single Source of Truth für „Boot komplett". Wird am Ende von init()
  // (try/finally) auf true gesetzt, parallel zum Entfernen von
  // `html[data-app-loading]`. Templates können `appReady` als Reveal-Gate
  // nutzen, der CSS-Selektor übernimmt den Hauptjob.
  appReady: false,
  sessionExpired: false,
  serverOffline: false,
  isOffline: false,
  updateAvailable: false,
  themePref: 'auto',
  focusGranularity: 'paragraph',
  uiLocale: '',
  defaultRegion: '',
  // App-weite Zeitzone (vom Server via /config → app_settings.app.timezone).
  // In Templates ueber `$app.appTimezone` lesbar; gilt fuer Datums-Buckets +
  // alle Date-Display-Formatter (toLocaleString, Intl.DateTimeFormat).
  appTimezone: 'Europe/Zurich',
  // Plattform-Detect für Tasten-Hint-Anzeige (⌘ vs. Ctrl). Wird in init()
  // gesetzt; default true wäre auf Windows falsch, default false ist sichere
  // Annahme bevor JS gelaufen ist (Hero erscheint mit Ctrl, dann snap auf ⌘ falls Mac).
  isMac: false,
  promptConfig: {},
  _abortCtrl: null,
  // Email → Display-Name-Map fuer Revision-Listen, Tree-Toasts, Konflikt-Hinweise.
  // Lazy gefuellt via `/me/users-light` beim ersten Zugriff in `userDisplayName`.
  // Map-Form (statt POJO) damit Lookups O(1) bleiben und Alpine den Reactor
  // nicht bei jeder Property-Zugriffsfolge feuert.
  _usersByEmail: null,
  _usersByEmailLoading: false,
});

const aiProviderState = () => ({
  claudeModel: 'claude-sonnet-4-6',
  claudeMaxTokens: 64000,
  apiProvider: 'claude',
  ollamaModel: 'llama3.2',
  llamaModel:  'llama3.2',
});

const navigationState = () => ({
  books: [],
  // Buchliste-Filter (UI-only, persistiert nicht; reines Frontend-Filter
  // ueber die per /content/books gelieferten category_id + tags-Felder).
  bookFilterCategoryId: '',
  bookFilterTagIds: [],
  // Pool fuer Filter-Pills in der Buchliste — wird beim Login einmal geladen.
  bookFilterCategoryPool: [],
  bookFilterTagPool: [],
  selectedBookId: '',
  // Per-Buch ACL-Rolle aus /books/:id/access. `currentBookRole` ist die Rolle
  // fuer selectedBookId (Snapshot fuer $watch + Getter `canEdit`/`canReview`).
  // null = nicht ermittelbar (kein Zugriff oder Endpoint-Fehler) → Frontend
  // faellt auf Legacy-Verhalten zurueck (canEdit=true), bis serverseitige
  // Schreibpfade enforced sind. `bookRoles` cached pro Buch.
  bookRoles: {},
  currentBookRole: null,
  // Per-Buch: true wenn mind. 2 ACL-Eintraege (Owner + N) → Collab-Poller + Presence-Pings
  // erst dann starten. Single-User-Bücher pollen nicht. Befüllt in `_loadBookRole`.
  bookSharedFlags: {},
  pages: [],
  tree: [],
  _applyingHash: false,
  _hashInitialized: false,
  _hashUpdatePending: false,
  _navDepth: 0,
  _inHashApply: false,
  _chapterOrderMap: null,
  _pageOrderMap: null,
  _pageIdOrderMap: null,
  pageSearch: '',
  pageSearchActiveIndex: 0,
  _pageSearchActiveId: null,
  _filteredTreeMemo: null,
  newChapterTitle: '',
  newChapterCreating: false,
  newChapterError: '',
});

const editorState = () => ({
  currentPage: null,
  currentPageEmpty: false,
  currentPageIdeenOpenCount: 0,
  currentPageChatSessionCount: 0,
  renderedPageHtml: '',
  chapterFigures: [],
  showChapterFigures: false,
  originalHtml: null,
  correctedHtml: null,
  hasErrors: false,
  editMode: false,
  editDirty: false,
  editSaving: false,
  saveOffline: false,
  pageEditorFullscreen: false,
  pageEditorZoom: 1,
  pageEditorFitWidth: false,
  // Cross-User-Konflikt aus _checkPageConflict. quickSave (Auto-Save / Exit-
  // Fokus) zeigt keinen Modal — der Banner ist im Fokus-Header sichtbar und
  // bleibt bis zum nächsten erfolgreichen Save oder bis User explizit
  // entscheidet. Form: `{ remoteUserName, remoteUpdatedAt }`.
  editConflict: null,
  // Local-Draft-Hinweis für nicht-editMode: localStorage hat ungespeicherten
  // Entwurf für aktuell geöffnete Seite (z. B. nach Server-Crash mid-write,
  // Tab geschlossen + wieder geöffnet). Form `{ savedAt }`. Banner bietet
  // Resume (öffnet Edit-Mode + Draft-Restore via startEdit) oder Discard.
  pendingDraft: null,
  lastAutosaveAt: null,
  lastDraftSavedAt: null,
  _autosaveIdleTimer: null,
  _autosaveMaxTimer: null,
  _draftTimer: null,
  _onlineHandler: null,
  newPageTitle: '',
  newPageCreating: false,
  newPageError: '',
});

// Fokusmodus-Flag + Live-Counter. Eigener Slice, damit alle vier Editor-Modi-
// Flags (editMode, checkDone, focusMode, plus „Viewmodus" als none-of-above)
// in app-state.js sichtbar sind. Sub-Komponenten-Maschine `_focusState`/
// `_focusGen` lebt in editorFocusCard.
const focusModeState = () => ({
  focusMode: false,
  focusCountWords: 0,
  focusCountChars: 0,
  focusCountWordsDelta: '±0',
  focusCountCharsDelta: '±0',
});

// Restliche Editor-Popup-Felder am Root:
//   - `_figurLookupIndex`: Lookup-Cache für den synchronen Hit-Test in
//     `_tryOpenFigurLookupAt` (wird aus Synonym-Kontextmenü aufgerufen).
//   - `_figurLookupOpen`, `_synonymMenuOpen`, `_synonymPickerOpen`: Spiegel-
//     Flags, die die Subs setzen, damit editor-focus-onKey (Escape) weiss,
//     welches Popover offen ist, ohne in die Sub zu greifen.
// Der Rest des Synonym-/Figur-Lookup-States lebt in den jeweiligen
// Alpine.data-Subs (editorSynonymeCard, editorFigurLookupCard).
const editorPopupState = () => ({
  _figurLookupIndex: null,
  _figurLookupOpen: false,
  _synonymMenuOpen: false,
  _synonymPickerOpen: false,
});

// Sichtbarkeit der Hauptkarten. Exklusiv: `_closeOtherMainCards(keep)`
// schliesst alle anderen und den Editor.
const cardsState = () => ({
  showBookCard: false,
  showTreeCard: true,
  showEditorCard: false,
  showBookOverviewCard: false,
  showBookReviewCard: false,
  showKapitelReviewCard: false,
  showFiguresCard: false,
  showFigurWerkstattCard: false,
  showGlobalZeitstrahl: false,
  showEreignisseCard: false,
  showSzenenCard: false,
  showOrteCard: false,
  showSongsCard: false,
  showKontinuitaetCard: false,
  showBookStatsCard: false,
  showStilCard: false,
  showFehlerHeatmapCard: false,
  showChatCard: false,
  showIdeenCard: false,
  showBookChatCard: false,
  showBookSettingsCard: false,
  showUserSettingsCard: false,
  showAdminUsersCard: false,
  showAdminSettingsCard: false,
  showAdminUsageCard: false,
  showAdminCategoriesCard: false,
  showAdminBooksCard: false,
  adminUsageTab: 'users',
  showFinetuneExportCard: false,
  showExportCard: false,
  showPdfExportCard: false,
  showFolderImportCard: false,
  showBookOrganizerCard: false,
  showBookEditorCard: false,
  showSearchCard: false,
  showKomplettStatus: false,
  showAvatarMenu: false,
});

const statusState = () => ({
  status: '',
  statusSpinner: false,
  _statusTimer: null,
});

// Confirm-Dialog (Ersatz für window.confirm). Native confirm() lässt Chrome
// auf macOS aus dem nativen Vollbild-Space rausspringen — bricht u.a. den
// Focus-Mode-Cancel-Flow. Wir nutzen stattdessen natives <dialog> +
// showModal() (DOM-Modal, kein OS-Modal); Markup in index.html, Helper
// `appConfirm`/`appPrompt` in app-chrome.js. Buttons rufen
// `_resolveConfirmDialog(bool)`.
const confirmDialogState = () => ({
  confirmDialogMessage: '',
  confirmDialogConfirmLabel: '',
  confirmDialogCancelLabel: '',
  confirmDialogDanger: false,
  // Input-Mode (Prompt-Variante via appPrompt): zeigt Textfeld; Resolver
  // liefert getrimmten Input-String (oder null bei Cancel).
  confirmDialogInput: false,
  confirmDialogInputValue: '',
  confirmDialogInputPlaceholder: '',
  _confirmDialogResolve: null,
});

// Seiten-Lektorat (Finding-Liste, Apply-Flow, Token-Estimates)
const lektoratState = () => ({
  analysisOut: '',
  lektoratFindings: [],
  selectedFindings: [],
  appliedOriginals: [],
  appliedHistoricCorrections: [],
  checkDone: false,
  checkLoading: false,
  checkProgress: 0,
  checkStatus: '',
  saveApplying: null,
  batchLoading: false,
  batchProgress: 0,
  batchStatus: '',
  lastCheckId: null,
  pageHistory: [],
  activeHistoryEntryId: null,
  tokEsts: {},
  _tokenEstGen: 0,
  pageLastChecked: {},
  ideenCounts: {},
  chapterIdeenCounts: {},
  // Scope der aktuell offenen Ideen-Karte: 'page' (neben Editor) oder
  // 'chapter' (neben Kapitelreview). ideenChapterId nur in 'chapter'-Modus
  // gesetzt. currentPageIdeenOpenCount/currentChapterIdeenOpenCount halten die
  // Badge-Counts fuer den jeweiligen Toggle-Button.
  ideenScope: 'page',
  ideenChapterId: null,
  currentChapterIdeenOpenCount: 0,
  showTokLegend: false,
  tokLegendPos: { x: 0, y: 0 },
  tokTooltipData: null,
  showPageStatusTip: false,
  pageStatusTipPos: { x: 0, y: 0 },
  pageStatusTipLines: [],
  // Lektorat-Check-Polls werden per-pageId gehalten (`_checkPollTimer_<id>`),
  // damit ein Seitenwechsel den Poll der Ursprungsseite nicht abreisst.
  // IntersectionObserver-basiertes Lazy-Loading der Token-Estimates für die
  // Sidebar (Server-Endpoint `/sync/page-stats/:bookId`). Refs hier, damit
  // _resetBookScopedState() / destroy() sauber aufräumen können.
  _statsObserver: null,
  _statsObserverMutation: null,
  _statsObserverState: null,
});

// bookReviewHistory wird von tree.js/loadPages geschrieben und von
// user-settings beim Danger-Reset gelesen; deshalb am Root.
const bookReviewState = () => ({
  bookReviewHistory: [],
});

// Hash-Router und Sidebar brauchen kapitelReviewChapterId als Single Source
// of Truth (analog zu selectedFigurId/selectedOrtId).
const kapitelReviewState = () => ({
  kapitelReviewChapterId: '',
});

// Hash-Router-SSoT für Figuren-Werkstatt-Draft. Sub-Card spiegelt
// selectedDraftId in dieses Feld; Hash-Router liest/schreibt nur hier.
// werkstattDrafts: Spiegel der Sub-Card-Liste, damit die Command-Palette die
// Drafts auch indizieren kann, wenn die Werkstatt-Karte nie geöffnet wurde.
// Sub-Card hat $watch auf this.drafts → schreibt hierher; Palette-Provider
// triggert bei Bedarf ein einmaliges /draft-figures-Fetch.
const figurWerkstattState = () => ({
  werkstattDraftId: null,
  werkstattDrafts: [],
});

// Root-seitig: figurenLoading/Progress/Status, selectedFigurId, Filters —
// gebraucht von Hash-Router, app-navigation, checkPendingJobs-Reconnect.
const figurenState = () => ({
  figurenLoading: false,
  figurenProgress: 0,
  figurenStatus: '',
  selectedFigurId: null,
  figurenFilters: {
    kapitel: '',
    seite: '',
    suche: '',
  },
  _figuresPollTimer: null,
});

// Filters bleiben am Root — app-navigation schreibt sie.
const ereignisseState = () => ({
  ereignisseFilters: {
    figurId: '',
    kapitel: '',
    seite: '',
    suche: '',
  },
});

const szenenState = () => ({
  szenenUpdatedAt: null,
  selectedSzeneId: null,
  szenenFilters: {
    wertung: '',
    figurId: '',
    kapitel: '',
    ortId: '',
    suche: '',
  },
});

const orteState = () => ({
  orteUpdatedAt: null,
  selectedOrtId: null,
  orteFilters: {
    figurId: '',
    kapitel: '',
    szeneId: '',
    suche: '',
  },
});

const songsState = () => ({
  songsUpdatedAt: null,
  selectedSongId: null,
  songsFilters: {
    figurId: '',
    kapitel: '',
    szeneId: '',
    genre: '',
    kontextTyp: '',
    suche: '',
  },
});

// Kontinuitäts-Filter am Root (analog figuren/ereignisse/…), damit der
// FILTER_SCOPES-Persist-/Restore-/Reset-Pfad sie pro Buch im localStorage hält.
const kontinuitaetState = () => ({
  kontinuitaetFilters: {
    figurId: '',
    kapitel: '',
    schwere: '',
  },
});

// _checkDoneBeforeChat wird von toggleChatCard + resetPage verwendet (Editor-nah).
const chatsState = () => ({
  _checkDoneBeforeChat: false,
});

// Feature-Usage: Top-3 nach Recency, gespeist aus /usage/recent. Default-Set
// aus feature-registry, wenn User noch keine Tracking-Daten hat.
// recentPageIds: pro Buch die letzten N geöffneten Seiten-IDs (Command-Palette).
const featuresUsageState = () => ({
  recentFeatureKeys: ['review', 'figuren', 'bookchat'],
  recentPageIds: [],
});

// Collaboration-Signal: Seiten dieses Buchs, die seit dem letzten Poll von
// einem ANDEREN User editiert wurden. Quelle: GET /content/books/:id/changes.
//   _collabSince:        Server-Stempel, gegen den der naechste Poll vergleicht.
//   recentRemoteEdits:   Set von page_id, die der Tree als „extern geaendert"
//                        markieren soll. Cleared beim Klick auf die Seite.
//   collabToast:         { user, pageName, pageId, count?, currentPage? } | null
const collabState = () => ({
  _collabSince: null,
  _collabPollTimer: null,
  recentRemoteEdits: new Set(),
  collabToast: null,
  _collabToastTimer: null,
  // Presence: Map<pageId, [{ user_email, user_display_name, last_ping_at }]>
  // — andere User, die gerade Seiten dieses Buchs editieren. Updated im
  // gleichen Poll-Tick wie /changes; UI rendert via livePresenceByPage.
  livePresenceByPage: {},
  // Eigener Heartbeat: aktiver Edit-Mode pingt den Server alle 30s.
  _presencePingTimer: null,
  _presencePingPageId: null,
  // Soft-Lock-State: eigener gehaltener Lock + fremder Lock auf der offenen
  // Seite (Banner-Quelle). _currentEditLock haelt {expires_at, reason}; ein
  // fremder Lock (foreignEditLock) ist {user_email, user_display_name, ...}.
  _currentEditLock: null,
  _lockHeartbeatTimer: null,
  foreignEditLock: null,
});

// Modal-State fuer Buch-Erstellung (Trigger: Combobox-Footer "+ Neues Buch").
// Eigener Slice statt Inline in cardsState, weil Open/Close keine Show-Flag-
// Exklusivitaet braucht — Modal liegt ueber allem (natives <dialog>).
const bookCreateState = () => ({
  bookCreateName: '',
  bookCreateBusy: false,
  bookCreateError: '',
});

// Tages-Schreibziel im Header: Donut links neben Avatar. Pulsiert bei aktivem
// Schreibtag. Daten leben am Root, damit der Donut unabhaengig von der
// Buch-Overview-Karte sichtbar ist. `dailyProgressStats` ist die rohe
// /history/book-stats/:bookId-Liste; Tagesdelta berechnet `headerTodayRing()`.
const dailyProgressState = () => ({
  dailyProgressBookId: null,
  dailyProgressStats: [],
  dailyProgressIsFinished: false,
  dailyProgressDailyGoalChars: null,
  _dailyProgressLoadingBookId: null,
});

const jobsState = () => ({
  jobQueueItems: [],
  jobQueueExpanded: false,
  _jobQueueTimer: null,
  alleAktualisierenLoading: false,
  alleAktualisierenStatus: '',
  alleAktualisierenLastRun: null,
  alleAktualisierenProgress: 0,
  alleAktualisierenTokIn: 0,
  alleAktualisierenTokOut: 0,
  alleAktualisierenTps: null,
  alleAktualisierenPassMode: null,
  // Globaler Job-Done-Toast. Wird von `_onJobFinished` für relevante
  // langlaufende Job-Typen gesetzt (komplett-analyse, review, kapitel-review,
  // figuren, kontinuitaet, book-chat, finetune-export, pdf-export, batch-check,
  // werkstatt-*). Auto-Dismiss via `_jobToastTimer`. Severity 'ok' für done,
  // 'err' für error.
  jobToast: null,
  _jobToastTimer: null,
});

export function initialLektoratState() {
  return {
    ...shellState(),
    ...aiProviderState(),
    ...navigationState(),
    ...editorState(),
    ...focusModeState(),
    ...editorPopupState(),
    ...cardsState(),
    ...statusState(),
    ...confirmDialogState(),
    ...lektoratState(),
    ...bookReviewState(),
    ...kapitelReviewState(),
    ...figurWerkstattState(),
    ...figurenState(),
    ...ereignisseState(),
    ...szenenState(),
    ...orteState(),
    ...songsState(),
    ...kontinuitaetState(),
    ...chatsState(),
    ...featuresUsageState(),
    ...bookCreateState(),
    ...collabState(),
    ...dailyProgressState(),
    ...jobsState(),
    ...blogState(),
  };
}
