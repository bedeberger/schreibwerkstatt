// Alpine.data('ereignisseCard') — Sub-Komponente der Zeitstrahl-Karte.
//
// Eigener State: Meta-Flags (Loading/Status/Progress/PollTimer) + UI-Helper.
// Root behält:
//   - `globalZeitstrahl` (im Store, via $root-Getter auch am Root sichtbar)
//   - `ereignisseFilters` (app-navigation.js schreibt darauf)
//   - `_buildGlobalZeitstrahl` (wird aus figuren.js / loadFiguren gerufen)
//   - `_reloadZeitstrahl` (wird aus app-komplett.js gerufen)
import { setupCardLifecycle } from './card-lifecycle.js';
import { memoizeByIdentity, escHtml } from '../utils.js';
import { loadVisTimeline } from '../lazy-libs.js';
import { toggleWrapFullscreen, attachFullscreenSync } from '../fullscreen.js';

// Auto-Höhe der vis-timeline ist auf diesen Wert gedeckelt; im Vollbild füllt
// sie stattdessen die Resthöhe (height:'100%').
const TIMELINE_MAX_HEIGHT = 420;

// Pure Filter-Logik. Aus dem memoized Wrapper extrahiert, damit sie ohne
// Alpine-Root testbar ist (siehe tests/unit/ereignisse-card-filter.test.mjs).
export function applyEreignisseFilters(events, { suche = '', figurId = '', subtyp = '', kapitel = '', seite = '' } = {}) {
  let result = events || [];
  if (suche) {
    const q = suche.toLowerCase();
    result = result.filter(ev => (ev.ereignis || '').toLowerCase().includes(q));
  }
  if (figurId) result = result.filter(ev => (ev.figuren || []).some(f => f.id === figurId));
  if (subtyp) result = result.filter(ev => (ev.subtyp || 'sonstiges') === subtyp);
  if (kapitel) {
    result = result.filter(ev => {
      const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
      return kap.includes(kapitel);
    });
  }
  if (seite && kapitel) {
    result = result.filter(ev => {
      const seiten = Array.isArray(ev.seiten) ? ev.seiten : (ev.seite ? [ev.seite] : []);
      return seiten.includes(seite);
    });
  }
  return result;
}

const _memoEreignisse = () => memoizeByIdentity(([events, suche, figurId, kapitel, seite, subtyp]) =>
  applyEreignisseFilters(events, { suche, figurId, kapitel, seite, subtyp })
);

