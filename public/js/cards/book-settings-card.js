// Alpine.data('bookSettingsCard') — Sub-Komponente der Buch-Einstellungen.
// Fachlicher State lebt hier, `showBookSettingsCard` + `toggleBookSettingsCard`
// im Root. Daten werden beim Öffnen / Buchwechsel nachgeladen.

import { bookSettingsMethods } from '../book/book-settings.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerBookSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookSettingsCard', () => ({
    bookSettingsName: '',
    bookSettingsLanguage: 'de',
    bookSettingsRegion: 'CH',
    bookSettingsBuchtyp: '',
    bookSettingsBuchKontext: '',
    bookSettingsErzaehlperspektive: '',
    bookSettingsErzaehlzeit: '',
    bookSettingsIsFinished: false,
    bookSettingsAllowLektorBookChat: false,
    bookSettingsDailyGoalChars: 1500,
    // Sharing: Access-Liste + Invite-Form.
    bookAccessList: [],
    bookAccessLoading: false,
    bookAccessError: '',
    shareEmail: '',
    shareRole: 'viewer',
    shareBusy: false,
    // Typeahead-Pool für Sharing-Suggestions (Email → Display-Name aus app_users).
    shareUserPool: [],
    shareSuggestOpen: false,
    // Kategorie + Tags.
    categoryPool: [],
    tagPool: [],
    bookCategoryId: '',
    bookTagIds: [],
    newTagName: '',
    newTagBusy: false,
    bookSettingsLoading: false,
    bookSettingsSaving: false,
    bookSettingsSaved: false,
    bookSettingsError: '',
    bookJobStats: null,
    bookJobStatsLoading: false,
    expandedJobType: null,
    bookJobRuns: {},
    bookJobRunsLoading: false,
    bookHistoryResetLoading: false,
    bookHistoryResetMessage: '',
    bookHistoryResetError: '',
    bookDeleteLoading: false,
    bookDeleteError: '',
    // Blog-Sync (WordPress).
    blogConnection: null,
    blogForm: { baseUrl: '', username: '', password: '', defaultStatus: 'draft' },
    blogBusy: false,
    blogAction: null,
    blogMessage: '',
    blogError: '',
    blogImportJobId: null,
    blogPullJobId: null,
    _savedAtTimer: null,
    _resetMsgTimer: null,
    _lifecycle: null,
    _onBlogJobFinished: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookSettingsCard',
        onShow: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats(), this.loadBookAccess(), this.loadBookCategoriesAndTags(), this.loadShareUserPool(), this.loadBlogStatus()]),
        load: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats(), this.loadBookAccess(), this.loadBookCategoriesAndTags(), this.loadShareUserPool(), this.loadBlogStatus()]),
        resetState: {
          expandedJobType: null,
          bookJobRuns: {},
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          bookAccessList: [],
          bookAccessError: '',
          shareEmail: '',
          shareRole: 'viewer',
          bookCategoryId: '',
          bookTagIds: [],
          newTagName: '',
          blogConnection: null,
          blogForm: { baseUrl: '', username: '', password: '', defaultStatus: 'draft' },
          blogBusy: false,
          blogMessage: '',
          blogError: '',
          blogImportJobId: null,
          blogPullJobId: null,
        },
        resetStateView: {
          bookSettingsSaved: false,
          bookSettingsError: '',
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          bookAccessError: '',
          blogMessage: '',
          blogError: '',
        },
      });

      // Blog-Sync: bei Job-Ende Status nachladen, lokale Job-IDs nullen.
      // Filter lose: jeder blog-* Job-Done räumt beide Spinner-Flags und
      // triggert root.loadPages, weil Import/Pull neue Pages + Chapters
      // anlegen und der Sidebar-Tree sonst veraltet ist.
      this._onBlogJobFinished = (ev) => {
        const t = ev?.detail?.type;
        if (t !== 'blog-import' && t !== 'blog-pull' && t !== 'blog-push') return;
        this.blogImportJobId = null;
        this.blogPullJobId = null;
        this.loadBlogStatus();
        if (t === 'blog-import' || t === 'blog-pull') {
          window.__app.loadPages?.();
        }
      };
      window.addEventListener('job:finished', this._onBlogJobFinished);
    },

    destroy() {
      if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
      if (this._resetMsgTimer) { clearTimeout(this._resetMsgTimer); this._resetMsgTimer = null; }
      if (this._onBlogJobFinished) {
        window.removeEventListener('job:finished', this._onBlogJobFinished);
        this._onBlogJobFinished = null;
      }
      this._lifecycle?.destroy();
    },

    ...bookSettingsMethods,
  }));
}
