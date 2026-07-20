// Motiv-Werkstatt — CRUD für Themen, Motive, Beziehungen und Soll-Verknüpfungen,
// plus Auswahl + Fundstellen-Laden. Nach jeder Mutation lokalen State + Graph
// aktualisieren (loadBoard) statt Teil-Patches — die Boards sind klein.

import { fetchJson } from '../../utils.js';

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
  // Feld-Patch eines Motivs (name/beschreibung/theme_id/trigger_terms).
  async saveMotifField(motif, patch) {
    try { await _json(`/motifs/${motif.id}`, 'PATCH', patch); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  saveMotifName(motif, name) {
    const clean = (name || '').trim();
    if (!clean || clean === motif.name) return;
    return this.saveMotifField(motif, { name: clean });
  },
  saveMotifBeschreibung(motif, val) {
    if ((val || '') === (motif.beschreibung || '')) return;
    return this.saveMotifField(motif, { beschreibung: val || '' });
  },
  saveMotifTheme(motif, themeId) {
    const tid = themeId ? Number(themeId) : null;
    if (tid === (motif.theme_id || null)) return;
    return this.saveMotifField(motif, { theme_id: tid });
  },
  // Trigger-Begriffe aus Komma-separiertem Text.
  saveMotifTriggers(motif, text) {
    const terms = (text || '').split(',').map(s => s.trim()).filter(Boolean);
    return this.saveMotifField(motif, { trigger_terms: terms });
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

  // ── Soll-Verknüpfungen (Full-Replace aller vier Brücken) ─────────────────
  async _saveLinks(motif) {
    const body = {
      figures: (motif.figures || []).map(f => f.figId),
      beats: (motif.beats || []).map(b => b.id),
      chapters: (motif.chapters || []).map(c => c.id),
      pages: (motif.pages || []).map(p => p.id),
    };
    try { await _json(`/motifs/${motif.id}/links`, 'PUT', body); await this.loadBoard(); }
    catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
  // Verknüpfung hinzufügen/entfernen. kind: figures|beats|chapters|pages.
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

  async selectMotif(id) {
    this.selectedMotifId = id;
    this.occurrences = [];
    const m = this.motifById(id);
    this.editThemeId = m && m.theme_id ? String(m.theme_id) : '';
    if (!id) return;
    this._ensureBeats();
    this.occLoading = true;
    try {
      const data = await fetchJson(`/motifs/${id}/occurrences`);
      this.occurrences = data.occurrences || [];
    } catch (e) { /* Fundstellen sind optional; kein harter Fehler */ }
    finally { this.occLoading = false; }
    this._highlightNode(id);
  },

  gotoOccurrence(occ) {
    if (occ.page_id) window.__app.gotoPageById(occ.page_id);
  },
};
