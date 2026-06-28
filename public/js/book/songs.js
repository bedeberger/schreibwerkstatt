// Musik-Methoden am Root-Spread (von app-view, toggleSongsCard gerufen).

import { fetchJson } from '../utils.js';

export const songsMethods = {
  async loadSongs(bookId) {
    try {
      const data = await fetchJson('/songs/' + bookId);
      this.$store.catalog.songs = data?.songs || [];
      this.songsUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadSongs]', e);
    }
  },

  async saveSongs() {
    try {
      const r = await fetch('/songs/' + this.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songs: this.$store.catalog.songs }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.error('[saveSongs]', e);
    }
  },

  songsKapitelListe() {
    const seen = new Set();
    for (const s of this.$store.catalog.songs) {
      for (const k of (s.kapitel || [])) {
        if (k.name) seen.add(k.name);
      }
    }
    return [...seen].sort((a, b) => this._chapterIdx(a) - this._chapterIdx(b));
  },

  songsGenreListe() {
    const seen = new Set();
    for (const s of this.$store.catalog.songs) {
      if (s.genre) seen.add(s.genre);
    }
    return [...seen].sort();
  },

  songsKontextTypListe() {
    const seen = new Set();
    for (const s of this.$store.catalog.songs) {
      if (s.kontext_typ) seen.add(s.kontext_typ);
    }
    return [...seen].sort();
  },

  openSongById(id) {
    if (!this.$store.catalog.songs.some(s => s.id === id)) return;
    if (typeof this.toggleSongsCard === 'function' && !this.showSongsCard) this.toggleSongsCard();
    this.songsFilters = { suche: '', figurId: '', kapitel: '', szeneId: '', genre: '', kontextTyp: '' };
    this.selectedSongId = id;
    setTimeout(() => {
      const el = document.querySelector(`[data-song-id="${id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  },
};
