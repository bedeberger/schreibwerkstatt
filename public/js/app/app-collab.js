// Collaboration-Polling: erkennt Saves anderer User am offenen Buch und
// hinterlaesst Tree-Marker bzw. Toast. Cheap-Pfad ohne SSE/WS — eigener
// 5s-Tick, parallel zum Job-Queue-Poll. Nutzt GET /content/books/:id/changes.
//
// Reaktionen:
//   - Aktuell offene Seite, kein Edit-Mode → silent Refetch + Toast
//   - Aktuell offene Seite + editMode + dirty → kein Refetch, `editConflict`-Banner
//   - Andere Seite des Buchs → page_id in `recentRemoteEdits` (Tree-Badge);
//     bei mehreren in einem Tick: aggregierter Toast
//
// User-eigene Edits sind serverseitig ausgefiltert (last_editor_email !=
// session.email); Poller bekommt sie gar nicht erst zu sehen.

const COLLAB_POLL_MS = 5000;

export const appCollabMethods = {
  _startCollabPoll(bookId) {
    this._stopCollabPoll();
    if (!bookId) return;
    // Erster Tick holt sich den Server-Stempel als Baseline — sonst wuerden
    // historische Edits beim Buchwechsel als „neu" gemeldet.
    this._collabSince = null;
    const tick = () => this._collabPollOnce(bookId);
    tick();
    this._collabPollTimer = setInterval(tick, COLLAB_POLL_MS);
  },

  _stopCollabPoll() {
    if (this._collabPollTimer) {
      clearInterval(this._collabPollTimer);
      this._collabPollTimer = null;
    }
    this._collabSince = null;
    this.recentRemoteEdits = new Set();
    this._dismissCollabToast();
  },

  async _collabPollOnce(bookId) {
    if (document.hidden) return;
    if (!bookId || String(bookId) !== String(this.selectedBookId)) return;
    const url = '/content/books/' + bookId + '/changes'
      + (this._collabSince ? '?since=' + encodeURIComponent(this._collabSince) : '');
    let data;
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      data = await r.json();
    } catch { return; }
    if (!data) return;

    // Server-„now"-Stempel als Baseline fuer den naechsten Tick. Server-Uhr,
    // nicht Client-Uhr — Clock-Skew vermeiden.
    if (data.now) this._collabSince = data.now;

    const changes = Array.isArray(data.changes) ? data.changes : [];
    if (changes.length === 0) return;
    this._applyCollabChanges(changes);
  },

  _applyCollabChanges(changes) {
    let touchedCurrent = null;
    const others = [];
    for (const ch of changes) {
      if (!ch?.page_id) continue;
      if (this.currentPage?.id && ch.page_id === this.currentPage.id) {
        touchedCurrent = ch;
      } else {
        this.recentRemoteEdits.add(ch.page_id);
        others.push(ch);
      }
    }
    // Set-Mutation: neue Reference triggert Alpine-Reaktivitaet.
    this.recentRemoteEdits = new Set(this.recentRemoteEdits);

    if (touchedCurrent) this._onCurrentPageRemoteEdit(touchedCurrent);
    if (others.length === 1) {
      this._showCollabToast({
        user: others[0].last_editor_name || others[0].last_editor_email,
        pageName: others[0].page_name,
        pageId: others[0].page_id,
      });
    } else if (others.length > 1) {
      this._showCollabToast({ user: null, pageName: null, pageId: null, count: others.length });
    }
  },

  _onCurrentPageRemoteEdit(change) {
    const name = change.last_editor_name || change.last_editor_email;
    if (this.editMode && this.editDirty) {
      // Dirty-Editor: kein Auto-Reload — Banner setzen, naechster Save triggert
      // die optimistische DB-Concurrency-Pruefung (Phase 2).
      this.editConflict = {
        remoteUserName: name,
        remoteUpdatedAt: change.updated_at,
      };
      this.setStatus(this.t('edit.conflict.unsavedHint', {
        user: name || this.t('edit.conflict.unknownUser'),
      }), false, 8000);
      return;
    }
    // Clean-Editor oder Read-Only: frischen Stand holen + Toast.
    this._refetchCurrentPage?.().catch(() => {});
    this._showCollabToast({
      user: name,
      pageName: change.page_name,
      pageId: change.page_id,
      currentPage: true,
    });
  },

  _showCollabToast(payload) {
    this._dismissCollabToast();
    this.collabToast = payload;
    this._collabToastTimer = setTimeout(() => {
      this.collabToast = null;
      this._collabToastTimer = null;
    }, 7000);
  },

  _dismissCollabToast() {
    if (this._collabToastTimer) {
      clearTimeout(this._collabToastTimer);
      this._collabToastTimer = null;
    }
    this.collabToast = null;
  },

  // Beim Klick auf eine im Tree markierte Seite → Marker droppen.
  _clearRemoteEditMark(pageId) {
    if (!pageId || !this.recentRemoteEdits.has(pageId)) return;
    this.recentRemoteEdits.delete(pageId);
    this.recentRemoteEdits = new Set(this.recentRemoteEdits);
  },
};
