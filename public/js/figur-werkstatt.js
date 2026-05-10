// Methoden für die Figuren-Werkstatt-Karte (Sub-Komponente).
// Phase 4: jsMind-Editor + KI-Brainstorm + Konsistenz-Check.
// CRUD + Mindmap-Lifecycle + Job-Trigger + Result-Apply.

import { fetchJson } from './utils.js';
import { loadJsMind } from './lazy-libs.js';
import { startPoll, runningJobStatus } from './cards/job-helpers.js';

// Server persistiert Default-Knoten-Labels als `__i18n:werkstatt.tree.foo__`.
// Frontend löst beim Render via t() in die User-Locale auf.
const I18N_MARKER = /^__i18n:([a-zA-Z0-9_.-]+)__$/;
function resolveTopic(topic) {
  const m = I18N_MARKER.exec(topic || '');
  return m ? window.__app.t(m[1]) : (topic || '');
}

// Mindmap-Topics werden vor dem Show in jsMind durch resolved Strings ersetzt;
// beim Speichern bleiben User-Edits direkt erhalten (Default-Marker werden
// überschrieben sobald User Knoten umbenennt).
function resolveMindmapForDisplay(mindmap) {
  if (!mindmap?.data) return mindmap;
  const cloneNode = (n) => ({
    ...n,
    topic: resolveTopic(n.topic),
    children: (n.children || []).map(cloneNode),
  });
  return { ...mindmap, data: cloneNode(mindmap.data) };
}

