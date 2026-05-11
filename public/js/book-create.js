// Neues Buch direkt aus der App anlegen. Trigger: Combobox-Footer-Eintrag
// "+ Neues Buch …" → Modal mit Name-Feld → POST /books → Liste neu laden +
// neues Buch selektieren + Book-Settings-Karte öffnen (Buchtyp/Sprache erfasst
// der User dort im zweiten Schritt). Server-Route persistiert die lokale
// books-Row, damit Book-Settings-FK direkt funktioniert.

export const bookCreateMethods = {
  openCreateBook() {
    this.bookCreateName = '';
    this.bookCreateError = '';
    this.bookCreateBusy = false;
    this.bookCreateOpen = true;
    this.$nextTick(() => {
      if (typeof document === 'undefined') return;
      const input = document.querySelector('.book-create-dialog input');
      input?.focus();
    });
  },

  cancelCreateBook() {
    if (this.bookCreateBusy) return;
    this.bookCreateOpen = false;
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
      const res = await fetch('/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = body?.detail || body?.error_code || '';
        } catch { /* leer */ }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const created = await res.json();
      this.bookCreateOpen = false;
      this.bookCreateName = '';
      await this.loadBooks();
      this.selectedBookId = String(created.id);
      if (this.toggleBookSettingsCard) {
        if (!this.showBookSettingsCard) this.toggleBookSettingsCard();
      }
    } catch (e) {
      this.bookCreateError = this.t('book.create.errorGeneric', { msg: e.message || String(e) });
    } finally {
      this.bookCreateBusy = false;
    }
  },
};
