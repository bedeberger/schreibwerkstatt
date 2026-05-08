// Alpine.data('bookSettingsCard') — Sub-Komponente der Buch-Einstellungen.
// Fachlicher State lebt hier, `showBookSettingsCard` + `toggleBookSettingsCard`
// im Root. Daten werden beim Öffnen / Buchwechsel nachgeladen.

import { bookSettingsMethods } from '../book-settings.js';
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
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookSettingsCard',
        onShow: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats()]),
        load: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats()]),
        resetState: {
          expandedJobType: null,
          bookJobRuns: {},
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
        },
        resetStateView: {
          bookSettingsSaved: false,
          bookSettingsError: '',
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
        },
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...bookSettingsMethods,
  }));
}
