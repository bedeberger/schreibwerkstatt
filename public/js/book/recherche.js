// Methoden für die Recherche-/Wissensboard-Karte (Sub-Komponente).
// Buchweit geteiltes Archiv: Notizen, Links, Zitate, Faktensplitter, Bilder —
// optional mit Buch-Entitäten (Kapitel/Seite/Figur/Ort/Szene/Beat) verknüpfbar
// und über Tags filterbar. Rein kuratierend, nie generativ im Buchtext.

import { fetchJson } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';

const KINDS = ['note', 'link', 'quote', 'fact', 'image'];
// Verknüpfungs-Kategorien (Reihenfolge = Anzeige in Picker/Filter/Sortierung).
const LINK_KINDS = ['figure', 'location', 'scene', 'beat', 'thread', 'chapter', 'page'];

function _emptyDraft() {
  return { kind: 'note', title: '', body: '', url: '', source: '', tags: '' };
}

export const rechercheMethods = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async loadRecherche() {
    const app = window.__app;
    const bookId = app?.selectedBookId;
    if (!bookId) { this.items = []; return; }
    this.loading = true;
    try {
      const qs = new URLSearchParams({ book_id: String(bookId) });
      if (this.filterKind) qs.set('kind', this.filterKind);
      if (this.filterTag) qs.set('tag', this.filterTag);
      if (this.filterLinked) qs.set('linked', this.filterLinked);
      if ((this.filterText || '').trim()) qs.set('q', this.filterText.trim());
      if (this.showArchived) qs.set('archived', '1');
      if (this.sortBy && this.sortBy !== 'updated') qs.set('sort', this.sortBy);
      const rows = await fetchJson(`/research?${qs.toString()}`);
      this.items = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      this._loadTags();
      this.ensureLinkTargets();
    } catch (e) {
      this.errorMessage = app.t('recherche.error.load');
      this.items = [];
    } finally {
      this.loading = false;
    }
  },

  async _loadTags() {
    const bookId = window.__app?.selectedBookId;
    if (!bookId) { this.tagPool = []; return; }
    try {
      const rows = await fetchJson(`/research/tags?book_id=${bookId}`);
      this.tagPool = Array.isArray(rows) ? rows : [];
    } catch { this.tagPool = []; }
  },

  async ensureLinkTargets() {
    const bookId = window.__app?.selectedBookId;
    if (!bookId || this._linkTargetsBookId === bookId) return;
    try {
      this.linkTargets = await fetchJson(`/research/link-targets?book_id=${bookId}`);
      this._linkTargetsBookId = bookId;
    } catch { this.linkTargets = {}; }
  },

  resetRecherche() {
    this.items = [];
    this.tagPool = [];
    this.linkTargets = {};
    this._linkTargetsBookId = null;
    this.creating = false;
    this.draft = _emptyDraft();
    this.editingId = null;
    this.editDraft = _emptyDraft();
    this.filterKind = '';
    this.filterTag = '';
    this.filterLinked = '';
    this.filterLinkedKind = '';
    this.filterLinkedTargetId = '';
    this.filterText = '';
    this.sortBy = 'updated';
    this.showArchived = false;
    this.menuOpenId = null;
    this.linkPickerItemId = null;
    this.suggestions = {};
    this.errorMessage = '';
    this.busy = false;
    if (this._suggestTimer) { clearInterval(this._suggestTimer); this._suggestTimer = null; }
  },

  // ── Filter ───────────────────────────────────────────────────────────────
  applyFilters() { return this.loadRecherche(); },
  clearFilters() {
    this.filterKind = ''; this.filterTag = ''; this.filterText = '';
    this.filterLinked = ''; this.filterLinkedKind = ''; this.filterLinkedTargetId = '';
    return this.loadRecherche();
  },
  kindOptions() {
    const t = window.__app.t;
    return KINDS.map(k => ({ value: k, label: t(`recherche.kind.${k}`) }));
  },
  tagFilterOptions() {
    return (this.tagPool || []).map(r => ({ value: r.tag, label: `${r.tag} (${r.n})` }));
  },

  // Alle Verknüpfungs-Kategorien (geteilt zwischen Filter + Link-Picker).
  linkKinds() {
    return LINK_KINDS.map(k => ({ value: k, label: this.linkKindLabel(k) }));
  },
  // Sortier-Modi: feste Felder + „nach verknüpfter Entität" (link:<dimension>).
  sortOptions() {
    const t = window.__app.t;
    const opts = ['updated', 'created', 'title', 'kind'].map(s => ({ value: s, label: t(`recherche.sort.${s}`) }));
    for (const k of LINK_KINDS) opts.push({ value: `link:${k}`, label: t(`recherche.sort.by`, { kind: this.linkKindLabel(k) }) });
    return opts;
  },
  applySort() { return this.loadRecherche(); },

  // Filter „nach Verknüpfung": Kategorie + konkreter Eintrag → filterLinked.
  linkedFilterTargetOptions() {
    const arr = (this.linkTargets || {})[this.filterLinkedKind] || [];
    return arr.map(o => ({ value: String(o.id), label: o.label }));
  },
  onLinkedFilterKindChange() {
    this.filterLinkedTargetId = '';
    return this.applyLinkedFilter();
  },
  applyLinkedFilter() {
    this.filterLinked = (this.filterLinkedKind && this.filterLinkedTargetId)
      ? `${this.filterLinkedKind}:${this.filterLinkedTargetId}` : '';
    return this.loadRecherche();
  },

  // ── Anlegen ────────────────────────────────────────────────────────────────
  startCreate() {
    this.creating = true;
    this.draft = _emptyDraft();
    this.editingId = null;
  },
  cancelCreate() { this.creating = false; this.draft = _emptyDraft(); },

  async createItem() {
    const app = window.__app;
    const bookId = app?.selectedBookId;
    if (!bookId) return;
    const d = this.draft;
    if (!(d.title || '').trim() && !(d.body || '').trim() && !(d.url || '').trim()) {
      this.errorMessage = app.t('recherche.error.empty');
      return;
    }
    this.busy = true;
    try {
      const row = await fetchJson('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, ...this._draftBody(d) }),
      });
      this.items = [row, ...this.items];
      this.creating = false;
      this.draft = _emptyDraft();
      this.errorMessage = '';
      this._loadTags();
    } catch (e) {
      this.errorMessage = app.t('recherche.error.save');
    } finally {
      this.busy = false;
    }
  },

  // ── Bearbeiten ───────────────────────────────────────────────────────────
  startEdit(item) {
    this.editingId = item.id;
    this.creating = false;
    this.editDraft = {
      kind: item.kind || 'note',
      title: item.title || '',
      body: item.body || '',
      url: item.url || '',
      source: item.source || '',
      tags: (item.tags || []).join(', '),
    };
  },
  cancelEdit() { this.editingId = null; this.editDraft = _emptyDraft(); },

  async saveEdit(item) {
    const app = window.__app;
    this.busy = true;
    try {
      const row = await fetchJson(`/research/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._draftBody(this.editDraft)),
      });
      this._replaceItem(row);
      this.editingId = null;
      this.editDraft = _emptyDraft();
      this.errorMessage = '';
      this._loadTags();
    } catch (e) {
      this.errorMessage = app.t('recherche.error.save');
    } finally {
      this.busy = false;
    }
  },

  _draftBody(d) {
    const tags = (d.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    return {
      kind: d.kind, title: d.title.trim(), body: d.body.trim(),
      url: d.url.trim(), source: d.source.trim(), tags,
    };
  },

  async togglePin(item) {
    try {
      const row = await fetchJson(`/research/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !item.pinned }),
      });
      this._replaceItem(row);
      this.items = this._sortItems(this.items);
    } catch { this.errorMessage = window.__app.t('recherche.error.save'); }
    this.menuOpenId = null;
  },

  async toggleArchive(item) {
    try {
      await fetchJson(`/research/${item.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: !item.archived }),
      });
      // Bei aktivem „nur aktive"-Filter verschwindet das Item aus der Liste.
      if (!this.showArchived) this.items = this.items.filter(i => i.id !== item.id);
      else { item.archived = item.archived ? 0 : 1; }
    } catch { this.errorMessage = window.__app.t('recherche.error.save'); }
    this.menuOpenId = null;
  },

  async deleteItem(item) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('recherche.confirmDelete'),
      confirmLabel: app.t('common.delete'), danger: true,
    })) return;
    try {
      await fetchJson(`/research/${item.id}`, { method: 'DELETE' });
      this.items = this.items.filter(i => i.id !== item.id);
      this._loadTags();
    } catch { this.errorMessage = app.t('recherche.error.delete'); }
    this.menuOpenId = null;
  },

  // ── Verknüpfungen ──────────────────────────────────────────────────────────
  async openLinkPicker(item) {
    await this.ensureLinkTargets();
    this.linkPickerItemId = item.id;
    this.linkPickerKind = 'figure';
    this.linkPickerTargetId = '';
  },
  cancelLinkPicker() { this.linkPickerItemId = null; this.linkPickerTargetId = ''; },

  linkTargetOptions() {
    const arr = (this.linkTargets || {})[this.linkPickerKind] || [];
    return arr.map(o => ({ value: String(o.id), label: o.label }));
  },

  async addLink(itemId, targetKind, targetId) {
    const app = window.__app;
    if (!targetKind || !targetId) return;
    try {
      const row = await fetchJson(`/research/${itemId}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_kind: targetKind, target_id: parseInt(targetId, 10) }),
      });
      this._replaceItem(row);
      this.linkPickerItemId = null;
      this.linkPickerTargetId = '';
    } catch { this.errorMessage = app.t('recherche.error.link'); }
  },

  async confirmLinkPicker() {
    if (!this.linkPickerItemId || !this.linkPickerTargetId) return;
    return this.addLink(this.linkPickerItemId, this.linkPickerKind, this.linkPickerTargetId);
  },

  async removeLink(item, link) {
    try {
      const row = await fetchJson(`/research/${item.id}/links/${link.link_id}`, { method: 'DELETE' });
      this._replaceItem(row);
    } catch { this.errorMessage = window.__app.t('recherche.error.link'); }
  },

  // ── Bild-Upload ──────────────────────────────────────────────────────────
  async uploadImage(item, file) {
    const app = window.__app;
    if (!file) return;
    this.busy = true;
    try {
      const buf = await file.arrayBuffer();
      const row = await fetchJson(`/research/${item.id}/image`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: buf,
      });
      this._replaceItem(row);
    } catch { this.errorMessage = app.t('recherche.error.image'); }
    finally { this.busy = false; }
  },
  onImagePick(item, ev) {
    const file = ev?.target?.files?.[0];
    if (file) this.uploadImage(item, file);
    if (ev?.target) ev.target.value = '';
  },
  imageUrl(item) { return `/research/${item.id}/image`; },

  // ── KI-Verknüpfungsvorschläge ──────────────────────────────────────────────
  async suggestLinks(item) {
    const app = window.__app;
    const bookId = app?.selectedBookId;
    if (!bookId) return;
    this.suggestItemId = item.id;
    this.suggestStatus = app.t('recherche.suggest.running');
    this.suggestions = { ...this.suggestions, [item.id]: null };
    this.menuOpenId = null;
    try {
      const { jobId } = await fetchJson('/jobs/research-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, item_id: item.id }),
      });
      startPoll(this, {
        timerProp: '_suggestTimer',
        jobId,
        onNotFound: () => { this.suggestItemId = null; this.suggestStatus = ''; },
        onError: () => {
          this.suggestItemId = null;
          this.suggestStatus = '';
          this.errorMessage = app.t('recherche.suggest.error');
        },
        onDone: (job) => {
          this.suggestItemId = null;
          this.suggestStatus = '';
          const list = job.result?.suggestions || [];
          this.suggestions = { ...this.suggestions, [item.id]: list };
          if (!list.length) this.suggestStatus = app.t('recherche.suggest.none');
        },
      });
    } catch (e) {
      this.suggestItemId = null;
      this.suggestStatus = '';
      this.errorMessage = app.t('recherche.suggest.error');
    }
  },

  async acceptSuggestion(item, sugg) {
    await this.addLink(item.id, sugg.target_kind, sugg.target_id);
    const list = (this.suggestions[item.id] || []).filter(
      s => !(s.target_kind === sugg.target_kind && s.target_id === sugg.target_id)
    );
    this.suggestions = { ...this.suggestions, [item.id]: list };
  },
  dismissSuggestions(item) {
    const next = { ...this.suggestions };
    delete next[item.id];
    this.suggestions = next;
  },
  itemSuggestions(item) { return this.suggestions[item.id] || null; },

  // ── Helpers ──────────────────────────────────────────────────────────────
  _replaceItem(row) { this.items = this.items.map(i => (i.id === row.id ? row : i)); },
  _sortItems(arr) {
    return [...arr].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
  },
  kindLabel(k) { return window.__app.t(`recherche.kind.${k}`); },
  linkKindLabel(k) { return window.__app.t(`recherche.linkKind.${k}`); },
  hasItems() { return (this.items || []).length > 0; },
};