// Knoten-ID-Generator für jsMind (eindeutig pro Mindmap).
function _newNodeId() {
  return 'n' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export const figurWerkstattMethods = {
  // ── Dirty-Tracking ────────────────────────────────────────────────────────
  // Vergleich Form-Felder gegen selectedDraft + _mindmapDirty-Flag (gesetzt
  // durch jsMind-Mutationsevents in _mountMindmap). Reload via card:refresh
  // prüft isDirty() und ruft appConfirm, bevor er die Server-Daten neu lädt.
  isDirty() {
    const sel = this.selectedDraft();
    if (!sel) return false;
    if ((this.editName || '').trim() !== (sel.name || '').trim()) return true;
    if ((this.editArchetype || '') !== (sel.archetype || '')) return true;
    if ((this.editNotes || '') !== (sel.notes || '')) return true;
    return !!this._mindmapDirty;
  },

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async loadDrafts() {
    const app = window.__app;
    const bookId = app?.selectedBookId;
    if (!bookId) { this.drafts = []; return; }
    this.loading = true;
    try {
      const rows = await fetchJson(`/draft-figures/${bookId}`);
      this.drafts = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
      if (this.selectedDraftId && !this.drafts.find(d => d.id === this.selectedDraftId)) {
        this.selectedDraftId = null;
      }
      if (!this.selectedDraftId && this.drafts.length > 0) {
        this.selectDraft(this.drafts[0].id);
      } else if (this.selectedDraftId) {
        this.$nextTick(() => this._mountMindmap());
      }
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.load') || app.t('common.error');
      this.drafts = [];
    } finally {
      this.loading = false;
    }
  },

  resetDrafts() {
    this._destroyMindmap();
    this._clearJobs();
    this._hideContextMenu?.();
    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch {}
    }
    this.drafts = [];
    this.selectedDraftId = null;
    this.selectedKnotenId = null;
    this.editName = '';
    this.editArchetype = '';
    this.editNotes = '';
    this.creating = false;
    this.newName = '';
    this.errorMessage = '';
    this.busy = false;
    this.brainstormResult = null;
    this.consistencyResult = null;
    this.mindmapFullscreen = false;
    this.contextMenuOpen = false;
    this._mindmapDirty = false;
  },

  selectDraft(id) {
    const d = this.drafts.find(x => x.id === id);
    if (!d) { this.selectedDraftId = null; return; }
    // jsMind zwischen Drafts NICHT wiederverwenden: _jm.show(newMind) räumt
    // weder DOM noch interne node-map zuverlässig auf, wenn vorher add_node /
    // remove_node lief (Brainstorm-Apply, Context-Menu-Mutationen). Resultat:
    // neuer Draft zeigt Knoten des vorherigen. Frischer Editor pro Auswahl.
    if (this.selectedDraftId !== id) this._destroyMindmap();
    this.selectedDraftId = id;
    this.editName = d.name;
    this.editArchetype = d.archetype || '';
    this.editNotes = d.notes || '';
    this.creating = false;
    this.brainstormResult = null;
    this.consistencyResult = null;
    this.selectedKnotenId = null;
    this._mindmapDirty = false;
    this.$nextTick(() => this._mountMindmap());
  },

  selectedDraft() {
    if (!this.selectedDraftId) return null;
    return this.drafts.find(d => d.id === this.selectedDraftId) || null;
  },

  startCreate() {
    this.creating = true;
    this.newName = '';
    this.errorMessage = '';
    this.$nextTick(() => {
      const input = this.$el?.querySelector('.werkstatt-new-name');
      input?.focus();
    });
  },

  cancelCreate() {
    this.creating = false;
    this.newName = '';
  },

  async createDraft() {
    const app = window.__app;
    const name = (this.newName || '').trim();
    if (!name) { this.errorMessage = app.t('werkstatt.error.nameRequired') || app.t('common.error'); return; }
    const bookId = app.selectedBookId;
    if (!bookId) return;
    this.busy = true;
    try {
      const row = await fetchJson(`/draft-figures/${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.drafts = [row, ...this.drafts];
      this.creating = false;
      this.newName = '';
      this.selectDraft(row.id);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.create') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  async saveDraft() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) return;
    const name = (this.editName || '').trim();
    if (!name) { this.errorMessage = app.t('werkstatt.error.nameRequired') || app.t('common.error'); return; }
    // Mindmap nur aus jsMind exportieren, wenn Editor zu diesem Draft gehört
    // (_jmDraftId wird in _mountMindmap nach _jm.show() gesetzt, in
    // _destroyMindmap genullt). Sonst Server-State behalten — verhindert
    // Überschreiben mit dem Tree, der zufällig im jsMind-DOM steht.
    const exported = this._jmDraftId === sel.id ? this._exportMindmap() : null;
    const mindmap = exported || sel.mindmap;
    this.busy = true;
    try {
      const updated = await fetchJson(`/draft-figures/${sel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          archetype: this.editArchetype || null,
          notes: this.editNotes || null,
          mindmap,
        }),
      });
      this.drafts = this.drafts.map(d => d.id === updated.id ? updated : d);
      this.errorMessage = '';
      this._mindmapDirty = false;
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.save') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  async requestDelete() {
    const sel = this.selectedDraft();
    if (!sel) return;
    const app = window.__app;
    const ok = await app.appConfirm({
      message: app.t('werkstatt.confirmDelete'),
      danger: true,
    });
    if (!ok) return;
    await this._doDelete(sel.id);
  },

  async _doDelete(id) {
    const app = window.__app;
    this.busy = true;
    try {
      await fetchJson(`/draft-figures/${id}`, { method: 'DELETE' });
      this._destroyMindmap();
      this.drafts = this.drafts.filter(d => d.id !== id);
      if (this.selectedDraftId === id) {
        this.selectedDraftId = null;
        this.editName = '';
        this.editArchetype = '';
        this.editNotes = '';
        this.brainstormResult = null;
        this.consistencyResult = null;
        if (this.drafts.length > 0) this.selectDraft(this.drafts[0].id);
      }
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.delete') || app.t('common.error');
    } finally {
      this.busy = false;
    }
  },

  // ── Mindmap-Lifecycle (jsMind) ────────────────────────────────────────────
  async _mountMindmap() {
    const sel = this.selectedDraft();
    if (!sel) return;
    const container = this.$el?.querySelector('.werkstatt-mindmap');
    if (!container) return;
    // jsMind misst Knotengrößen nur, wenn `container.offsetParent` gesetzt ist.
    // Beim ersten Öffnen der Karte kann Alpine $nextTick vor dem x-show-Flush
    // feuern — dann fällt jsMind in c11y-Mode. Defer per rAF, bis sichtbar.
    if (!container.offsetParent) {
      const draftId = this.selectedDraftId;
      requestAnimationFrame(() => {
        if (this.selectedDraftId === draftId && window.__app?.showFigurWerkstattCard) {
          this._mountMindmap();
        }
      });
      return;
    }
    let jsMind;
    try {
      jsMind = await loadJsMind();
    } catch (e) {
      this.errorMessage = window.__app.t('werkstatt.error.libLoad') || 'Library load failed';
      return;
    }
    if (!this._jm) {
      // Canvas-Linien: jsMind zeichnet auf <canvas>, also kein CSS-Targeting.
      // Linienfarbe aus globalem Token --color-border lesen, Fallback grau.
      const cs = getComputedStyle(document.documentElement);
      const lineColor = (cs.getPropertyValue('--color-border').trim() || '#888');
      this._jm = new jsMind({
        container,
        editable: true,
        theme: 'primary',
        view: { hmargin: 80, vmargin: 40, line_width: 1.5, line_color: lineColor, draggable: true, hide_scrollbars_when_draggable: true },
        layout: { hspace: 30, vspace: 18, pspace: 14 },
        // Tastatur-Navigation: Pfeiltasten navigieren, Tab fügt Sub-Knoten,
        // Enter Geschwister, F2 Editieren, Delete entfernt, Space toggle.
        // jsMind-Default für `addchild` ist nur Insert (45) + Ctrl+Enter (4109);
        // Tab (9) explizit ergänzen, weil Mac-Tastaturen kein Insert haben und
        // Tab als Mindmap-Standard erwartet wird (jsMind preventDefault'et Tab
        // ohnehin).
        shortcut: {
          enable: true,
          mapping: {
            addchild: [9, 45, 4109],
            addbrother: 13,
            editnode: 113,
            delnode: 46,
            toggle: 32,
            left: 37, up: 38, right: 39, down: 40,
          },
        },
      });
      // Selection-Tracking für KI-Brainstorm + Auto-Center bei Tastatur-Nav.
      // type === 4 → Selection. type === 3 → Edit (add/remove/rename/move).
      this._jm.add_event_listener((type, data) => {
        if (type === 4) {
          const id = data?.node || null;
          this.selectedKnotenId = id;
          if (id) this._centerNodeInView(id);
        } else if (type === 3) {
          this._mindmapDirty = true;
        }
      });
      // Rechtsklick auf jmnode → Context-Menu mit Mindmap-Funktionen.
      container.addEventListener('contextmenu', (ev) => this._onMindmapContextMenu(ev));
    }
    this._jm.show(resolveMindmapForDisplay(sel.mindmap));
    // _jm an Draft-ID binden: saveDraft exportiert nur, wenn Editor diesen
    // Draft hält. Verhindert Cross-Contamination, falls _mountMindmap zwischen
    // Auswahl und Save für anderen Draft umgemounted hätte.
    this._jmDraftId = sel.id;
    this.selectedKnotenId = sel.mindmap?.data?.id || 'root';
    // Auto-Fokus auf Mindmap-Panel: jsMind setzt tabIndex=1 auf .jsmind-inner —
    // damit Pfeiltasten/Tab/Enter direkt greifen, ohne dass User vorher klicken muss.
    this.$nextTick(() => {
      const panel = container.querySelector('.jsmind-inner');
      if (panel) panel.focus({ preventScroll: true });
    });
  },

  _destroyMindmap() {
    // jsMind hat keine offizielle destroy()-Methode; container leeren reicht.
    const container = this.$el?.querySelector?.('.werkstatt-mindmap');
    if (container) container.innerHTML = '';
    this._jm = null;
    this._jmDraftId = null;
    if (this._fsListener) {
      document.removeEventListener('fullscreenchange', this._fsListener);
      this._fsListener = null;
    }
    this._hideContextMenu?.();
  },

  // Selektierten Knoten zentriert im Mindmap-Viewport zeigen.
  // jsMind hat eine eingebaute API `scroll_node_to_center(id)`, die den
  // jsmind-inner-Scroll-Container in beiden Achsen zum Zielknoten zentriert.
  // Wird bei jedem select-Event (auch Pfeiltasten) aufgerufen.
  _centerNodeInView(id) {
    if (!this._jm || !id) return;
    try {
      this._jm.scroll_node_to_center(id);
    } catch {
      // Fallback: manueller Scroll, falls API in dieser jsMind-Version fehlt.
      const inner = this.$el?.querySelector('.jsmind-inner');
      const node = inner?.querySelector(`jmnode[nodeid="${CSS.escape(id)}"]`);
      if (!inner || !node) return;
      const innerRect = inner.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      inner.scrollTo({
        left: Math.max(0, inner.scrollLeft + (nodeRect.left - innerRect.left) + nodeRect.width / 2 - innerRect.width / 2),
        top:  Math.max(0, inner.scrollTop  + (nodeRect.top  - innerRect.top)  + nodeRect.height / 2 - innerRect.height / 2),
        behavior: 'smooth',
      });
    }
  },

  _exportMindmap() {
    if (!this._jm) return null;
    try {
      const exported = this._jm.get_data('node_tree');
      // jsMind liefert { meta, format, data }; format auf 'node_tree' fixieren.
      return exported && exported.data ? exported : null;
    } catch (e) {
      return null;
    }
  },

  // Knoten-Pfad als „Wurzel > … > Knoten" — für UI-Anzeige + Brainstorm-Heading.
  knotenPfad(id) {
    if (!id || !this._jm) return '';
    const tree = this._exportMindmap()?.data;
    const walk = (node, trail) => {
      const here = [...trail, resolveTopic(node.topic)];
      if (node.id === id) return here.join(' > ');
      for (const c of node.children || []) {
        const found = walk(c, here);
        if (found) return found;
      }
      return null;
    };
    return tree ? (walk(tree, []) || '') : '';
  },

  // ── KI-Brainstorm ─────────────────────────────────────────────────────────
  async runBrainstorm() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel || !this.selectedKnotenId) return;
    // Aktuellen Mindmap-Stand zuerst speichern, sonst sieht KI alte Daten.
    await this.saveDraft();
    this.brainstormLoading = true;
    this.brainstormStatus = '';
    this.brainstormResult = null;
    try {
      const resp = await fetchJson('/jobs/werkstatt-brainstorm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id, knotenId: this.selectedKnotenId }),
      });
      this._brainstormJobId = resp.jobId;
      startPoll(this, {
        timerProp: '_brainstormPollTimer',
        jobId: resp.jobId,
        progressProp: 'brainstormProgress',
        onProgress: (job) => {
          this.brainstormStatus = runningJobStatus(app.t.bind(app),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: (job) => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this.brainstormResult = {
            knotenId: job.result.knotenId,
            knotenPfad: job.result.knotenPfad,
            vorschlaege: job.result.vorschlaege || [],
          };
        },
        onError: (job) => {
          this.brainstormLoading = false;
          this.brainstormStatus = '';
          this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
        },
        onNotFound: () => { this.brainstormLoading = false; this.brainstormStatus = ''; },
      });
    } catch (e) {
      this.brainstormLoading = false;
      this.errorMessage = app.t('werkstatt.error.brainstorm') || app.t('common.error');
    }
  },

  applyBrainstormVorschlag(idx) {
    if (!this.brainstormResult) return;
    const v = this.brainstormResult.vorschlaege[idx];
    if (!v || !this._jm) return;
    const parentId = this.brainstormResult.knotenId;
    try {
      this._jm.add_node(parentId, _newNodeId(), v.label);
    } catch (e) {
      console.error('[werkstatt] add_node failed:', e);
    }
    // Vorschlag aus Liste entfernen, damit User Apply-Status sieht.
    this.brainstormResult.vorschlaege = this.brainstormResult.vorschlaege.filter((_, i) => i !== idx);
  },

  dismissBrainstorm() {
    this.brainstormResult = null;
  },

  // ── KI-Konsistenz-Check ──────────────────────────────────────────────────
  async runConsistency() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) return;
    await this.saveDraft();
    this.consistencyLoading = true;
    this.consistencyStatus = '';
    this.consistencyResult = null;
    try {
      const resp = await fetchJson('/jobs/werkstatt-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: sel.id }),
      });
      this._consistencyJobId = resp.jobId;
      startPoll(this, {
        timerProp: '_consistencyPollTimer',
        jobId: resp.jobId,
        progressProp: 'consistencyProgress',
        onProgress: (job) => {
          this.consistencyStatus = runningJobStatus(app.t.bind(app),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: (job) => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this.consistencyResult = {
            konflikte: job.result.konflikte || [],
            fazit: job.result.fazit || '',
          };
        },
        onError: (job) => {
          this.consistencyLoading = false;
          this.consistencyStatus = '';
          this.errorMessage = app.t(job.error || 'common.error', job.errorParams || {});
        },
        onNotFound: () => { this.consistencyLoading = false; this.consistencyStatus = ''; },
      });
    } catch (e) {
      this.consistencyLoading = false;
      this.errorMessage = app.t('werkstatt.error.consistency') || app.t('common.error');
    }
  },

  dismissConsistency() {
    this.consistencyResult = null;
  },

  // Cancel: schickt DELETE /jobs/:id und räumt lokalen Loading-State auf.
  // Server setzt Job-Status auf 'cancelled', laufender callAI wird via AbortController unterbrochen.
  async cancelBrainstorm() {
    const id = this._brainstormJobId;
    if (!id) return;
    await window.__app.cancelJob(id);
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    this.brainstormLoading = false;
    this.brainstormStatus = '';
    this.brainstormProgress = 0;
    this._brainstormJobId = null;
  },
  async cancelConsistency() {
    const id = this._consistencyJobId;
    if (!id) return;
    await window.__app.cancelJob(id);
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.consistencyLoading = false;
    this.consistencyStatus = '';
    this.consistencyProgress = 0;
    this._consistencyJobId = null;
  },

  _clearJobs() {
    if (this._brainstormPollTimer) { clearInterval(this._brainstormPollTimer); this._brainstormPollTimer = null; }
    if (this._consistencyPollTimer) { clearInterval(this._consistencyPollTimer); this._consistencyPollTimer = null; }
    this.brainstormLoading = false;
    this.consistencyLoading = false;
    this.brainstormStatus = '';
    this.consistencyStatus = '';
  },

  // ── Vollbild-Modus ────────────────────────────────────────────────────────
  // Triggert Browser-Fullscreen auf den Mindmap-Section-Wrapper. Klassen-Sync
  // via fullscreenchange-Event (statt own state), damit Esc + F11 mitspielen.
  async toggleMindmapFullscreen() {
    const wrap = this.$el?.querySelector('.werkstatt-mindmap-section');
    if (!wrap) return;
    if (document.fullscreenElement === wrap) {
      try { await document.exitFullscreen(); } catch {}
      return;
    }
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch {}
    }
    try { await wrap.requestFullscreen(); } catch (e) {
      this.errorMessage = window.__app.t('werkstatt.error.fullscreen') || 'Fullscreen failed';
      return;
    }
    if (!this._fsListener) {
      this._fsListener = () => {
        const active = document.fullscreenElement === wrap;
        this.mindmapFullscreen = active;
        // Layout-Resize triggern: jsMind cached Container-Höhe.
        if (this._jm) {
          try { this._jm.resize(); } catch {}
        }
      };
      document.addEventListener('fullscreenchange', this._fsListener);
    }
  },

  // ── Rechtsklick-Menü ──────────────────────────────────────────────────────
  _onMindmapContextMenu(ev) {
    const target = ev.target.closest?.('jmnode');
    if (!target) { this._hideContextMenu(); return; }
    const nodeId = target.getAttribute('nodeid');
    if (!nodeId) return;
    ev.preventDefault();
    // Knoten selektieren (jsMind), damit selectedKnotenId für Brainstorm passt.
    try { this._jm?.select_node(nodeId); } catch {}
    this.selectedKnotenId = nodeId;
    this.contextMenuNodeId = nodeId;
    this.contextMenuPos = this._clampMenuPos(ev.clientX, ev.clientY);
    this.contextMenuOpen = true;
    if (!this._ctxOutsideHandler) {
      this._ctxOutsideHandler = (e) => {
        const menu = this.$el?.querySelector('.werkstatt-context-menu');
        if (menu && !menu.contains(e.target)) this._hideContextMenu();
      };
      document.addEventListener('mousedown', this._ctxOutsideHandler, true);
      document.addEventListener('keydown', this._ctxEscHandler = (e) => {
        if (e.key === 'Escape') this._hideContextMenu();
      });
    }
  },

  _clampMenuPos(x, y) {
    const W = 240, H = 240;
    // .card ancestor hat transform (cardFadeIn) → erzeugt Containing-Block für position:fixed.
    // clientX/Y sind viewport-relativ; daher Card-Rect-Offset abziehen.
    let dx = 0, dy = 0;
    const cb = this.$el?.closest('.card');
    if (cb) {
      const r = cb.getBoundingClientRect();
      dx = r.left; dy = r.top;
    }
    return {
      left: Math.min(window.innerWidth - W - 8, x) - dx,
      top: Math.min(window.innerHeight - H - 8, y) - dy,
    };
  },

  _hideContextMenu() {
    this.contextMenuOpen = false;
    this.contextMenuNodeId = null;
    if (this._ctxOutsideHandler) {
      document.removeEventListener('mousedown', this._ctxOutsideHandler, true);
      this._ctxOutsideHandler = null;
    }
    if (this._ctxEscHandler) {
      document.removeEventListener('keydown', this._ctxEscHandler);
      this._ctxEscHandler = null;
    }
  },

  // Context-Menu-Aktionen — operieren auf contextMenuNodeId.
  ctxRename() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id || !this._jm) return;
    try { this._jm.begin_edit(id); } catch {}
  },

  ctxAddChild() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id || !this._jm) return;
    const newId = 'n' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
    try {
      this._jm.add_node(id, newId, window.__app.t('werkstatt.tree.custom') || 'Neuer Knoten');
      this._jm.select_node(newId);
      this._jm.begin_edit(newId);
    } catch {}
  },

  ctxAddSibling() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id || !this._jm) return;
    const newId = 'n' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
    try {
      this._jm.insert_node_after(id, newId, window.__app.t('werkstatt.tree.custom') || 'Neuer Knoten');
      this._jm.select_node(newId);
      this._jm.begin_edit(newId);
    } catch {}
  },

  ctxDelete() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id || !this._jm) return;
    if (id === 'root') return;
    try { this._jm.remove_node(id); } catch {}
  },

  ctxBrainstorm() {
    this._hideContextMenu();
    this.runBrainstorm();
  },
};

export { resolveTopic, resolveMindmapForDisplay };
