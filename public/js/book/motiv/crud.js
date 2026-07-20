// Motiv-Werkstatt — CRUD für Themen, Motive, Beziehungen und Soll-Verknüpfungen,
// plus Auswahl + Fundstellen-Laden. Nach jeder Mutation lokalen State + Graph
// aktualisieren (loadBoard) statt Teil-Patches — die Boards sind klein.

import { fetchJson } from '../../utils.js';
import { THEME_COLOR_KEYS } from './graph.js';
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
  async addTheme() {
    const name = (this.newThemeName || '').trim();
    if (!name) return;
    this.busy = true;
    try {
      await _json('/motifs/themes', 'POST', { book_id: this._bookId(), name });
      this.newThemeName = '';
      await this.loadBoard();
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
  // Thema direkt anlegen (aus dem Graph-Kontextmenü) — mit Default-Namen; umbenannt
  // wird inline in der Themen-Liste des Panels.
  async createThemeQuick() {
    this.closeGraphMenu();
    this.busy = true;
    try {
      await _json('/motifs/themes', 'POST', { book_id: this._bookId(), name: window.__app.t('motiv.theme.newName') });
      await this.loadBoard();
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
  // Ungespeicherte Änderungen an Name/Thema/Beschreibung/Trigger?
  motifDirty() {
    const m = this.selectedMotif();
    if (!m) return false;
    const tid = this.editThemeId ? Number(this.editThemeId) : null;
    return (this.editName || '').trim() !== (m.name || '')
      || tid !== (m.theme_id || null)
      || (this.editBeschreibung || '') !== (m.beschreibung || '')
      || this._bufferTriggerTerms().join(', ') !== (m.trigger_terms || []).join(', ');
  },
  // Puffer auf den gespeicherten Motivstand zurücksetzen.
  cancelMotifEdit() {
    this._loadMotifBuffer(this.selectedMotif());
  },
  // Alle geänderten Kern-Felder in einem PATCH speichern.
  async saveMotifEdit() {
    const m = this.selectedMotif();
    if (!m || !this.motifDirty()) return;
    const name = (this.editName || '').trim();
    if (!name) { this.errorMessage = window.__app.t('motiv.error.nameRequired'); return; }
    const patch = {
      name,
      theme_id: this.editThemeId ? Number(this.editThemeId) : null,
      beschreibung: this.editBeschreibung || '',
      trigger_terms: this._bufferTriggerTerms(),
    };
    this.busy = true;
    try {
      await _json(`/motifs/${m.id}`, 'PATCH', patch);
      await this.loadBoard();
      this._loadMotifBuffer(this.selectedMotif());
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

  // ── Soll-Verknüpfungen (Full-Replace aller fünf Brücken) ─────────────────
  async _saveLinks(motif) {
    const body = {
      figures: (motif.figures || []).map(f => f.figId),
      draftFigures: (motif.draftFigures || []).map(f => f.id),
      beats: (motif.beats || []).map(b => b.id),
      chapters: (motif.chapters || []).map(c => c.id),
      pages: (motif.pages || []).map(p => p.id),
    };
    try { await _json(`/motifs/${motif.id}/links`, 'PUT', body); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  // Figuren-Combobox mischt zwei Quellen; der Auswahl-Wert trägt ein Präfix
  // (fig:<fig_id> = Komplettanalyse, draft:<id> = Plotwerkstatt) → richtige Brücke.
  addFigureLink(val) {
    if (val == null || val === '') return;
    const s = String(val);
    if (s.startsWith('draft:')) this.addLink('draftFigures', s.slice(6));
    else this.addLink('figures', s.startsWith('fig:') ? s.slice(4) : s);
  },
  // Verknüpfung hinzufügen/entfernen. kind: figures|draftFigures|beats|chapters|pages.
  toggleLink(kind, item) {
    const motif = this.selectedMotif();
    if (!motif) return;
    const idKey = kind === 'figures' ? 'figId' : 'id';
    const arr = motif[kind] || (motif[kind] = []);
    const ix = arr.findIndex(x => x[idKey] === item[idKey]);
    if (ix >= 0) arr.splice(ix, 1);
    else arr.push(item);
    this._saveLinks(motif);
  },
  // Verknüpfung per Auswahl-Wert (Combobox) hinzufügen — Item aus der Quelle auflösen.
  addLink(kind, idVal) {
    const motif = this.selectedMotif();
    if (!motif || idVal == null || idVal === '') return;
    let item = null;
    if (kind === 'figures') {
      const f = (this.$store.catalog.figuren || []).find(x => x.fig_id === idVal);
      if (f) item = { figId: f.fig_id, name: f.name };
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
    if ((motif[kind] || []).some(x => x[idKey] === item[idKey])) return; // schon verknüpft
    (motif[kind] || (motif[kind] = [])).push(item);
    this._saveLinks(motif);
  },

  hasLink(kind, idVal) {
    const motif = this.selectedMotif();
    if (!motif) return false;
    const idKey = kind === 'figures' ? 'figId' : 'id';
    return (motif[kind] || []).some(x => x[idKey] === idVal);
  },

  // ── Auswahl + Fundstellen ────────────────────────────────────────────────
  // Plot-Beats fürs Verknüpfungs-Combobox (lazy, einmal pro Board-Load).
  async _ensureBeats() {
    if (this._beatsLoaded) return;
    this._beatsLoaded = true;
    try {
      const data = await fetchJson(`/plot?book_id=${this._bookId()}`);
      this.allBeats = (data.beats || []).map(b => ({ id: b.id, titel: b.titel }));
    } catch (e) { this.allBeats = []; }
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
    this.selectedMotifId = id;
    this.occurrences = [];
    this._loadMotifBuffer(this.motifById(id));
    if (!id) return;
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

  gotoOccurrence(occ) {
    if (!occ.page_id) return;
    window.__app.gotoPageById(occ.page_id);
    // Passage im Seitentext hervorheben (reines Lesen; findet sie nichts, bleibt
    // der Sprung auf die Seite bestehen).
    if (occ.snippet) highlightOccurrenceOnPage(occ.snippet);
  },
};
