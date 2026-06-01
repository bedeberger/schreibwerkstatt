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
// Klick→Scroll). Spannen (datum_ende_year) werden zu Range-Items. Extrahiert
// für Tests (siehe ereignisse-card-filter.test.mjs).
export function buildTimelineItems(events) {
  const items = [];
  (events || []).forEach((ev, i) => {
    if (ev.datum_year == null) return;
    const start = _eventDate(ev.datum_year, ev.datum_month, ev.datum_day);
    const item = {
      id: i,
      start,
      extern: ev.typ === 'extern',
      content: ev.ereignis || '',
    };
    if (ev.datum_ende_year != null) {
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
  if (ende && start) return t('events.span', { start, ende });
  if (start) return start;
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
    _memoFiltered: _memoEreignisse(),
    // vis-timeline-Instanz + Item-DataSet (lazy beim ersten Sichtbarwerden).
    _timeline: null,
    _timelineItems: null,
    // Re-Entry-Guards: _renderTimeline ist async (await loadVisTimeline) und kann
    // von zwei Watches quasi-gleichzeitig getriggert werden → sonst Doppel-Mount.
    _timelineRendering: false,
    _timelineRerun: false,
    // Wieviele datierte Items zuletzt auf der Achse landeten (Hinweis-Text).
    timelineItemCount: 0,

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
    },

    destroy() {
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
        this._timeline?.destroy();
        this._timeline = null;
        this._timelineItems = null;
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
          className: 'gz-vis-item' + (it.extern ? ' gz-vis-item--extern' : ''),
          content: escHtml((it.content || '').slice(0, 48)),
          title: tip,
        };
      });

      if (!this._timeline) {
        this._timelineItems = new vis.DataSet(visItems);
        this._timeline = new vis.Timeline(el, this._timelineItems, {
          stack: true,
          maxHeight: 260,
          verticalScroll: true,
          horizontalScroll: true,
          zoomKey: 'ctrlKey',
          selectable: true,
          showCurrentTime: false,
          margin: { item: 4, axis: 6 },
          orientation: 'top',
        });
        // Jeder Klick auf ein Item (nicht nur Selektionswechsel) → zum
        // Listeneintrag scrollen. props.item ist die Item-id (= Listen-Index).
        this._timeline.on('click', (props) => {
          if (props.item != null) this.scrollToEventIndex(Number(props.item));
        });
      } else {
        this._timelineItems.clear();
        this._timelineItems.add(visItems);
      }
      this._timeline.fit();
    },
  }));
}
