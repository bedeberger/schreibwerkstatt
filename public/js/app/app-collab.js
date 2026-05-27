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

// Buch-Level-Geraete-Ping: leicht (40s) und laeuft IMMER bei offenem Buch — auch
// fuer Einzel-Owner-Buecher. Dient nur der Multi-Device-Erkennung; der teure
// 5s-Collab-Poll (changes + presence) startet erst, wenn dieser Ping >1 eigenes
// Geraet meldet (oder das Buch ohnehin geteilt ist).
const BOOK_DEVICE_PING_MS = 40000;

// Stabile Device-ID pro Browser-Profil. localStorage ueberlebt Reloads,
// trennt Browser-Profile/Geraete sauber. Beim ersten Aufruf wird eine UUID
// generiert; spaeter wiederverwendet — selber Browser = selbes Device.
const DEVICE_ID_KEY = 'sw_device_id';
let _cachedDeviceId = null;
function _getDeviceId() {
  if (_cachedDeviceId) return _cachedDeviceId;
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : _uuidFallback();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    _cachedDeviceId = id;
    return id;
  } catch {
    // Safari Private Mode etc. — Ephemeral-UUID pro Session, kein Persist.
    if (!_cachedDeviceId) _cachedDeviceId = _uuidFallback();
    return _cachedDeviceId;
  }
}
function _uuidFallback() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export const appCollabMethods = {
  _startCollabPoll(bookId) {
    this._stopCollabPoll();
    if (!bookId) return;
    const id = String(bookId);
    // Leichter Buch-Geraete-Ping laeuft IMMER — er bootstrappt die
    // Multi-Device-Erkennung (eigenes Zweit-Geraet → voller Poll). `_loadBookRole`
    // ruft uns nach dem ACL-Read erneut auf, sobald `bookSharedFlags` gesetzt ist.
    this._startBookDevicePing(id);
    // Geteiltes Buch: voller Poll sofort, ohne auf den Geraete-Ping zu warten.
    if (this.bookSharedFlags[id] === true) this._ensureFullCollabPoll(id);
  },

  _stopCollabPoll() {
    this._stopBookDevicePing();
    this._stopFullCollabPoll();
    // Echtes Teardown (Buchwechsel/Access-Lost): auch den Editor-Heartbeat
    // abraeumen, falls ein Edit offen war.
    this._stopPresenceHeartbeat();
  },

  // Voller 5s-Collab-Poll (changes + page-presence). Startet, sobald eine zweite
  // Partei am Buch ist: anderer ACL-User ODER eigenes Zweit-Geraet. Idempotent.
  _ensureFullCollabPoll(bookId) {
    if (this._collabPollTimer) return;
    if (!bookId || String(bookId) !== String(this.selectedBookId)) return;
    // Erster Tick holt sich den Server-Stempel als Baseline — sonst wuerden
    // historische Edits beim Buchwechsel als „neu" gemeldet.
    this._collabSince = null;
    const tick = () => this._collabPollOnce(bookId);
    tick();
    this._collabPollTimer = setInterval(tick, COLLAB_POLL_MS);
  },

  // Stoppt NUR den Poll + poll-abgeleiteten State. Der Presence-Heartbeat gehoert
  // dem Editor-Lifecycle (enter/exit), nicht dem Poll — sonst verstummt ein solo
  // editierender User, sobald sein Zweit-Geraet das Buch wieder schliesst und
  // koennte ein drittes Geraet nicht mehr erreichen. Echtes Teardown
  // (`_stopCollabPoll`) raeumt den Heartbeat separat ab.
  _stopFullCollabPoll() {
    if (this._collabPollTimer) {
      clearInterval(this._collabPollTimer);
      this._collabPollTimer = null;
    }
    this._collabSince = null;
    this.recentRemoteEdits = new Set();
    this.livePresenceByPage = {};
    this.foreignEditLock = null;
    this._dismissCollabToast();
  },

  // ── Buch-Level-Geraete-Ping (Multi-Device-Erkennung) ────────────────────
  _startBookDevicePing(bookId) {
    this._stopBookDevicePing();
    if (!bookId) return;
    this._bookDevicePingBookId = String(bookId);
    const tick = () => this._sendBookDevicePing(bookId);
    tick();
    this._bookDevicePingTimer = setInterval(tick, BOOK_DEVICE_PING_MS);
  },

  _stopBookDevicePing() {
    if (this._bookDevicePingTimer) {
      clearInterval(this._bookDevicePingTimer);
      this._bookDevicePingTimer = null;
    }
    const bid = this._bookDevicePingBookId;
    this._bookDevicePingBookId = null;
    this._selfDeviceCount = 1;
    if (bid) this._sendBookDeviceLeave(bid);
  },

  async _sendBookDevicePing(bookId) {
    if (!bookId || String(bookId) !== String(this.selectedBookId)) return;
    let data;
    try {
      const r = await fetch('/content/books/' + bookId + '/device-ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: _getDeviceId() }),
      });
      if (r.status === 403) { this._handleBookAccessLost(bookId); return; }
      if (!r.ok) return;
      data = await r.json();
    } catch { return; }
    this._selfDeviceCount = Number(data?.self_device_count) || 1;
    this._reconcileFullCollabPoll(bookId);
  },

  // Voller Poll an/aus je nach erkannter Zweit-Partei. `bookSharedFlags` deckt
  // andere ACL-User ab, `_selfDeviceCount` das eigene Multi-Device.
  _reconcileFullCollabPoll(bookId) {
    if (!bookId || String(bookId) !== String(this.selectedBookId)) return;
    const id = String(bookId);
    const needFull = this.bookSharedFlags[id] === true || this._selfDeviceCount > 1;
    if (needFull) this._ensureFullCollabPoll(id);
    else this._stopFullCollabPoll();
  },

  _sendBookDeviceLeave(bookId) {
    if (!bookId) return;
    try {
      const did = _getDeviceId();
      fetch('/content/books/' + bookId + '/device-ping?device_id=' + encodeURIComponent(did), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: did }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  },

  // Buch waehrend offener Session geloescht oder Zugriff entzogen: der Poller
  // bekommt 403 NO_BOOK_ACCESS. Ohne Handler tickt der 5s-Poll endlos weiter
  // und spammt Server-Warnungen. Hier hart abbrechen: Polling + Lock-Heartbeat
  // stoppen, Buchwahl raeumen, View resetten, Buchliste neu laden (das Buch
  // verschwindet daraus). Re-Entry-Guard, weil changes+presence parallel feuern.
  _handleBookAccessLost(bookId) {
    if (!bookId || String(bookId) !== String(this.selectedBookId)) return;
    if (this._bookAccessLostFor === String(bookId)) return;
    this._bookAccessLostFor = String(bookId);
    this._stopCollabPoll();
    if (this._lockHeartbeatTimer) { clearInterval(this._lockHeartbeatTimer); this._lockHeartbeatTimer = null; }
    this._currentEditLock = null;
    this.selectedBookId = '';
    this.resetView();
    this.loadBooks?.();
    this.setStatus(this.t('collab.bookAccessLost'), false, 6000);
    this._bookAccessLostFor = null;
  },

  async _collabPollOnce(bookId) {
    if (document.hidden) return;
    if (!bookId || String(bookId) !== String(this.selectedBookId)) return;
    // Beide Reads parallel: /changes (Diff seit since) + /presence (Live-Heartbeat).
    await Promise.all([
      this._collabFetchChanges(bookId),
      this._collabFetchPresence(bookId),
    ]);
    // Stale-Cleanup fuer foreignEditLock: Wenn der gespeicherte fremde Lock
    // laut expires_at abgelaufen ist, null'en — Server-Cron purged nur 1x/Tag
    // und wir wollen das Banner nicht 24h zu lang stehen lassen.
    if (this.foreignEditLock?.expires_at) {
      const exp = Date.parse(this.foreignEditLock.expires_at);
      if (Number.isFinite(exp) && exp < Date.now()) this.foreignEditLock = null;
    }
  },

  async _collabFetchChanges(bookId) {
    const url = '/content/books/' + bookId + '/changes'
      + (this._collabSince ? '?since=' + encodeURIComponent(this._collabSince) : '');
    let data;
    try {
      const r = await fetch(url);
      if (r.status === 403) { this._handleBookAccessLost(bookId); return; }
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

  async _collabFetchPresence(bookId) {
    let data;
    try {
      const url = '/content/books/' + bookId + '/presence?device_id=' + encodeURIComponent(_getDeviceId());
      const r = await fetch(url);
      if (r.status === 403) { this._handleBookAccessLost(bookId); return; }
      if (!r.ok) return;
      data = await r.json();
    } catch { return; }
    const rows = Array.isArray(data?.presence) ? data.presence : [];
    const map = {};
    for (const p of rows) {
      if (!p?.page_id) continue;
      const key = String(p.page_id);
      if (!map[key]) map[key] = [];
      map[key].push({
        user_email: p.user_email,
        user_display_name: p.user_display_name || p.user_email,
        device_id: p.device_id,
        device_label: p.device_label || null,
        is_self: !!p.is_self,
        last_ping_at: p.last_ping_at,
      });
    }
    this.livePresenceByPage = map;
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

  // Liefert das Presence-Array fuer eine Seite. Eigene aktuelle Session ist
  // serverseitig schon ausgefiltert; eigene andere Geraete bleiben drin mit
  // `is_self: true`. [] wenn niemand.
  presenceFor(pageId) {
    if (!pageId) return [];
    return this.livePresenceByPage[String(pageId)] || [];
  },

  // ── Eigener Heartbeat ──────────────────────────────────────────────────
  // Im Edit-Mode pingt der Client alle 30s, damit andere User „X editiert
  // hier" sehen. Verlassen via DELETE bei cancel/save. Page-Wechsel waehrend
  // Edit ist nicht moeglich (Editor zerstoert sich), aber zur Sicherheit
  // hardcoded: bei pageId-Wechsel wird der alte Ping abgemeldet.
  _startPresenceHeartbeat(pageId) {
    if (!pageId) return;
    // Laeuft immer im Edit-Mode (billiger 30s-POST, nur waehrend aktivem Edit) —
    // so liegt die page_presence-Row sofort vor, wenn ein Zweit-Geraet das Buch
    // oeffnet und seinen vollen Poll startet. Gegated ist nur der teure 5s-Poll,
    // nicht dieser Heartbeat.
    if (this._presencePingPageId && this._presencePingPageId !== pageId) {
      this._sendPresenceLeave(this._presencePingPageId);
    }
    this._presencePingPageId = pageId;
    this._sendPresencePing(pageId);
    if (this._presencePingTimer) clearInterval(this._presencePingTimer);
    this._presencePingTimer = setInterval(() => {
      if (this._presencePingPageId) this._sendPresencePing(this._presencePingPageId);
    }, 30 * 1000);
  },

  _stopPresenceHeartbeat() {
    if (this._presencePingTimer) {
      clearInterval(this._presencePingTimer);
      this._presencePingTimer = null;
    }
    const pid = this._presencePingPageId;
    this._presencePingPageId = null;
    if (pid) this._sendPresenceLeave(pid);
  },

  _sendPresencePing(pageId) {
    if (!pageId) return;
    try {
      fetch('/content/pages/' + pageId + '/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: _getDeviceId() }),
      }).catch(() => {});
    } catch {}
  },

  _sendPresenceLeave(pageId) {
    if (!pageId) return;
    try {
      // device_id auch als Query-Param: keepalive/sendBeacon koennen Body
      // verschlucken; Server akzeptiert beide.
      const did = _getDeviceId();
      fetch('/content/pages/' + pageId + '/presence?device_id=' + encodeURIComponent(did), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: did }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  },

  // ── Soft-Edit-Lock ────────────────────────────────────────────────────
  // Beim Editor-Start: POST /books/pages/:id/lock mit reason='edit'. Heartbeat
  // alle 5 Minuten (TTL 30min serverseitig). Bei 423 (fremder lektorat-Lock)
  // verweigern wir den Edit gar nicht — der PUT haengt sich daran nicht auf,
  // weil getBlockingLockFor nur 'lektorat' meldet (Phase 2 OCC reicht).
  // Fremder 'edit'-Lock landet als foreignEditLock im Banner.
  async _acquireEditLock(pageId) {
    if (!pageId) return null;
    try {
      const r = await fetch('/books/pages/' + pageId + '/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'edit' }),
      });
      if (r.status === 423) {
        const body = await r.json().catch(() => ({}));
        this.foreignEditLock = {
          user_email: body.locked_by_email || null,
          user_display_name: this.userDisplayName?.(body.locked_by_email) || body.locked_by_email,
          expires_at: body.expires_at || null,
          reason: body.reason || 'lektorat',
        };
        return null;
      }
      if (!r.ok) return null;
      const data = await r.json();
      this._currentEditLock = data?.lock || null;
      this.foreignEditLock = null;
      this._startLockHeartbeat(pageId);
      return this._currentEditLock;
    } catch { return null; }
  },

  _startLockHeartbeat(pageId) {
    if (this._lockHeartbeatTimer) clearInterval(this._lockHeartbeatTimer);
    // 5min-Tick — Server-TTL ist 30min, doppelt-sicher gegen verlorene Pings.
    this._lockHeartbeatTimer = setInterval(() => {
      if (!this._currentEditLock || !pageId) return;
      this._sendLockHeartbeat(pageId);
    }, 5 * 60 * 1000);
  },

  async _sendLockHeartbeat(pageId) {
    try {
      const r = await fetch('/books/pages/' + pageId + '/lock/heartbeat', { method: 'POST' });
      if (r.status === 423) {
        // Anderer User hat in der Zwischenzeit (Hard-Pfad: 'lektorat') uebernommen.
        const body = await r.json().catch(() => ({}));
        this.foreignEditLock = {
          user_email: body.locked_by_email || null,
          user_display_name: this.userDisplayName?.(body.locked_by_email) || body.locked_by_email,
          expires_at: body.expires_at || null,
          reason: body.reason || 'lektorat',
        };
        this._currentEditLock = null;
        if (this._lockHeartbeatTimer) clearInterval(this._lockHeartbeatTimer);
        this._lockHeartbeatTimer = null;
        return;
      }
      if (!r.ok) return;
      const data = await r.json();
      this._currentEditLock = data?.lock || this._currentEditLock;
    } catch {}
  },

  _releaseEditLock(pageId) {
    if (this._lockHeartbeatTimer) {
      clearInterval(this._lockHeartbeatTimer);
      this._lockHeartbeatTimer = null;
    }
    this._currentEditLock = null;
    if (!pageId) return;
    try {
      fetch('/books/pages/' + pageId + '/lock', { method: 'DELETE' }).catch(() => {});
    } catch {}
  },

  // Best-Effort-Release beim Tab-Close. `navigator.sendBeacon` ist der einzige
  // verlaessliche Pfad waehrend `beforeunload`/`pagehide` — normales fetch wird
  // vom Browser oft gekillt. POST mit JSON-Body, sendBeacon kann das.
  _beaconReleaseEditLock(pageId) {
    if (!pageId || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
    try {
      const blob = new Blob([JSON.stringify({ method: 'DELETE' })], { type: 'application/json' });
      // Server hat keinen sendBeacon-Endpoint mit DELETE-Semantik — Workaround:
      // Wir nutzen fetch mit keepalive:true (Fallback) bzw. sendBeacon mit POST
      // auf einen kuenstlichen Release-Marker. Pragmatischer: fetch mit keepalive.
      fetch('/books/pages/' + pageId + '/lock', { method: 'DELETE', keepalive: true }).catch(() => {});
    } catch {}
  },
};
