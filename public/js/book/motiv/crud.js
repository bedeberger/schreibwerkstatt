// Motiv-Werkstatt — CRUD für Themen, Motive, Beziehungen und Soll-Verknüpfungen,
// plus Auswahl + Fundstellen-Laden. Nach jeder Mutation lokalen State + Graph
// aktualisieren (loadBoard) statt Teil-Patches — die Boards sind klein.

import { fetchJson } from '../../utils.js';
import { THEME_COLOR_KEYS, defaultThemeColorKey } from './graph.js';
import { highlightOccurrenceOnPage } from './highlight.js';

function _json(url, method, body) {
  return fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const crudMethods = {
  _bookId() { return this.$store.nav.selectedBookId; },

  // ── Themen ─────────────────────────────────────────────────────────────
  // Namensfeld eines Themas in der Panel-Liste fokussieren (nach Anlegen) — greift
  // nur, wenn die Themen-Liste sichtbar ist (kein Motiv selektiert); sonst No-Op.
  _focusThemeInput(themeId) {
    this.$nextTick(() => {
      const el = this.$root?.querySelector(`.motiv-theme-row[data-theme-id="${themeId}"] .motiv-inline-input`);
      if (el) { el.focus(); el.select(); }
    });
  },
  async addTheme() {
    const name = (this.newThemeName || '').trim();
    if (!name) return;
    this.busy = true;
    try {
      const theme = await _json('/motifs/themes', 'POST', { book_id: this._bookId(), name });
      this.newThemeName = '';
      await this.loadBoard();
      this._focusThemeInput(theme.id);
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  async renameTheme(theme, name) {
    const clean = (name || '').trim();
    if (!clean || clean === theme.name) return;
    try { await _json(`/motifs/themes/${theme.id}`, 'PATCH', { name: clean }); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  async deleteTheme(theme) {
    if (!window.confirm(window.__app.t('motiv.theme.confirmDelete', { name: theme.name }))) return;
    try { await _json(`/motifs/themes/${theme.id}`, 'DELETE'); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  // Palette-Schlüssel für den Farbwähler (theme-aware --palette-*-Tokens).
  themeColorKeys() { return THEME_COLOR_KEYS; },
  // Effektiver Palette-Schlüssel eines Themas (gewählt oder Auto nach Index) —
  // SSoT für die Swatch-Leiste, deckungsgleich mit der Graph-Farbe.
  themeSwatchKey(theme) {
    return theme.farbe || defaultThemeColorKey(this.themes.findIndex(t => t.id === theme.id));
  },
  toggleThemeColorPicker(themeId) {
    this.themeColorPickerId = this.themeColorPickerId === themeId ? null : themeId;
  },
  // Thema-Farbe setzen (key aus der Palette oder null = Auto nach Index). Optimistisch
  // lokal spiegeln, damit Graph + Swatch ohne Reload umfärben; loadBoard bestätigt.
  async setThemeColor(theme, key) {
    this.themeColorPickerId = null;
    const farbe = THEME_COLOR_KEYS.includes(key) ? key : null;
    if (farbe === (theme.farbe || null)) return;
    theme.farbe = farbe;
    try { await _json(`/motifs/themes/${theme.id}`, 'PATCH', { farbe }); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },

  // ── Motive ─────────────────────────────────────────────────────────────
  async addMotif() {
    const name = (this.newMotifName || '').trim();
    if (!name) return;
    this.busy = true;
    try {
      const body = { book_id: this._bookId(), name };
      if (this.newMotifThemeId) body.theme_id = Number(this.newMotifThemeId);
      const m = await _json('/motifs', 'POST', body);
      this.newMotifName = '';
      await this.loadBoard();
      this.selectMotif(m.id);
      this.$nextTick(() => this.$root?.querySelector('.motiv-name-input')?.focus());
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  // Motiv direkt anlegen (aus dem Graph-Kontextmenü) — mit Default-Namen, optional
  // einem Thema zugeordnet, danach im Panel selektiert + Namensfeld fokussiert zum
  // sofortigen Umbenennen.
  async createMotifAt(themeId) {
    this.closeGraphMenu();
    this.busy = true;
    try {
      const body = { book_id: this._bookId(), name: window.__app.t('motiv.motif.newName') };
      if (themeId) body.theme_id = Number(themeId);
      const m = await _json('/motifs', 'POST', body);
      await this.loadBoard();
      this.selectMotif(m.id);
      this.$nextTick(() => this.$root?.querySelector('.motiv-name-input')?.focus());
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  // Thema direkt anlegen (aus dem Graph-Kontextmenü) — mit Default-Namen; danach
  // inline in der Themen-Liste des Panels fokussiert zum sofortigen Umbenennen.
  async createThemeQuick() {
    this.closeGraphMenu();
    this.busy = true;
    try {
      const theme = await _json('/motifs/themes', 'POST', { book_id: this._bookId(), name: window.__app.t('motiv.theme.newName') });
      await this.loadBoard();
      this._focusThemeInput(theme.id);
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },

  // Edit-Puffer der Kern-Felder aus dem Motiv füllen (bei Auswahl/Cancel/Reload).
  _loadMotifBuffer(m) {
    this.editName = m ? (m.name || '') : '';
    this.editThemeId = m && m.theme_id ? String(m.theme_id) : '';
    this.editBeschreibung = m ? (m.beschreibung || '') : '';
    this.editTriggers = m ? (m.trigger_terms || []).join(', ') : '';
  },
  // Trigger-Puffer (Komma-Text) auf die kanonische Term-Liste normalisieren.
  _bufferTriggerTerms() {
    return (this.editTriggers || '').split(',').map(s => s.trim()).filter(Boolean);
  },
  // Ungespeicherte Änderungen an den Kern-Feldern (Name/Thema/Beschreibung/Trigger)?
  _coreDirty() {
    const m = this.selectedMotif();
    if (!m) return false;
    const tid = this.editThemeId ? Number(this.editThemeId) : null;
    return (this.editName || '').trim() !== (m.name || '')
      || tid !== (m.theme_id || null)
      || (this.editBeschreibung || '') !== (m.beschreibung || '')
      || this._bufferTriggerTerms().join(', ') !== (m.trigger_terms || []).join(', ');
  },
  // Ungespeicherte Änderungen am Motiv gesamt (Kern-Felder ODER Soll-Verknüpfungen)?
  // Steuert Sichtbarkeit des einen Save/Cancel-Icons in der Titelzeile — es erscheint
  // also auch, sobald eine Combobox-Auswahl eine Verknüpfung in den Puffer legt.
  motifDirty() {
    return this._coreDirty() || this.linksDirty();
  },
  // Alle Puffer (Kern-Felder + Verknüpfungen) auf den gespeicherten Motivstand zurücksetzen.
  cancelMotifEdit() {
    const m = this.selectedMotif();
    this._loadMotifBuffer(m);
    this._loadLinkBuffer(m);
  },
  // Motiv speichern: geänderte Kern-Felder als PATCH und/oder geänderte Soll-Links
  // als Full-Replace-PUT — ein Save-Button für beides, danach ein loadBoard.
  async saveMotifEdit() {
    const m = this.selectedMotif();
    if (!m || !this.motifDirty()) return;
    const coreDirty = this._coreDirty();
    const linksDirty = this.linksDirty();
    const name = (this.editName || '').trim();
    if (coreDirty && !name) { this.errorMessage = window.__app.t('motiv.error.nameRequired'); return; }
    this.busy = true;
    try {
      if (coreDirty) {
        await _json(`/motifs/${m.id}`, 'PATCH', {
          name,
          theme_id: this.editThemeId ? Number(this.editThemeId) : null,
          beschreibung: this.editBeschreibung || '',
          trigger_terms: this._bufferTriggerTerms(),
        });
      }
      if (linksDirty) {
        await _json(`/motifs/${m.id}/links`, 'PUT', {
          figures: this.editFigures.map(f => f.figId),
          draftFigures: this.editDraftFigures.map(f => f.id),
          beats: this.editBeats.map(b => b.id),
          chapters: this.editChapters.map(c => c.id),
          pages: this.editPages.map(p => p.id),
        });
      }
      await this.loadBoard();
      const sel = this.selectedMotif();
      this._loadMotifBuffer(sel);
      this._loadLinkBuffer(sel);
      this.errorMessage = '';
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { this.busy = false; }
  },
  async deleteMotif(motif) {
    if (!window.confirm(window.__app.t('motiv.motif.confirmDelete', { name: motif.name }))) return;
    try {
      await _json(`/motifs/${motif.id}`, 'DELETE');
      if (this.selectedMotifId === motif.id) { this.selectedMotifId = null; this.occurrences = []; }
      await this.loadBoard();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },

  // ── Beziehungen (Motiv ↔ Motiv) ──────────────────────────────────────────
  async addRelation() {
    const from = this.selectedMotifId;
    const to = this.newRelationTargetId ? Number(this.newRelationTargetId) : null;
    const typ = (this.newRelationTyp || '').trim();
    if (!from || !to || from === to || !typ) return;
    try {
      await _json('/motifs/relations', 'POST', { from_motif_id: from, to_motif_id: to, typ });
      this.newRelationTargetId = '';
      this.newRelationTyp = '';
      await this.loadBoard();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  async deleteRelation(rel) {
    try { await _json(`/motifs/relations/${rel.id}`, 'DELETE'); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  // Beziehungen, die das gewählte Motiv berühren (mit Richtungs-/Partner-Label).
  relationsForSelected() {
    const id = this.selectedMotifId;
    if (!id) return [];
    return this.relations
      .filter(r => r.from_motif_id === id || r.to_motif_id === id)
      .map(r => {
        const otherId = r.from_motif_id === id ? r.to_motif_id : r.from_motif_id;
        const other = this.motifById(otherId);
        return { ...r, outgoing: r.from_motif_id === id, otherName: other ? other.name : '?' };
      });
  },

  // ── Soll-Verknüpfungen (explizit gespeichert via Save/Cancel, kein Auto-Save) ─
  // Die Chips bearbeiten lokale Puffer (editFigures/…); erst saveMotifEdit() schickt
  // den Full-Replace aller fünf Brücken (ein Motiv-Save deckt Kern-Felder + Links).
  // kind (figures|draftFigures|beats|chapters|pages) → Puffer-Property.
  _linkBufKey(kind) {
    return { figures: 'editFigures', draftFigures: 'editDraftFigures', beats: 'editBeats', chapters: 'editChapters', pages: 'editPages' }[kind];
  },
  // Verknüpfungs-Puffer aus dem Motiv füllen (bei Auswahl/Cancel/nach Save). Kopien,
  // damit Chip-Mutationen den Board-State nicht anfassen, bevor gespeichert wird.
  _loadLinkBuffer(m) {
    this.editFigures = m ? (m.figures || []).map(x => ({ ...x })) : [];
    this.editDraftFigures = m ? (m.draftFigures || []).map(x => ({ ...x })) : [];
    this.editBeats = m ? (m.beats || []).map(x => ({ ...x })) : [];
    this.editChapters = m ? (m.chapters || []).map(x => ({ ...x })) : [];
    this.editPages = m ? (m.pages || []).map(x => ({ ...x })) : [];
  },
  // Figuren-Combobox mischt zwei Quellen; der Auswahl-Wert trägt ein Präfix
  // (fig:<fig_id> = Komplettanalyse, draft:<id> = Plotwerkstatt) → richtige Brücke.
  addFigureLink(val) {
    if (val == null || val === '') return;
    const s = String(val);
    if (s.startsWith('draft:')) this.addLink('draftFigures', s.slice(6));
    else this.addLink('figures', s.startsWith('fig:') ? s.slice(4) : s);
  },
  // Verknüpfung im Puffer hinzufügen/entfernen (kein Persist — erst saveMotifEdit).
  toggleLink(kind, item) {
    if (!this.selectedMotif()) return;
    const idKey = kind === 'figures' ? 'figId' : 'id';
    const arr = this[this._linkBufKey(kind)];
    const ix = arr.findIndex(x => x[idKey] === item[idKey]);
    if (ix >= 0) arr.splice(ix, 1);
    else arr.push(item);
  },
  // Verknüpfung per Auswahl-Wert (Combobox) in den Puffer legen — Item aus der Quelle auflösen.
  addLink(kind, idVal) {
    if (!this.selectedMotif() || idVal == null || idVal === '') return;
    let item = null;
    if (kind === 'figures') {
      // Katalog-Figuren tragen die TEXT-fig_id im `.id`-Feld (siehe /figures: id = f.fig_id),
      // NICHT in `.fig_id`. Die Soll-Brücke speichert sie als `figId`.
      const f = (this.$store.catalog.figuren || []).find(x => String(x.id) === String(idVal));
      if (f) item = { figId: f.id, name: f.name };
    } else if (kind === 'draftFigures') {
      const d = (this.allDraftFiguren || []).find(x => String(x.id) === String(idVal));
      if (d) item = { id: Number(d.id), name: d.name };
    } else if (kind === 'beats') {
      const b = this.allBeats.find(x => String(x.id) === String(idVal));
      if (b) item = { id: b.id, titel: b.titel };
    } else if (kind === 'chapters') {
      const c = (this.$store.nav.tree || []).find(t => t.type === 'chapter' && String(t.id) === String(idVal));
      if (c) item = { id: Number(idVal), name: c.name };
    } else if (kind === 'pages') {
      const p = (this.$store.nav.pages || []).find(x => String(x.id) === String(idVal));
      if (p) item = { id: Number(idVal), name: p.name };
    }
    if (!item) return;
    const idKey = kind === 'figures' ? 'figId' : 'id';
    const arr = this[this._linkBufKey(kind)];
    if (arr.some(x => x[idKey] === item[idKey])) return; // schon verknüpft
    arr.push(item);
  },

  hasLink(kind, idVal) {
    if (!this.selectedMotif()) return false;
    const idKey = kind === 'figures' ? 'figId' : 'id';
    return this[this._linkBufKey(kind)].some(x => x[idKey] === idVal);
  },

  // Ungespeicherte Änderungen an den Soll-Verknüpfungen? (ID-Mengen-Vergleich Puffer ↔ Motiv.)
  // Fliesst in motifDirty() ein — mitgespeichert vom einen Motiv-Save/Cancel.
  linksDirty() {
    const m = this.selectedMotif();
    if (!m) return false;
    const key = (arr, k) => (arr || []).map(x => String(x[k])).sort().join(',');
    return key(this.editFigures, 'figId') !== key(m.figures, 'figId')
      || key(this.editDraftFigures, 'id') !== key(m.draftFigures, 'id')
      || key(this.editBeats, 'id') !== key(m.beats, 'id')
      || key(this.editChapters, 'id') !== key(m.chapters, 'id')
      || key(this.editPages, 'id') !== key(m.pages, 'id');
  },

  // ── Auswahl + Fundstellen ────────────────────────────────────────────────
  // Plot-Beats fürs Verknüpfungs-Combobox (lazy, einmal pro Board-Load).
  // Akte werden mitgeladen, damit die Beats im Combobox nach Akt gruppiert
  // erscheinen (opt.group) statt als flache Liste.
  async _ensureBeats() {
    if (this._beatsLoaded) return;
    this._beatsLoaded = true;
    try {
      const data = await fetchJson(`/plot?book_id=${this._bookId()}`);
      this.allBeats = (data.beats || []).map(b => ({ id: b.id, titel: b.titel, actId: b.act_id }));
      this.allActs = (data.acts || []).map(a => ({ id: a.id, name: a.name }));
    } catch (e) { this.allBeats = []; this.allActs = []; }
  },
  // Werkstatt-Figuren (draft_figures) fürs Figuren-Combobox (Gruppe „Plotwerkstatt").
  async _ensureDraftFiguren() {
    if (this._draftFigurenLoaded) return;
    this._draftFigurenLoaded = true;
    try {
      const data = await fetchJson(`/draft-figures/${this._bookId()}`);
      this.allDraftFiguren = (Array.isArray(data) ? data : []).map(d => ({ id: d.id, name: d.name }));
    } catch (e) { this.allDraftFiguren = []; }
  },

  async selectMotif(id) {
    // Re-Klick auf das bereits gewählte Motiv (z.B. sein Graph-Knoten): Edit-Puffer
    // NICHT neu laden — sonst verwirft der Klick ungespeicherte Änderungen (Name/
    // Thema/Verknüpfungen) kommentarlos und der Graph behält den alten Stand.
    const sameId = !!id && id === this.selectedMotifId;
    this.selectedMotifId = id;
    if (!sameId) {
      this.occurrences = [];
      this._loadMotifBuffer(this.motifById(id));
      this._loadLinkBuffer(this.motifById(id));
    }
    if (!id) return;
    this.occExpanded = this._readSectionExpanded('occ', id);
    this.linksExpanded = this._readSectionExpanded('links', id);
    this.relationsExpanded = this._readSectionExpanded('relations', id);
    this._ensureBeats();
    this._ensureDraftFiguren();
    this.occLoading = true;
    try {
      const data = await fetchJson(`/motifs/${id}/occurrences`);
      this.occurrences = data.occurrences || [];
    } catch (e) { /* Fundstellen sind optional; kein harter Fehler */ }
    finally { this.occLoading = false; }
    this._highlightNode(id);
  },

  // Auf-/Zuklapp-Zustand einer Panel-Sektion (occ/links/relations) pro Motiv
  // (localStorage; Default offen → nur der zugeklappte Zustand wird gespeichert,
  // offen räumt den Key).
  _sectionExpandedKey(section, id) { return `sw:motiv:${section}-expanded:${id}`; },
  _readSectionExpanded(section, id) {
    try { return localStorage.getItem(this._sectionExpandedKey(section, id)) !== '0'; }
    catch (e) { return true; }
  },
  _persistSectionExpanded(section, id, open) {
    try {
      if (open) localStorage.removeItem(this._sectionExpandedKey(section, id));
      else localStorage.setItem(this._sectionExpandedKey(section, id), '0');
    } catch (e) { /* localStorage optional */ }
  },

  // Anzahl Soll-Verknüpfungen über alle fünf Brücken (Badge in der Sektion) —
  // aus dem Puffer, damit der Zähler den ungespeicherten Bearbeitungsstand zeigt.
  linkCount() {
    if (!this.selectedMotif()) return 0;
    return this.editFigures.length + this.editDraftFigures.length
      + this.editBeats.length + this.editChapters.length + this.editPages.length;
  },

  gotoOccurrence(occ) {
    if (!occ.page_id) return;
    window.__app.gotoPageById(occ.page_id);
    // Passage im Seitentext hervorheben (reines Lesen; findet sie nichts, bleibt
    // der Sprung auf die Seite bestehen).
    if (occ.snippet) highlightOccurrenceOnPage(occ.snippet);
  },
};
