// Reconnect-Outbox: synchronisiert ALLE lokal gesicherten Notebook-Entwürfe
// (editor_draft_*), nicht nur die gerade offene Seite. Der Per-Seite-Retry in
// editor/notebook/edit/autosave.js deckt ausschliesslich die aktive Edit-Seite
// ab; wer offline mehrere Seiten editiert und online zurückkommt, während
// Seite N offen ist, liesse Seite 1..N-1 sonst als Draft liegen, bis er sie
// einzeln wieder öffnet. Diese Outbox flusht sie im Hintergrund.
//
// DOM-frei: arbeitet rein aus dem persistierten Draft ({ html, originalHtml,
// originalUpdatedAt }). `originalHtml` ist der 3-Way-Merge-Ancestor, deshalb
// lässt sich ein Cross-User-Konflikt hier ohne Live-Editor block-mergen. Echte
// Block-Kollisionen bleiben als Draft liegen und werden gelöst, sobald der User
// die betroffene Seite öffnet (bestehender conflict.js-Pfad).
//
// Als Methoden-Modul in die `lektorat`-Root gespreadet (app.js) — `this` ist
// zur Laufzeit die Root-Komponente, darum greifen `this.$store`, `this.editMode`
// etc. Nur Plain-Methoden, keine Getter (Spread-Getter-Falle).
import { listDraftPageIds, readDraft, clearDraft } from '../editor/draft-storage.js';
import { savePage, isPageConflict } from '../editor/shared/page-api.js';
import { mergeBlocks, mergedToHtml } from '../editor/shared/block-merge.js';
import { contentRepo } from '../repo/content.js';
import { EVT } from '../events.js';

export const appOutboxMethods = {
  // Einmalig im Root-init() aufgerufen (mit dem AbortController-Signal). Hängt
  // die Reconnect-Trigger an und stellt den Pending-Zähler initial.
  _installOutbox(signal) {
    const flush = () => this._flushOutbox();
    window.addEventListener('online', flush, { signal });
    window.addEventListener('focus', flush, { signal });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._flushOutbox();
    }, { signal });
    // Draft-Bestand hat sich geändert (write/clear irgendwo) → Zähler neu.
    window.addEventListener(EVT.DRAFT_CHANGED, () => this._refreshPendingSyncCount(), { signal });
    // Seitenwechsel schiebt die vorher offene Seite von „live" zu „pending" —
    // Zähler neu rechnen, damit der Banner sofort stimmt.
    this.$watch(() => this.currentPage?.id, () => this._refreshPendingSyncCount());
    // Beim Boot: Zähler stellen und (falls online) direkt einmal flushen —
    // deckt „Tab offline geschlossen, online wieder geöffnet" ab.
    this._refreshPendingSyncCount();
    this._flushOutbox();
  },

  // Zählt unsynchronisierte Seiten für den Offline-Banner. Die aktuell offene
  // Edit-Seite ist „live" (wird laufend als Draft geschrieben/geleert) und zählt
  // nicht als „wartend" — sonst flackert der Zähler bei jedem Tippen.
  _refreshPendingSyncCount() {
    const openId = (this.editMode && this.currentPage?.id) ? Number(this.currentPage.id) : null;
    const count = listDraftPageIds().filter((id) => id !== openId).length;
    if (this.$store.session.pendingSyncCount !== count) {
      this.$store.session.pendingSyncCount = count;
    }
  },

  _pageNameById(pageId) {
    const p = this.$store.nav.pages.find((x) => String(x.id) === String(pageId));
    return p?.name || null;
  },

  // Flusht alle pending Drafts sequenziell. Bricht beim ersten Netzfehler ab
  // (dann sind wir wieder offline — der Rest wartet auf den nächsten Trigger).
  async _flushOutbox() {
    if (this._outboxFlushing) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const ids = listDraftPageIds();
    if (!ids.length) { this._refreshPendingSyncCount(); return; }
    this._outboxFlushing = true;
    try {
      const openId = (this.editMode && this.currentPage?.id) ? Number(this.currentPage.id) : null;
      for (const pageId of ids) {
        if (pageId === openId) continue; // aktive Edit-Seite: eigener Retry-Pfad (autosave.js)
        const status = await this._flushOneDraft(pageId);
        if (status === 'offline') break; // Netz wieder weg → Rest später
      }
    } finally {
      this._outboxFlushing = false;
      this._refreshPendingSyncCount();
    }
  },

  // Ein Draft. Rückgabe: 'ok' | 'conflict' | 'offline' | 'skip'.
  async _flushOneDraft(pageId) {
    const draft = readDraft(pageId);
    if (!draft || !draft.html) { clearDraft(pageId); return 'ok'; }
    const name = this._pageNameById(pageId);
    if (!name) return 'skip'; // Fremd-Buch/unbekannt → beim Laden des Buchs erneut
    try {
      await savePage(pageId, {
        html: draft.html, pageName: name, source: 'main',
        expectedUpdatedAt: draft.originalUpdatedAt || null,
      });
      clearDraft(pageId);
      return 'ok';
    } catch (e) {
      if (isPageConflict(e)) return this._flushMergeDraft(pageId, draft, name);
      return 'offline'; // Netzfehler → abbrechen, Draft bleibt erhalten
    }
  },

  // Cross-User-Konflikt headless auflösen: 3-Way-Block-Merge mit dem Draft-
  // Ancestor (originalHtml) gegen den frischen Remote-Stand. Nur kollisionsfreie
  // Merges werden automatisch gespeichert; echte Block-Kollisionen bleiben als
  // Draft liegen (der User löst sie beim Öffnen der Seite über conflict.js).
  async _flushMergeDraft(pageId, draft, name) {
    const base = draft.originalHtml || '';
    if (!base) return 'conflict'; // kein Ancestor → nur manuell auflösbar
    let remote;
    try { remote = await contentRepo.loadPage(pageId, { fresh: true }); }
    catch { return 'offline'; }
    if (!remote?.updated_at) return 'conflict';
    let m;
    try { m = mergeBlocks(base, draft.html, remote.html || ''); }
    catch { return 'conflict'; }
    if (m.conflicts.length) return 'conflict'; // echte Kollision → beim Öffnen lösen
    try {
      await savePage(pageId, {
        html: mergedToHtml(m.merged), pageName: name, source: 'main',
        expectedUpdatedAt: remote.updated_at,
      });
      clearDraft(pageId);
      return 'ok';
    } catch { return 'offline'; }
  },
};