// Baut ein Date aus den strukturierten Jahr/Monat/Tag-Feldern. setFullYear
// (statt new Date(year,…)) vermeidet das 0–99-Jahr-Mapping auf 1900+year und
// trägt damit auch historische/frühe Jahre korrekt.
function _eventDate(year, month, day) {
  const d = new Date(0);
  d.setFullYear(year, month ? month - 1 : 0, day || 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Pure: übersetzt die (gefilterte) Event-Liste in vis-timeline-Items. Nur
// datierte Events (datum_year gesetzt) landen auf der Achse — story_tag/undatiert
// bleiben nur in der Liste. id = Listen-Index (Brücke zu [data-ev-index] für
// Klick→Scroll). Spannen (datum_ende_year) werden zu Range-Items. subtyp trägt
// die Farbcodierung der Liste auf die Achse. Extrahiert für Tests (siehe
// ereignisse-card-filter.test.mjs).
export function buildTimelineItems(events) {
  const items = [];
  (events || []).forEach((ev, i) => {
    if (ev.datum_year == null) return;
    const start = _eventDate(ev.datum_year, ev.datum_month, ev.datum_day);
    const item = {
      id: i,
      start,
      extern: ev.typ === 'extern',
      subtyp: ev.subtyp || 'sonstiges',
      content: ev.ereignis || '',
    };
    if (ev.datum_ende_year != null && !POINT_SUBTYPES.has(item.subtyp)) {
      const end = _eventDate(ev.datum_ende_year, ev.datum_ende_month, ev.datum_ende_day);
      if (end > start) { item.end = end; item.type = 'range'; }
      else item.type = 'point';
    } else {
      item.type = 'point';
    }
    items.push(item);
  });
  return items;
}

// Pure: früheste Start- und späteste End-/Start-Zeit (ms) der datierten
// Timeline-Items. Basis für die Sprung-Buttons (moveTo). null bei leerer Liste.
// Extrahiert für Tests (ereignisse-card-filter.test.mjs).
export function timelineBounds(items) {
  const list = items || [];
  let min = Infinity, max = -Infinity;
  for (const it of list) {
    const s = +new Date(it.start);
    const e = it.end != null ? +new Date(it.end) : s;
    if (s < min) min = s;
    if (e > max) max = e;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

// Mapping Subtyp → Lucide-Sprite-Icon-ID. Whitelist deckungsgleich mit
// prompts/komplett.js + i18n events.subtyp.*. Unbekannte/ungültige Subtypen
// fallen auf 'sonstiges' → more-horizontal.
const SUBTYP_ICON = {
  geburt:            'baby',
  tod:               'skull',
  hochzeit:          'heart',
  liebe:             'heart-handshake',
  trennung:          'heart-off',
  krankheit:         'activity',
  reise:             'plane',
  umzug:             'truck',
  konflikt:          'swords',
  wendepunkt:        'git-fork',
  entdeckung:        'compass',
  verlust:           'heart-crack',
  sieg:              'trophy',
  extern_politisch:  'landmark',
  extern_wirtschaftlich: 'banknote',
  extern_natur:      'mountain',
  extern_kulturell:  'book-open',
  extern_krieg:      'bomb',
  sonstiges:         'more-horizontal',
};
export function subtypIcon(subtyp) {
  return SUBTYP_ICON[subtyp] || SUBTYP_ICON.sonstiges;
}

// Instantane Subtypen (Momente, kein Zeitraum): bekommen nie einen Span-Balken,
// auch wenn die Daten ein Ende-Jahr tragen (z.B. Geburt mit Ende = „Jetzt" der
// Geschichte → sonst 50-Jahre-Spanne statt Punkt). Dauer-fähige Subtypen
// (liebe, krankheit, reise, umzug, konflikt, extern_*) bleiben Spannen.
export const POINT_SUBTYPES = new Set([
  'geburt', 'tod', 'hochzeit', 'trennung',
  'wendepunkt', 'entdeckung', 'sieg', 'verlust',
]);

// Formatiert das Anzeige-Datum aus den strukturierten Feldern. Punkt-Events
// und Spannen werden unterschiedlich gerendert. Fallback auf datum_label
// (Original-String) oder die i18n-Variante für "unbekannt".
function _formatEventDate(ev, t) {
  const yPart = (y, m, d) => {
    if (y == null && m == null && d == null) return null;
    const parts = [];
    if (d != null) parts.push(String(d).padStart(2, '0') + '.');
    if (m != null) parts.push(String(m).padStart(2, '0') + '.');
    if (y != null) parts.push(String(y));
    return parts.join(d != null && m != null ? '' : ' ').trim();
  };
  const start = yPart(ev.datum_year, ev.datum_month, ev.datum_day);
  const ende  = yPart(ev.datum_ende_year, ev.datum_ende_month, ev.datum_ende_day);
  // Aus dem Kontext abgeleitetes (unsicheres) Datum → «ca.»-Prefix; nur relevant
  // wenn ein Jahr vorliegt (Story-Tags/Labels bleiben unverändert).
  const circa = (d) => ev.datum_unsicher ? t('events.circa', { date: d }) : d;
  if (ende && start) return circa(t('events.span', { start, ende }));
  if (start) return circa(start);
  if (ev.story_tag != null) return String(ev.story_tag);
  if (ev.datum_label) return ev.datum_label;
  return t('events.unknownDate');
}

export function registerEreignisseCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ereignisseCard', () => ({
    ereignisseLoading: false,
    ereignisseProgress: 0,
    ereignisseStatus: '',
    zeitstrahlConsolidating: false,
    zeitstrahlProgress: 0,
    zeitstrahlStatus: '',
    _consolidatePollTimer: null,
    _ereignisseExtractPollTimer: null,
    _lifecycle: null,
    // Gebundener visibilitychange-Handler (Tab-Rückwechsel → Timeline-redraw),
    // in init() registriert und in destroy() abgeräumt.
    _onVisibility: null,
    _memoFiltered: _memoEreignisse(),
    // vis-timeline-Instanz + Item-DataSet (lazy beim ersten Sichtbarwerden).
    _timeline: null,
    _timelineItems: null,
    // Buch-ID, für die zuletzt ein fit() (Voll-Zoom) lief. Filteränderungen
    // dürfen den User-Zoom NICHT zurücksetzen — fit() nur bei Buchwechsel.
    _lastFitBookId: null,
    // Re-Entry-Guards: _renderTimeline ist async (await loadVisTimeline) und kann
    // von zwei Watches quasi-gleichzeitig getriggert werden → sonst Doppel-Mount.
    _timelineRendering: false,
    _timelineRerun: false,
    // Wieviele datierte Items zuletzt auf der Achse landeten (Hinweis-Text).
    timelineItemCount: 0,
    // Vollbild-Flag (CSS-Overlay-Fallback; native :fullscreen läuft parallel).
    timelineFullscreen: false,
    // Erst true, wenn vis sein erstes Layout (inkl. fit) fertig gemalt hat —
    // bis dahin Spinner statt der zusammengequetschten Roh-Achse zeigen.
    timelineReady: false,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'ereignisse',
        showFlag: 'showEreignisseCard',
        timerKeys: ['_consolidatePollTimer', '_ereignisseExtractPollTimer'],
        resetState: {
          ereignisseLoading: false,
          ereignisseProgress: 0,
          ereignisseStatus: '',
          zeitstrahlConsolidating: false,
          zeitstrahlProgress: 0,
          zeitstrahlStatus: '',
          timelineReady: false,
        },
        load: (root) => root._reloadZeitstrahl(),
        refreshNeedsBookId: false,
      });
      // Timeline (neu) rendern, sobald sich die gefilterte Liste ändert oder
      // die Karte sichtbar wird (vis braucht ein sichtbares Container-Element
      // mit Dimensionen — bei display:none misst es 0).
      this.$watch(() => this.filteredEreignisse(), () => this._renderTimeline());
      this.$watch(() => window.__app.showEreignisseCard, (v) => { if (v) this._renderTimeline(); });
      this.$nextTick(() => this._renderTimeline());
      // Tab-Rückwechsel: vis misst Dimensionen träge, wenn der Tab beim letzten
      // Layout im Hintergrund war. Ein redraw() bei Wiedersichtbarkeit räumt
      // ein evtl. kollabiertes/verschobenes Achsen-Layout auf.
      this._onVisibility = () => {
        if (document.visibilityState === 'visible' && window.__app?.showEreignisseCard) {
          this._timeline?.redraw();
        }
      };
      document.addEventListener('visibilitychange', this._onVisibility);
      // Native Fullscreen-API: State spiegeln + vis-Höhe anpassen; beim Verlassen
      // (Esc / Browser-UI) das Toggle-Flag sauber zurücksetzen.
      attachFullscreenSync({
        resolveWrap: () => this.$el?.querySelector('.gz-timeline-wrap'),
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.timelineFullscreen = active;
          this._applyTimelineFullscreenSize(active);
        },
      });
    },

    destroy() {
      // Falls die Karte im Vollbild abgebaut wird (Buchwechsel etc.): erst raus.
      if (document.fullscreenElement?.classList?.contains?.('gz-timeline-wrap')) {
        try { document.exitFullscreen?.(); } catch {}
      }
      if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = null;
      this._cancelTimelineReveal();
      this._timeline?.destroy();
      this._timeline = null;
      this._timelineItems = null;
      this._lifecycle?.destroy();
    },

    // UI-Helper. Lesen $root-Filter + -Daten.
    ereignisseKapitelListe() {
      return window.__app._deriveKapitel(window.__app.globalZeitstrahl, ev => ev.kapitel);
    },

    ereignisseSeitenListe() {
      return window.__app._deriveSeiten(
        window.__app.globalZeitstrahl,
        window.__app.ereignisseFilters.kapitel,
        ev => ev.kapitel,
        ev => Array.isArray(ev.seiten) ? ev.seiten : ev.seite,
      );
    },

    // Liste sichtbarer Subtypen im aktuellen Buch — Filter zeigt nur was vorkommt.
    ereignisseSubtypListe() {
      const seen = new Set();
      for (const ev of (window.__app.globalZeitstrahl || [])) {
        seen.add(ev.subtyp || 'sonstiges');
      }
      return [...seen].sort();
    },

    // Klick-Helper: bei mehreren Kapiteln wäre `gotoStelle(kap[0], …)` falsch.
    // Wir geben dem Template-Loop einen direkten Helper, damit die Multi-Kapitel-
    // Liste pro Kapitel-Span einzeln öffnet.
    gotoEventKapitel(ev, kapitelName, seite = null) {
      window.__app.gotoStelle(kapitelName, seite);
    },

    formatEventDate(ev) {
      return _formatEventDate(ev, (k, p) => window.__app.t(k, p));
    },

    subtypIcon(subtyp) {
      return subtypIcon(subtyp);
    },

    // Span-Höhe (Spannen-Events): proportional zur Jahr-Differenz, geclampt.
    // Wird per CSS-Custom-Prop --span-years konsumiert. 0 für Punkt-Events.
    eventSpanYears(ev) {
      if (ev.datum_year == null || ev.datum_ende_year == null) return 0;
      if (POINT_SUBTYPES.has(ev.subtyp || 'sonstiges')) return 0;
      const diff = ev.datum_ende_year - ev.datum_year;
      return diff > 0 ? Math.min(diff, 50) : 0;
    },

    filteredEreignisse() {
      const root = window.__app;
      const f = root.ereignisseFilters;
      return this._memoFiltered([
        root.globalZeitstrahl,
        f.suche  ?? '',
        f.figurId ?? '',
        f.kapitel ?? '',
        f.seite   ?? '',
        f.subtyp  ?? '',
      ]);
    },

    // Scrollt das Event am Listen-Index ins Sichtfeld (Klick auf Timeline-Item).
    scrollToEventIndex(index) {
      const node = this.$el?.querySelector(`.global-zeitstrahl-body--card [data-ev-index="${index}"]`);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    // Index des ersten undatierten Events (kein Kalenderjahr) in der gefilterten
    // Liste, oder -1. Diese Events landen nicht auf der Achse — Basis für die
    // Listen-Trennlinie (gz-section-divider) und den klickbaren Achse-Hinweis.
    firstUndatedIndex() {
      const list = this.filteredEreignisse();
      for (let i = 0; i < list.length; i++) if (list[i].datum_year == null) return i;
      return -1;
    },

    // Klick auf den Achse-Hinweis → zum ersten undatierten Listeneintrag scrollen.
    scrollToFirstUndated() {
      const idx = this.firstUndatedIndex();
      if (idx >= 0) this.scrollToEventIndex(idx);
    },

    // Liste → Achse: zentriert + selektiert das Timeline-Item zum Listen-Index.
    // No-op für undatierte Events (kein Achsen-Item) oder vor dem Lazy-Mount.
    selectTimelineEvent(index) {
      if (!this._timeline || !this._timelineItems?.get(index)) return;
      this._timeline.setSelection(index, { focus: true });
    },

    // Achse/Zeile → Manuskript: öffnet die erste verknüpfte Seite, sonst das
    // erste Kapitel. Liefert true, wenn ein Sprungziel existiert.
    openEventText(ev) {
      if (!ev) return false;
      const pageId = Array.isArray(ev.page_ids) ? ev.page_ids[0] : null;
      if (pageId != null) { window.__app.gotoPageById(pageId); return true; }
      const kap = Array.isArray(ev.kapitel) ? ev.kapitel[0] : ev.kapitel;
      if (kap) { window.__app.gotoStelle(kap, null); return true; }
      return false;
    },

    // True, wenn openEventText ein Ziel hätte (steuert .internal-link-Affordance).
    eventHasTarget(ev) {
      const pageId = Array.isArray(ev?.page_ids) ? ev.page_ids[0] : null;
      const kap = Array.isArray(ev?.kapitel) ? ev.kapitel[0] : ev?.kapitel;
      return pageId != null || !!kap;
    },

    // --- Timeline-Toolbar: Zoom / Fit / Sprung / Vollbild -------------------
    // Zoom-Buttons machen den sonst hinter Ctrl+Scroll versteckten Zoom sichtbar.
    timelineZoomIn()  { this._timeline?.zoomIn(0.5); },
    timelineZoomOut() { this._timeline?.zoomOut(0.5); },
    timelineFit()     { this._timeline?.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } }); },

    // Sprung an den Rand: behält den Zoom, schwenkt nur auf das früheste bzw.
    // späteste datierte Item (moveTo, nicht focus → keine Zoom-Änderung).
    timelineJumpFirst() { this._timelineMoveToBound('min'); },
    timelineJumpLast()  { this._timelineMoveToBound('max'); },
    _timelineMoveToBound(which) {
      if (!this._timeline || !this._timelineItems) return;
      const b = timelineBounds(this._timelineItems.get());
      if (!b) return;
      this._timeline.moveTo(new Date(b[which]), { animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
    },

    // Vollbild: native Fullscreen-API, CSS-Overlay-Fallback im catch (analog
    // Figuren-Graph). Den nativen Pfad spiegelt der fullscreenchange-Listener.
    async toggleTimelineFullscreen() {
      const wrap = this.$el?.querySelector('.gz-timeline-wrap');
      if (!wrap) return;
      try {
        await toggleWrapFullscreen(wrap);
      } catch {
        this.timelineFullscreen = !this.timelineFullscreen;
        this._applyTimelineFullscreenSize(this.timelineFullscreen);
      }
    },

    // vis-timeline wächst nur bis maxHeight — im Vollbild füllt es die Höhe
    // (height:'100%'), beim Verlassen zurück in den Auto-Höhe-Modus.
    _applyTimelineFullscreenSize(active) {
      if (!this._timeline) return;
      this.$nextTick(() => {
        if (!this._timeline) return;
        if (active) {
          this._timeline.setOptions({ maxHeight: '100%', height: '100%' });
        } else {
          // vis akzeptiert weder null noch '' zum Zurücksetzen auf Auto-Höhe
          // (Validator-Reject bzw. Kollaps auf 1 px). Die Option direkt löschen
          // lässt vis die Höhe wieder aus dem Inhalt bestimmen.
          this._timeline.options.height = undefined;
          this._timeline.setOptions({ maxHeight: TIMELINE_MAX_HEIGHT });
        }
        this._timeline.redraw();
      });
    },

    // Blendet die Achse erst ein, wenn vis sein erstes Layout (nach fit) fertig
    // hat — vorher ist sie auf eine 2-px-Zeile zusammengequetscht. vis feuert
    // `changed` nach jedem Redraw; der erste mit echter Höhe (>8 px) gilt als
    // „fertig". Fallback-Timer, damit der Lade-Zustand nie hängen bleibt.
    _revealTimelineWhenReady() {
      this._cancelTimelineReveal();
      if (!this._timeline) return;
      this.timelineReady = false;
      const tryReveal = () => {
        if (!this._timeline) return;
        const inner = this.$el?.querySelector('.gz-timeline .vis-timeline');
        if (!inner || inner.clientHeight <= 8) return;
        this._cancelTimelineReveal();
        // Ein Frame Puffer, damit der finale Redraw sicher gemalt ist.
        this._timelineRevealRaf = requestAnimationFrame(() => { this.timelineReady = true; });
      };
      this._timelineOnChanged = tryReveal;
      this._timeline.on('changed', tryReveal);
      this._timelineRevealFallback = setTimeout(() => {
        this._cancelTimelineReveal();
        this.timelineReady = true;
      }, 1500);
      tryReveal(); // sofort versuchen (Re-Open: Achse ist schon gerendert)
    },

    _cancelTimelineReveal() {
      if (this._timelineOnChanged) {
        try { this._timeline?.off('changed', this._timelineOnChanged); } catch {}
        this._timelineOnChanged = null;
      }
      clearTimeout(this._timelineRevealFallback);
      cancelAnimationFrame(this._timelineRevealRaf);
    },

    // Coalescing-Wrapper: serialisiert konkurrierende Render-Aufrufe und
    // stellt sicher, dass nach dem laufenden Render ggf. einmal nachgezogen wird.
    _renderTimeline() {
      if (this._timelineRendering) { this._timelineRerun = true; return; }
      this._timelineRendering = true;
      Promise.resolve(this._doRenderTimeline()).finally(() => {
        this._timelineRendering = false;
        if (this._timelineRerun) { this._timelineRerun = false; this._renderTimeline(); }
      });
    },

    // Baut/aktualisiert die vis-timeline. Lazy: erst wenn die Karte sichtbar ist
    // und datierte Events vorliegen. Item-Klick → Scroll zur Liste (scrollToEventIndex).
    async _doRenderTimeline() {
      const root = window.__app;
      if (!root?.showEreignisseCard) return;
      const el = this.$el?.querySelector('.gz-timeline');
      if (!el) return;

      const items = buildTimelineItems(this.filteredEreignisse());
      this.timelineItemCount = items.length;

      // Keine datierten Events → vorhandene Instanz abräumen, Container leeren.
      if (!items.length) {
        this._cancelTimelineReveal();
        this._timeline?.destroy();
        this._timeline = null;
        this._timelineItems = null;
        this._lastFitBookId = null;
        this.timelineReady = false;
        return;
      }

      let vis;
      try { vis = await loadVisTimeline(); }
      catch (e) { console.error('[ereignisse] vis-timeline load failed', e); return; }
      // Re-Entrancy: zwischen await und hier könnte die Karte geschlossen worden sein.
      if (!root.showEreignisseCard || !this.$el?.querySelector('.gz-timeline')) return;

      const visItems = items.map((it) => {
        const tip = document.createElement('span');
        tip.textContent = it.content;
        return {
          id: it.id,
          start: it.start,
          end: it.end,
          type: it.type,
          // Subtyp-Klasse trägt die Listen-Farbcodierung auf die Achse;
          // extern überschreibt sie (Weltgeschehen bleibt in Error-Tönung).
          className: 'gz-vis-item gz-vis-item--subtyp-' + (it.subtyp || 'sonstiges')
            + (it.extern ? ' gz-vis-item--extern' : ''),
          content: escHtml((it.content || '').slice(0, 48)),
          title: tip,
        };
      });

      const bookId = root.selectedBookId;
      if (!this._timeline) {
        this._timelineItems = new vis.DataSet(visItems);
        this._timeline = new vis.Timeline(el, this._timelineItems, {
          stack: true,
          maxHeight: TIMELINE_MAX_HEIGHT,
          verticalScroll: true,
          horizontalScroll: true,
          zoomKey: 'ctrlKey',
          selectable: true,
          showCurrentTime: false,
          margin: { item: 4, axis: 6 },
          orientation: 'top',
          // Dichte bändigen: überlappende Items (z.B. viele Geburten im selben
          // Jahr) bündeln sich rausgezoomt zu einer Zähler-Blase und entfalten
          // sich beim Reinzoomen.
          cluster: { maxItems: 1, showStipes: true },
        });
        // Einfachklick auf ein Item → zum Listeneintrag scrollen.
        // props.item ist die Item-id (= Listen-Index); bei Clustern eine
        // generierte UUID — daher der isCluster-Guard.
        // Einfachklick auf eine Cluster-Blase → aufklappen: focus() zoomt
        // animiert auf die enthaltenen Items, der Cluster löst sich auf.
        this._timeline.on('click', (props) => {
          if (props.isCluster) {
            if (props.items?.length) this._timeline.focus(props.items);
            return;
          }
          if (props.item != null) this.scrollToEventIndex(Number(props.item));
        });
        // Doppelklick → direkt ins Manuskript (erste verknüpfte Seite/Kapitel).
        // Cluster überlässt der Guard dem eingebauten fitOnDoubleClick.
        this._timeline.on('doubleClick', (props) => {
          if (props.isCluster || props.item == null) return;
          const ev = this.filteredEreignisse()[Number(props.item)];
          this.openEventText(ev);
        });
        this._timeline.fit();
        this._lastFitBookId = bookId;
        // Achse erst nach fertigem Layout einblenden (Spinner überbrückt).
        this._revealTimelineWhenReady();
        // Falls bei (Neu-)Mount bereits Vollbild aktiv ist: Höhe nachziehen.
        if (this.timelineFullscreen) this._applyTimelineFullscreenSize(true);
      } else {
        // Diff-Update statt clear()+add(): clear() leert das DataSet kurz ganz,
        // sodass die Achse zwischen den beiden Events leer aufblitzt (sichtbar
        // beim Tippen im Filter). update() + gezieltes remove() halten den
        // Bestand durchgehend gefüllt → kein Flackern.
        const nextIds = new Set(visItems.map(it => it.id));
        const staleIds = this._timelineItems.getIds().filter(id => !nextIds.has(id));
        if (staleIds.length) this._timelineItems.remove(staleIds);
        this._timelineItems.update(visItems);
        // fit() (Voll-Zoom) NUR bei Buchwechsel — sonst würde jede Filter-/
        // Suchänderung den vom User eingestellten Zoom-Bereich zurücksetzen.
        // Buchwechsel = frische Achse → kurz ausblenden + neu offenbaren.
        // Reine Filter-Updates lassen die Achse sichtbar (kein Flackern).
        if (this._lastFitBookId !== bookId) {
          this._timeline.fit();
          this._lastFitBookId = bookId;
          this._revealTimelineWhenReady();
        }
      }
    },
  }));
}
