// Neues Buch direkt aus der App anlegen. Trigger: Combobox-Footer-Eintrag
// "+ Neues Buch …" → Modal mit Name-Feld → contentRepo.createBook → Liste neu
// laden + neues Buch selektieren + Book-Settings-Karte öffnen (Buchtyp/Sprache
// erfasst der User dort im zweiten Schritt). Server-Route persistiert die
// lokale books-Row, damit Book-Settings-FK direkt funktioniert.

import { contentRepo } from '../repo/content.js';

export const bookCreateMethods = {
  openCreateBook() {
    this.bookCreateName = '';
    this.bookCreateError = '';
    this.bookCreateBusy = false;
    const dlg = this.$refs?.bookCreateDialog;
    if (dlg && !dlg.open) dlg.showModal();
    this.$nextTick(() => {
      const input = this.$refs?.bookCreateInput;
      input?.focus();
    });
  },

  cancelCreateBook() {
    if (this.bookCreateBusy) return;
    const dlg = this.$refs?.bookCreateDialog;
    if (dlg && dlg.open) dlg.close();
    this.bookCreateName = '';
    this.bookCreateError = '';
  },

  async submitCreateBook() {
    if (this.bookCreateBusy) return;
    const name = (this.bookCreateName || '').trim();
    if (!name) {
      this.bookCreateError = this.t('book.create.errorEmpty');
      return;
    }
    this.bookCreateBusy = true;
    this.bookCreateError = '';
    try {
      const created = await contentRepo.createBook({ name });
      const dlg = this.$refs?.bookCreateDialog;
      if (dlg && dlg.open) dlg.close();
      this.bookCreateName = '';
      await this.loadBooks();
      this.selectedBookId = String(created.id);
      if (this.toggleBookSettingsCard) {
        if (!this.showBookSettingsCard) this.toggleBookSettingsCard();
      }
    } catch (e) {
      const msg = e.detail || e.code || e.message || String(e);
      this.bookCreateError = this.t('book.create.errorGeneric', { msg });
    } finally {
      this.bookCreateBusy = false;
    }
  },
};
