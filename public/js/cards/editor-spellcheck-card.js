import { EVT } from '../events.js';
// Alpine.data('editorSpellcheckCard') — globale Sub-Komponente fuer den
// LanguageTool-Konflikt-Banner. Der eigentliche Spellcheck-Controller wird
// von den drei Editoren (Notebook, Focus, Bucheditor) instanziiert; dieses
// Modul hostet nur das UI-Element, das warnt, wenn eine LT-Browser-Extension
// parallel laeuft.
//
// Sichtbarkeit: `extensionDetected` wird auf `languagetool:extension-detected`-
// Event gesetzt, auf `languagetool:extension-cleared` zurueck. Der User kann
// das Banner per Session ausblenden (sessionStorage).

const DISMISS_KEY = 'lt:extension-banner-dismissed';

export function registerEditorSpellcheckCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorSpellcheckCard', () => ({
    extensionDetected: false,
    dismissed: false,
    _onDetected: null,
    _onCleared: null,

    init() {
      try { this.dismissed = sessionStorage.getItem(DISMISS_KEY) === '1'; } catch {}
      this._onDetected = () => { this.extensionDetected = true; };
      this._onCleared = () => { this.extensionDetected = false; };
      window.addEventListener(EVT.LANGUAGETOOL_EXTENSION_DETECTED, this._onDetected);
      window.addEventListener(EVT.LANGUAGETOOL_EXTENSION_CLEARED, this._onCleared);
    },

    destroy() {
      if (this._onDetected) window.removeEventListener(EVT.LANGUAGETOOL_EXTENSION_DETECTED, this._onDetected);
      if (this._onCleared) window.removeEventListener(EVT.LANGUAGETOOL_EXTENSION_CLEARED, this._onCleared);
    },

    dismissBanner() {
      this.dismissed = true;
      try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {}
    },

    get showBanner() {
      return this.extensionDetected && !this.dismissed;
    },
  }));
}
