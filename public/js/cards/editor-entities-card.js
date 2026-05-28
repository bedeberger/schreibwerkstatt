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
  selectScenesForView, selectEventsForView, selectFigurenForPage,
  toEntitiesList,
} from '../editor/notebook/entities.js';

const RECOMPUTE_DEBOUNCE_MS = 250;
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
    _repositionRaf: 0,
    _recomputeTimer: null,
    _abort: null,
    _onSettingsUpdated: null,

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
      document.addEventListener('mousedown', (e) => {
        if (!this.entityPopover) return;
        if (e.target?.closest?.('.entity-popover')) return;
        this.closePopover();
      }, { capture: true, signal });

      // Edit-Input → debounced Recompute (Texte aendern Highlights).
      document.addEventListener('input', (e) => {
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

    panelScenes() {
      const app = window.__app;
      const pid = app?.currentPage?.id;
      const cid = app?.currentPage?.chapter_id;
      return selectScenesForView(app?.szenen || [], pid, cid);
    },

    panelEvents() {
      const app = window.__app;
      const pid = app?.currentPage?.id;
      const cid = app?.currentPage?.chapter_id;
      return selectEventsForView(app?.figuren || [], pid, cid);
    },

    // Figuren, deren Name auf der aktuellen Seite vorkommt. Aus dem aktuellen
    // Editor-Text bzw. dem zuletzt gerenderten Page-HTML extrahiert (gleiche
    // Match-Logik wie Highlights), damit die Liste auch ohne CSS-Highlight-API
    // korrekt ist. selectFigurenForPage ist die SSoT (pure, unit-getestet).
    panelFigures() {
      const app = window.__app;
      const figs = app?.figuren || [];
      if (!figs.length) return [];
      const root = document.querySelector(EDIT_SELECTOR)
                || document.querySelector('#editor-card .page-content-view');
      const text = root?.textContent || '';
      return selectFigurenForPage(figs, text);
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
      this.entityPopover = {
        kind: hit.kind,
        id: hit.id,
        name: hit.name,
        data: data || null,
        x, y,
      };
    },

    // Popover an der Highlight-Box ausrichten — unter dem Wort, links mit
    // etwas Inset, Viewport-Clamping. Shared zwischen Open- und Reposition-
    // Pfad, damit Initial- und Scroll-Position identisch berechnet werden.
    _computePopoverXY(rect) {
      const POPOVER_W = 320;
      const POPOVER_H_EST = 180;
      const x = Math.min(window.innerWidth - POPOVER_W - 12, Math.max(12, rect.left));
      const y = rect.bottom + POPOVER_H_EST > window.innerHeight
        ? Math.max(12, rect.top - POPOVER_H_EST - 6)
        : rect.bottom + 6;
      return { x, y };
    },

    _schedulePopoverReposition() {
      if (!this.entityPopover || !this._popoverRange) return;
      if (this._repositionRaf) return;
      this._repositionRaf = requestAnimationFrame(() => {
        this._repositionRaf = 0;
        this._repositionPopover();
      });
    },

    _repositionPopover() {
      if (!this.entityPopover || !this._popoverRange) return;
      const rects = this._popoverRange.getClientRects?.();
      if (!rects || rects.length === 0) return;
      const { x, y } = this._computePopoverXY(rects[0]);
      if (x === this.entityPopover.x && y === this.entityPopover.y) return;
      this.entityPopover = { ...this.entityPopover, x, y };
    },

    closePopover() {
      this._popoverRange = null;
      if (this._repositionRaf) { cancelAnimationFrame(this._repositionRaf); this._repositionRaf = 0; }
      this.entityPopover = null;
    },
  }));
}
