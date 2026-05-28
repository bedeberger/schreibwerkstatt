// editorEntitiesCard — Entity-Linking-Sub-Komponente (Notebook-Editor):
//   - Inline-Highlights (Figuren, Orte) im contenteditable.
//   - „Auf dieser Seite"-Collapsible ueber dem Editor-Body mit drei Reihen
//     (Figuren / Szenen / Ereignisse). Pattern wie .figure-context-panel.
//   - Popover (teleport) bei Klick auf ein Highlight.
//
// Lifecycle:
//   - Aktivierung gesteuert ueber Root-Flag `entitiesEnabledForCurrentBook`
//     (Spiegel von book_settings.entities_enabled). Toggle in der Notebook-
//     Toolbar; persistiert via PUT /booksettings/:id/entities-enabled.
//   - Highlight-Recompute: bei editMode-Wechsel, currentPage-Wechsel, nach
//     Edit-Input (debounce), nach book:settings:updated, nach Figuren/Orte-
//     Reload.
//   - Cleanup: clearHighlights() bei Toggle-Off, Edit-Exit, Page-Exit,
//     Buchwechsel.
//
// State-Quellen: figuren/orte/szenen kommen vom Catalog-Store (root proxy);
// Ereignisse aus `figuren[].lebensereignisse` (siehe entities.js#selectEventsForView).

import {
  applyHighlights, clearHighlights, findHighlightAtPoint,
  selectScenesForView, selectEventsForView,
  toEntitiesList,
} from '../editor/notebook/entities.js';

const RECOMPUTE_DEBOUNCE_MS = 400;
const EDIT_SELECTOR = '#editor-card .page-content-view--editing';

