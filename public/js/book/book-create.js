// Neues Buch direkt aus der App anlegen. Trigger: Combobox-Footer-Eintrag
// "+ Neues Buch …" → Modal mit Name + Buchtyp (Pflicht) + Kategorie (Pflicht nur
// wenn der globale Pool nicht leer ist) → contentRepo.createBook, danach Buchtyp/
// Kategorie persistieren → Liste neu laden + neues Buch selektieren + Book-
// Settings-Karte öffnen. Buchtyp ist Pflicht, weil alle KI-Jobs den Genre-Kontext
// über getBookPrompts ziehen; Kategorie analog zur Save-Pflicht in den Settings.
//
// Methods der Karte Alpine.data('bookCreateCard') (cards/book-create-card.js) auf
// dem <dialog>: State + Methoden leben in der Karte, nicht am Root. Root-Methoden
// (loadBooks/toggleBookSettingsCard/t) laufen über window.__app; der Trigger im
// Root-Header dispatcht `book-create:open`, die Karte hört darauf.

import { contentRepo } from '../repo/content.js';
import { fetchJson } from '../utils.js';

export const bookCreateMethods = {
  openCreateBook() {
    this.bookCreateName = '';
    this.bookCreateBuchtyp = '';
    this.bookCreateCategoryId = '';
    this.bookCreateError = '';
    this.bookCreateBusy = false;
    this._loadBookCreateCategories();
    const dlg = this.$refs?.bookCreateDialog;
    if (dlg && !dlg.open) dlg.showModal();
    this.$nextTick(() => {
      const input = this.$refs?.bookCreateInput;
      input?.focus();
    });
  },

  async _loadBookCreateCategories() {
    try {
      const pool = await fetchJson('/local/categories');
      this.bookCreateCategoryPool = pool.categories || [];
    } catch {
      this.bookCreateCategoryPool = [];
    }
  },

  // Buchtyp-Labels in der UI-Sprache; Keys sind sprachübergreifend identisch.
  bookCreateBuchtypOptions() {
    const lang = this.$store.shell.uiLocale || 'de';
    const typen = this.$store.shell.promptConfig?.buchtypen?.[lang] || this.$store.shell.promptConfig?.buchtypen?.de || {};
    return Object.entries(typen).map(([key, val]) => ({ value: key, label: val.label }));
  },

  bookCreateCategoryOptions() {
    return (this.bookCreateCategoryPool || []).map(c => ({ value: String(c.id), label: c.name }));
  },

  cancelCreateBook() {
    if (this.bookCreateBusy) return;
    const dlg = this.$refs?.bookCreateDialog;
    if (dlg && dlg.open) dlg.close();
    this.bookCreateName = '';
    this.bookCreateBuchtyp = '';
    this.bookCreateCategoryId = '';
    this.bookCreateError = '';
  },

  async submitCreateBook() {
    if (this.bookCreateBusy) return;
    const app = window.__app;
    const name = (this.bookCreateName || '').trim();
    if (!name) {
      this.bookCreateError = app.t('book.create.errorEmpty');
      return;
    }
    if (!this.bookCreateBuchtyp) {
      this.bookCreateError = app.t('book.settings.buchtypRequired');
      return;
    }
    if ((this.bookCreateCategoryPool || []).length > 0 && !this.bookCreateCategoryId) {
      this.bookCreateError = app.t('book.category.required');
      return;
    }
    this.bookCreateBusy = true;
    this.bookCreateError = '';
    try {
      const created = await contentRepo.createBook({ name });
      // Buchtyp + Kategorie am frisch angelegten Buch persistieren. Best-effort:
      // schlägt es fehl, existiert das Buch trotzdem und die Werte lassen sich in
      // den Settings nachpflegen (wohin wir gleich navigieren) — kein Doppelanlegen.
      try {
        const lang = this.$store.shell.uiLocale || 'de';
        const region = this.$store.shell.uiLocale === 'en' ? 'US' : 'CH';
        await fetch(`/booksettings/${created.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language: lang, region, buchtyp: this.bookCreateBuchtyp }),
        });
        if (this.bookCreateCategoryId) {
          await fetch(`/books/${created.id}/category`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category_id: parseInt(this.bookCreateCategoryId, 10) }),
          });
        }
      } catch (persistErr) {
        console.error('[book-create] Buchtyp/Kategorie persistieren fehlgeschlagen:', persistErr);
      }
      const dlg = this.$refs?.bookCreateDialog;
      if (dlg && dlg.open) dlg.close();
      this.bookCreateName = '';
      this.bookCreateBuchtyp = '';
      this.bookCreateCategoryId = '';
      await app.loadBooks({ fresh: true });
      this.$store.nav.selectedBookId = String(created.id);
      if (app.toggleBookSettingsCard) {
        if (!app.showBookSettingsCard) app.toggleBookSettingsCard();
      }
    } catch (e) {
      const msg = e.detail || e.code || e.message || String(e);
      this.bookCreateError = app.t('book.create.errorGeneric', { msg });
    } finally {
      this.bookCreateBusy = false;
    }
  },
};
