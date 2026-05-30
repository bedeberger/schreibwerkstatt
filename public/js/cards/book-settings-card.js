// Alpine.data('bookSettingsCard') — Sub-Komponente der Buch-Einstellungen.
// Fachlicher State lebt hier, `showBookSettingsCard` + `toggleBookSettingsCard`
// im Root. Daten werden beim Öffnen / Buchwechsel nachgeladen.

import { bookSettingsMethods } from '../book/book-settings.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerBookSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookSettingsCard', () => ({
    bookSettingsTab: 'book',
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
    bookSettingsOrteReal: false,
    bookSettingsSchauplatzLand: '',
    // Sharing: Access-Liste + Invite-Form.
    bookAccessList: [],
    bookAccessLoading: false,
    bookAccessError: '',
    shareEmail: '',
    shareRole: 'viewer',
    shareBusy: false,
    shareInviteMessage: '',
    // Kategorie.
    categoryPool: [],
    bookCategoryId: '',
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
    blogSectionOpen: false,
    blogConnection: null,
    blogForm: { baseUrl: '', username: '', password: '', defaultStatus: 'draft' },
    blogBusy: false,
    blogAction: null,
    blogMessage: '',
    blogError: '',
    blogImportJobId: null,
    blogPullJobId: null,
    blogReconcileJobId: null,
    // HubSpot-Sync (Initial-Import + Create-Draft-Push).
    hubspotSectionOpen: false,
    hubspotConnection: null,
    hubspotForm: { token: '', blogId: '', authorId: '' },
    hubspotBlogs: [],
    hubspotAuthors: [],
    hubspotBusy: false,
    hubspotAction: null,
    hubspotMessage: '',
    hubspotError: '',
    hubspotImportJobId: null,
    hubspotReconcileJobId: null,
    // Publikation (book_publication: Cover/Titelei/Bio, geteilt mit PDF+EPUB).
    bookPublication: { isbn: '', subtitle: '', year: '', dedication: '', imprint: '', copyright: '', frontmatter: '', author_bio: '', epub_css_style: 'serif', epub_justify: true, epub_toc_title: '', has_cover: false, has_author_image: false },
    pubSaving: false,
    pubSaved: false,
    pubError: '',
    pubCoverUploading: false,
    pubCoverError: '',
    pubAuthorUploading: false,
    pubAuthorError: '',
    pubPreviewVersion: 0,
    epubExporting: false,
    epubProgress: 0,
    epubStatus: '',
    epubError: '',
    _pubSavedTimer: null,
    _epubPollTimer: null,
    _epubStatusTimer: null,
    _savedAtTimer: null,
    _resetMsgTimer: null,
    _shareInviteMsgTimer: null,
    _lifecycle: null,
    _onBlogJobFinished: null,
    _onHubspotJobFinished: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookSettingsCard',
        onShow: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats(), this.loadBookAccess(), this.loadBookCategory(), this.loadBlogStatus(), this.loadHubspotStatus(), this.loadPublication()]),
        load: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats(), this.loadBookAccess(), this.loadBookCategory(), this.loadBlogStatus(), this.loadHubspotStatus(), this.loadPublication()]),
        resetState: {
          bookSettingsTab: 'book',
          expandedJobType: null,
          bookJobRuns: {},
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          bookAccessList: [],
          bookAccessError: '',
          shareEmail: '',
          shareRole: 'viewer',
          shareInviteMessage: '',
          bookCategoryId: '',
          blogSectionOpen: false,
          blogConnection: null,
          blogForm: { baseUrl: '', username: '', password: '', defaultStatus: 'draft' },
          blogBusy: false,
          blogMessage: '',
          blogError: '',
          blogImportJobId: null,
          blogPullJobId: null,
          blogReconcileJobId: null,
          hubspotSectionOpen: false,
          hubspotConnection: null,
          hubspotForm: { token: '', blogId: '', authorId: '' },
          hubspotBlogs: [],
          hubspotAuthors: [],
          hubspotBusy: false,
          hubspotMessage: '',
          hubspotError: '',
          hubspotImportJobId: null,
          hubspotReconcileJobId: null,
          bookPublication: { isbn: '', subtitle: '', year: '', dedication: '', imprint: '', copyright: '', frontmatter: '', author_bio: '', epub_css_style: 'serif', epub_justify: true, epub_toc_title: '', has_cover: false, has_author_image: false },
          pubError: '',
          pubCoverError: '',
          pubAuthorError: '',
          epubError: '',
          epubStatus: '',
        },
        resetStateView: {
          bookSettingsSaved: false,
          bookSettingsError: '',
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          bookAccessError: '',
          shareInviteMessage: '',
          blogMessage: '',
          blogError: '',
          hubspotMessage: '',
          hubspotError: '',
        },
      });

      // Blog-Sync: bei Job-Ende Status nachladen, lokale Job-IDs nullen.
      // Filter lose: jeder blog-* Job-Done räumt beide Spinner-Flags und
      // triggert root.loadPages, weil Import/Pull neue Pages + Chapters
      // anlegen und der Sidebar-Tree sonst veraltet ist.
      this._onBlogJobFinished = (ev) => {
        const t = ev?.detail?.type;
        if (t !== 'blog-import' && t !== 'blog-pull' && t !== 'blog-push' && t !== 'blog-reconcile') return;
        this.blogImportJobId = null;
        this.blogPullJobId = null;
        this.blogReconcileJobId = null;
        this.loadBlogStatus();
        if (t === 'blog-import' || t === 'blog-pull') {
          window.__app.loadPages?.();
        }
      };
      window.addEventListener('job:finished', this._onBlogJobFinished);

      // HubSpot-Jobs: bei Import-/Push-Done Status nachladen, Sidebar-Tree
      // refreshen (Import legt Pages/Chapters an).
      this._onHubspotJobFinished = (ev) => {
        const t = ev?.detail?.type;
        if (t !== 'hubspot-import' && t !== 'hubspot-push' && t !== 'hubspot-reconcile') return;
        this.hubspotImportJobId = null;
        this.hubspotReconcileJobId = null;
        this.loadHubspotStatus();
        if (t === 'hubspot-import') {
          window.__app.loadPages?.();
        }
      };
      window.addEventListener('job:finished', this._onHubspotJobFinished);
    },

    destroy() {
      if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
      if (this._resetMsgTimer) { clearTimeout(this._resetMsgTimer); this._resetMsgTimer = null; }
      if (this._shareInviteMsgTimer) { clearTimeout(this._shareInviteMsgTimer); this._shareInviteMsgTimer = null; }
      if (this._pubSavedTimer) { clearTimeout(this._pubSavedTimer); this._pubSavedTimer = null; }
      if (this._epubStatusTimer) { clearTimeout(this._epubStatusTimer); this._epubStatusTimer = null; }
      if (this._epubPollTimer) { clearInterval(this._epubPollTimer); this._epubPollTimer = null; }
      if (this._onBlogJobFinished) {
        window.removeEventListener('job:finished', this._onBlogJobFinished);
        this._onBlogJobFinished = null;
      }
      if (this._onHubspotJobFinished) {
        window.removeEventListener('job:finished', this._onHubspotJobFinished);
        this._onHubspotJobFinished = null;
      }
      this._lifecycle?.destroy();
    },

    ...bookSettingsMethods,
  }));
}