export function registerEditorEntitiesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorEntitiesCard', () => ({
    // Popover-State (teleport): null = zu; sonst { entity, kind, x, y, name }.
    entityPopover: null,
    // Letzte berechnete Highlight-Ranges (kind, id, name, range) — Hit-Test-
    // Quelle fuer Klicks. Wird in `_recompute` neu gesetzt.
    _highlights: [],
    // Aktuelle Anchor-Range fuer den offenen Popover (nicht reaktiv —
    // Range-Objekte mag Alpines Proxy nicht). Wird beim Scroll/Resize neu
    // vermessen, damit der Popover mit dem Highlight mitwandert.
    _popoverRange: null,
    // Anker-Element fuer Chip-Popovers (Kontext-Leiste). Wenn die Page
    // scrollt, hat das Chip keinen Range — wir messen direkt am DOM-Element
    // neu, damit der Popover am Chip kleben bleibt.
    _popoverAnchor: null,
    _repositionRaf: 0,
    _recomputeTimer: null,
    _abort: null,
    _onSettingsUpdated: null,
    // Memo-Cache fuer panelScenes/panelEvents. Alpine ruft die Getter mehrfach
    // pro Render auf; ohne Cache laeuft filter+sort jedes Mal neu. Key =
    // pageId|chapterId|sourceLen — Quellen-Wechsel invalidiert implizit.
    _scenesKey: null,
    _scenesVal: { onPage: [], inChapter: [] },
    _eventsKey: null,
    _eventsVal: { onPage: [], inChapter: [] },

    init() {
      const abort = new AbortController();
      this._abort = abort;
      const signal = abort.signal;

      // Highlight neu rechnen wenn relevanter State sich aendert.
      const recompute = () => this._scheduleRecompute();
      this.$watch(() => window.__app?.entitiesEnabledForCurrentBook, (on) => {
        if (!on) {
          clearHighlights();
          this.closePopover();
        } else {
          recompute();
        }
      });
      // Buch-Wechsel: Szenen fuer neues Buch nachladen (Kontext-Panel zeigt
      // Szenen/Ereignisse unabhaengig vom Entity-Toggle, also auch hier laden).
      this.$watch(() => window.__app?.selectedBookId, () => {
        this._ensureSzenenLoaded();
      });
      this.$watch(() => window.__app?.currentPage?.id, () => {
        clearHighlights();
        this.closePopover();
        recompute();
      });
      this.$watch(() => window.__app?.editMode, () => {
        clearHighlights();
        recompute();
      });
      this.$watch(() => (window.__app?.figuren || []).length, recompute);
      this.$watch(() => (window.__app?.orte || []).length, recompute);

      // Wenn BookSettings die Flag aendert oder ein anderes Geraet sie
      // updatet, refetcht der Root die Setting — wir reagieren auf Recompute.
      this._onSettingsUpdated = (ev) => {
        const id = ev?.detail?.bookId;
        if (id && String(id) !== String(window.__app?.selectedBookId)) return;
        recompute();
      };
      window.addEventListener('book:settings:updated', this._onSettingsUpdated, { signal });

      // Klick im Edit-Container — wenn auf eine highlighted Range, Popover.
      // Da CSS Custom Highlights kein eigenes Pointer-Target sind, koennen
      // wir nicht direkt auf das Highlight klicken; stattdessen pruefen wir
      // bei jedem Klick im Editor, ob das angeklickte Wort einem Entity-Name
      // entspricht.
      document.addEventListener('click', (e) => {
        const app = window.__app;
        if (!app?.entitiesEnabledForCurrentBook) return;
        const editEl = e.target?.closest?.(EDIT_SELECTOR + ', #editor-card .page-content-view');
        if (!editEl) return;
        this._maybeOpenPopoverFromClick(e);
      }, { signal });

      // Outside-Close auf mousedown statt click. Why: der LT-Spellcheck-
      // Controller stoppt das click-Event in der capture-Phase auf .page-content-
      // view--editing, damit Links unter Squiggles nicht gefolgt werden. Dadurch
      // erreicht der Click document nie und Alpine's `@click.outside` feuert
      // nicht — Entity-Popover bleibt offen und ueberdeckt das LT-Popover.
      // Mousedown auf document/capture laeuft vor jedem Root-Listener, schliesst
      // sauber bevor LT sein Popover oeffnet.
      // Ausnahme: Chip-zu-Chip-Wechsel. Mousedown auf einem anderen Chip wuerde
      // den Popover schliessen und der nachfolgende Click ihn neu oeffnen —
      // sichtbares Flackern. Wir lassen Chip-Targets durch, der Chip-Click
      // ueberschreibt den State ohnehin.
      document.addEventListener('mousedown', (e) => {
        if (!this.entityPopover) return;
        if (e.target?.closest?.('.entity-popover')) return;
        if (e.target?.closest?.('.figure-context-chip')) return;
        this.closePopover();
      }, { capture: true, signal });

      // Edit-Input → debounced Recompute (Texte aendern Highlights).
      // Early-Out: bei deaktiviertem Buch keinen Timer schedulen — spart bei
      // 20k-Zeichen-Seiten jeden Tipp-Tick einen setTimeout.
      document.addEventListener('input', (e) => {
        if (!window.__app?.entitiesEnabledForCurrentBook) return;
        if (!e.target?.closest?.(EDIT_SELECTOR)) return;
        this._scheduleRecompute();
      }, { signal });

      // Popover anker-treu halten: capture-Phase faengt Scrolls auf jedem
      // Vorfahren (Window, Editor-Container, Card-Body) — egal wo das Layout
      // wirklich scrollt, wir richten am Live-Range-Rect neu aus.
      const onScroll = () => this._schedulePopoverReposition();
      window.addEventListener('scroll', onScroll, { capture: true, passive: true, signal });
      window.addEventListener('resize', onScroll, { signal });

      // Initial-Trigger nach Mount. Szenen werden immer geladen — das Kontext-
      // Panel zeigt sie unabhaengig vom Entity-Toggle.
      this.$nextTick(() => {
        this._ensureSzenenLoaded();
        recompute();
      });
    },

    // Stellt sicher, dass `app.szenen` fuer das aktuelle Buch geladen ist.
    // Andere Trigger (Szenen-/Orte-Karte, Komplettanalyse, Palette) laden
    // bei Bedarf; das Entity-Panel ist eigener Konsument und muss selber dafuer
    // sorgen, sonst bleibt die Szenen-Sektion permanent leer.
    _ensureSzenenLoaded() {
      const app = window.__app;
      const bookId = app?.selectedBookId;
      if (!bookId) return;
      if (Array.isArray(app.szenen) && app.szenen.length > 0) return;
      const tag = bookId + ':' + (app?.session?.email || '');
      if (this._szenenLoadTag === tag) return;
      this._szenenLoadTag = tag;
      Promise.resolve(app.loadSzenen?.(bookId)).catch(() => {
        this._szenenLoadTag = null;
      });
    },

    destroy() {
      if (this._recomputeTimer) { clearTimeout(this._recomputeTimer); this._recomputeTimer = null; }
      if (this._repositionRaf) { cancelAnimationFrame(this._repositionRaf); this._repositionRaf = 0; }
      this._popoverRange = null;
      this._popoverAnchor = null;
      this._abort?.abort();
      clearHighlights();
    },

    _scheduleRecompute() {
      if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
      this._recomputeTimer = setTimeout(() => {
        this._recomputeTimer = null;
        this._recompute();
      }, RECOMPUTE_DEBOUNCE_MS);
    },

    _recompute() {
      const app = window.__app;
      if (!app?.entitiesEnabledForCurrentBook) {
        clearHighlights();
        this._highlights = [];
        return;
      }
      const root = document.querySelector(EDIT_SELECTOR)
                || document.querySelector('#editor-card .page-content-view');
      if (!root) { clearHighlights(); this._highlights = []; return; }
      const entities = toEntitiesList(app.figuren, app.orte);
      this._highlights = applyHighlights(root, entities);
    },

    // ── Panel-Daten ─────────────────────────────────────────────────────────
    //
    // Alpine ruft Getter im Panel-Template mehrfach pro Render (x-show, x-if,
    // x-for je 1×) — bei 20k-Zeichen-Seiten + viel Buchmaterial summiert sich
    // das. Memoization auf (page, szenen/figuren-laenge) eliminiert die
    // wiederholten filter+sort-Sweeps; gecacht wird das Resultat-Objekt, das
    // x-for direkt iteriert. Reset implizit beim Wechsel der Quellen.

    panelScenes() {
      const app = window.__app;
      const pid = app?.currentPage?.id;
      const cid = app?.currentPage?.chapter_id;
      const len = (app?.szenen || []).length;
      const key = pid + '|' + cid + '|' + len;
      if (this._scenesKey !== key) {
        this._scenesKey = key;
        this._scenesVal = selectScenesForView(app?.szenen || [], pid, cid);
      }
      return this._scenesVal;
    },

    panelEvents() {
      const app = window.__app;
      const pid = app?.currentPage?.id;
      const cid = app?.currentPage?.chapter_id;
      const len = (app?.figuren || []).length;
      const key = pid + '|' + cid + '|' + len;
      if (this._eventsKey !== key) {
        this._eventsKey = key;
        this._eventsVal = selectEventsForView(app?.figuren || [], pid, cid);
      }
      return this._eventsVal;
    },

    panelEmpty() {
      const s = this.panelScenes();
      const e = this.panelEvents();
      return s.onPage.length === 0 && s.inChapter.length === 0
        && e.onPage.length === 0 && e.inChapter.length === 0;
    },

    extractionEmpty() {
      const app = window.__app;
      const f = (app?.figuren || []).length;
      const o = (app?.orte || []).length;
      const s = (app?.szenen || []).length;
      const e = (app?.figuren || []).reduce((n, x) => n + (Array.isArray(x?.lebensereignisse) ? x.lebensereignisse.length : 0), 0);
      return f === 0 && o === 0 && s === 0 && e === 0;
    },

    // ── Navigation ──────────────────────────────────────────────────────────

    // Oeffnet das gemeinsame Entity-Popover fuer einen Chip in der Kontext-
    // Leiste. Identischer State-Sink (`entityPopover`) wie der Klick auf ein
    // Highlight im Editor — eine Popover-Implementierung fuer beide Trigger.
    // `kind` ∈ {'figure','location','scene','event'}, `data` das Quell-Objekt,
    // `displayName` der sichtbare Name, `ev` das urspruengliche Click-Event
    // (currentTarget = Chip-Element zum Positionieren via getBoundingClientRect).
    openPopoverForChip(kind, data, displayName, ev) {
      if (!data || !ev?.currentTarget) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = ev.currentTarget.getBoundingClientRect();
      const { x, y } = this._computePopoverXY(rect);
      this._popoverRange = null;
      this._popoverAnchor = ev.currentTarget;
      this.entityPopover = {
        kind,
        id: data.id ?? data.figure_id ?? null,
        name: displayName || data.name || data.titel || data.ereignis || '',
        data,
        x, y,
      };
    },

    openFigure(id) {
      const app = window.__app;
      this.closePopover();
      if (!app?.openFigurById) return;
      app.openFigurById(id);
    },

    openLocation(id) {
      const app = window.__app;
      this.closePopover();
      if (!app?.openOrtById) return;
      app.openOrtById(id);
    },

    openScene(id) {
      const app = window.__app;
      if (app?.openSzeneById) app.openSzeneById(id);
    },

    openEvent(figureId) {
      const app = window.__app;
      if (app?.openFigurById) app.openFigurById(figureId);
    },

    // ── Popover ─────────────────────────────────────────────────────────────

    // Hit-Test ueber die DOM-Ranges, die `applyHighlights` zurueckgeliefert hat.
    // CSS Custom Highlights selbst sind nicht pointer-event-faehig — wir
    // iterieren die gespeicherten Ranges und matchen gegen die Klick-Koordinate.
    _maybeOpenPopoverFromClick(ev) {
      const app = window.__app;
      if (!this._highlights?.length) return;
      const found = findHighlightAtPoint(this._highlights, ev.clientX, ev.clientY);
      if (!found) return;
      const { hit, rect } = found;
      ev.preventDefault();
      const data = hit.kind === 'figure'
        ? (app.figuren || []).find(f => f.id === hit.id)
        : (app.orte    || []).find(o => o.id === hit.id);
      const { x, y } = this._computePopoverXY(rect);
      this._popoverRange = hit.range || null;
      this._popoverAnchor = null;
      this.entityPopover = {
        kind: hit.kind,
        id: hit.id,
        name: hit.name,
        data: data || null,
        x, y,
      };
    },

    // Popover an der Highlight-Box ausrichten — unter dem Wort, links mit
    // etwas Inset, Viewport-Clamping. Shared zwischen Open- und Scroll-
    // Reposition-Pfad, damit Initial- und Scroll-Position identisch sind.
    // Mobile (<= 480px): Popover spannt sich via CSS auf volle Breite (left+
    // right: 12px) — JS setzt nur x = 12, damit Inline-`left` mit dem CSS-
    // `right` zusammen die Breite berechnen kann. Aeusserer Math.max(12, …)
    // verhindert ausserdem x < 0 auf sehr schmalen Viewports zwischen 481px
    // und ca. 350px, wo windowInnerWidth - POPOVER_W - 12 negativ werden kann.
    _computePopoverXY(rect) {
      const POPOVER_W = 320;
      const POPOVER_H_EST = 180;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const x = vw <= 480
        ? 12
        : Math.max(12, Math.min(vw - POPOVER_W - 12, Math.max(12, rect.left)));
      const y = rect.bottom + POPOVER_H_EST > vh
        ? Math.max(12, rect.top - POPOVER_H_EST - 6)
        : rect.bottom + 6;
      return { x, y };
    },

    _schedulePopoverReposition() {
      if (!this.entityPopover) return;
      if (!this._popoverRange && !this._popoverAnchor) return;
      if (this._repositionRaf) return;
      this._repositionRaf = requestAnimationFrame(() => {
        this._repositionRaf = 0;
        this._repositionPopover();
      });
    },

    // Anker-Rect ermitteln: Range hat Prioritaet (Inline-Highlight), sonst
    // das DOM-Element (Chip in der Kontext-Leiste). Beides liefert ein
    // viewport-relatives Rect, das `_computePopoverXY` direkt verwertet.
    _currentAnchorRect() {
      if (this._popoverRange) {
        const rects = this._popoverRange.getClientRects?.();
        if (rects && rects.length > 0) return rects[0];
      }
      if (this._popoverAnchor?.isConnected) {
        return this._popoverAnchor.getBoundingClientRect();
      }
      return null;
    },

    _repositionPopover() {
      if (!this.entityPopover) return;
      const rect = this._currentAnchorRect();
      if (!rect) return;
      // Anker vollstaendig ausserhalb des Viewports → Popover hat keinen
      // sichtbaren Bezugspunkt mehr. Schliessen statt am Rand kleben lassen.
      if (rect.bottom < 0 || rect.top > window.innerHeight
          || rect.right < 0 || rect.left > window.innerWidth) {
        this.closePopover();
        return;
      }
      const { x, y } = this._computePopoverXY(rect);
      if (x === this.entityPopover.x && y === this.entityPopover.y) return;
      this.entityPopover = { ...this.entityPopover, x, y };
    },

    closePopover() {
      this._popoverRange = null;
      this._popoverAnchor = null;
      if (this._repositionRaf) { cancelAnimationFrame(this._repositionRaf); this._repositionRaf = 0; }
      this.entityPopover = null;
    },
  }));
}
