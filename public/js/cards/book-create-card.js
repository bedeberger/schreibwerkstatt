// Alpine.data('bookCreateCard') — Buch-Erstellungs-Modal (natives <dialog>).
// Kein Show-Flag/Exklusivität: das Modal liegt über allem. Getriggert aus dem
// Root-Header (Combobox-Footer "+ Neues Buch" + Welcome-CTA) via `book-create:open`
// (Root-Bridge openCreateBook in app-view/cards.js); die Karte hört darauf und
// öffnet das Dialog. State + Methoden leben hier, nicht mehr am Root.
//
// Root-Zugriffe (loadBooks/toggleBookSettingsCard/t) laufen über window.__app
// (siehe bookCreateMethods in book/book-create.js).

import { bookCreateMethods } from '../book/book-create.js';
import { EVT } from '../events.js';

export function registerBookCreateCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookCreateCard', () => ({
    bookCreateName: '',
    bookCreateBuchtyp: '',
    bookCreateCategoryId: '',
    bookCreateCategoryPool: [],
    bookCreateBusy: false,
    bookCreateError: '',
    _abortCtrl: null,

    init() {
      this._abortCtrl = new AbortController();
      window.addEventListener(EVT.BOOK_CREATE_OPEN, () => this.openCreateBook(), {
        signal: this._abortCtrl.signal,
      });
    },

    destroy() {
      this._abortCtrl?.abort();
      this._abortCtrl = null;
    },

    ...bookCreateMethods,
  }));
}
