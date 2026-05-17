// Alpine.data('bookSettingsCard') — Sub-Komponente der Buch-Einstellungen.
// Fachlicher State lebt hier, `showBookSettingsCard` + `toggleBookSettingsCard`
// im Root. Daten werden beim Öffnen / Buchwechsel nachgeladen.

import { bookSettingsMethods } from '../book/book-settings.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerBookSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookSettingsCard', () => ({
    bookSettingsLanguage: 'de',
    bookSettingsRegion: 'CH',
    bookSettingsBuchtyp: '',
    bookSettingsBuchKontext: '',
    bookSettingsErzaehlperspektive: '',
    bookSettingsErzaehlzeit: '',
    bookSettingsIsFinished: false,
    bookSettingsAllowLektorBookChat: false,
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
    _savedAtTimer: null,
    _resetMsgTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookSettingsCard',
        onShow: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats(), this.loadBookAccess(), this.loadBookCategoriesAndTags(), this.loadShareUserPool()]),
        load: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats(), this.loadBookAccess(), this.loadBookCategoriesAndTags(), this.loadShareUserPool()]),
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
        },
        resetStateView: {
          bookSettingsSaved: false,
          bookSettingsError: '',
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          bookAccessError: '',
        },
      });
    },

    destroy() {
      if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
      if (this._resetMsgTimer) { clearTimeout(this._resetMsgTimer); this._resetMsgTimer = null; }
      this._lifecycle?.destroy();
    },

    ...bookSettingsMethods,
  }));
}
