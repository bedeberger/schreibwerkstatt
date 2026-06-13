// Alpine.data('ereignisseCard') — Sub-Komponente der Zeitstrahl-Karte.
//
// Eigener State: Meta-Flags (Loading/Status/Progress/PollTimer) + UI-Helper.
// Root behält:
//   - `globalZeitstrahl` (im Store, via $root-Getter auch am Root sichtbar)
//   - `ereignisseFilters` (app-navigation.js schreibt darauf)
//   - `_buildGlobalZeitstrahl` (wird aus figuren.js / loadFiguren gerufen)
//   - `_reloadZeitstrahl` (wird aus app-komplett.js gerufen)
import { setupCardLifecycle } from './card-lifecycle.js';
import { memoizeByIdentity } from '../utils.js';

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

// Band-Modell (Achsen-Ticks + Lane-gepackte Marker) gecacht über die Identität
// der gefilterten Liste — filteredEreignisse() liefert dieselbe Array-Referenz
// solange Daten/Filter unverändert, also rechnet das Layout nur bei echtem
// Wechsel neu (Template ruft bandModel() mehrfach pro Render).
const _memoBandModel = () => memoizeByIdentity(([events]) => buildBandModel(events));

// Baut ein Date aus den strukturierten Jahr/Monat/Tag-Feldern. setFullYear
// (statt new Date(year,…)) vermeidet das 0–99-Jahr-Mapping auf 1900+year und
// trägt damit auch historische/frühe Jahre korrekt.
function _eventDate(year, month, day) {
  const d = new Date(0);
  d.setFullYear(year, month ? month - 1 : 0, day || 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Pure: übersetzt die (gefilterte) Event-Liste in normalisierte Achsen-Items für
// das Jahres-Band. Nur datierte Events (datum_year gesetzt) landen auf der Achse
// — story_tag/undatiert bleiben nur in der Liste. id = Listen-Index (Brücke zu
// [data-ev-index] für Klick→Scroll). Spannen (datum_ende_year) werden zu Range-
// Items. subtyp trägt die Farbcodierung der Liste auf die Achse. Speist
// layoutBandItems; extrahiert für Tests (ereignisse-card-filter.test.mjs).
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

// Jahr → ms (Jan 1, lokale Mitternacht). Gleiche Basis wie _eventDate, damit
// Achsen-Ticks und Marker auf derselben Skala sitzen.
function _yearToMs(year) {
  const d = new Date(0);
  d.setFullYear(year, 0, 1);
  d.setHours(0, 0, 0, 0);
  return +d;
}

// Pure: ordnet datierte Timeline-Items (aus buildTimelineItems) in horizontale
// Spuren ("Lanes") und berechnet ihre x-Position als Prozent entlang [min..max].
// Greedy: jedes Item kommt in die erste Spur, in der es den Mindestabstand zum
// zuletzt belegten Slot wahrt — verhindert, dass Marker überlappen. Spannen
// belegen [x..xEnd], Punkte reservieren einen schmalen Slot (minSlotPct).
//
// Höhe gedeckelt bei maxLanes: in dichten Jahren (z.B. viele Geburten im selben
// Jahr) würde striktes Nicht-Überlappen sonst zweistellige Spurenzahlen erzwingen.
// Was über die letzte Spur hinaus drängt, wird je x-Spalte zu EINEM kleinen
// „+N"-Marker (kind:'more') gebündelt statt als Riesen-Zählblase — die Achse
// bleibt flach und ruhig. Kein stilles Wegschneiden: jedes überzählige Event
// zählt in den sichtbaren Count, Klick springt zum ersten in der Liste.
//
// `lane`/`x`/`widthPct` werden vom Template in CSS-Custom-Props übersetzt.
// Extrahiert für Tests (ereignisse-card-filter.test.mjs).
export function layoutBandItems(items, { minSlotPct = 1.4, maxLanes = 6 } = {}) {
  const bounds = timelineBounds(items);
  if (!bounds) return { lanes: 0, markers: [], bounds: null };
  const spanMs = Math.max(1, bounds.max - bounds.min);
  const toPct = (ms) => ((ms - bounds.min) / spanMs) * 100;
  // Nach Start sortieren (defensiv) + Original-id für Klick→Liste behalten.
  const sorted = [...(items || [])].sort((a, b) => (+new Date(a.start)) - (+new Date(b.start)));
  const laneEnd = [];          // höchste belegte x-Position (Prozent) je Spur
  const overflowByCol = new Map(); // x-Spalte → gebündelter „+N"-Marker
  const markers = [];
  let usedLanes = 0;
  for (const it of sorted) {
    const x = toPct(+new Date(it.start));
    const isRange = it.type === 'range' && it.end != null;
    const xEnd = isRange ? toPct(+new Date(it.end)) : x;
    const slotEnd = Math.max(xEnd, x + minSlotPct);
    let lane = 0;
    while (lane < laneEnd.length && laneEnd[lane] > x + 0.0001) lane++;
    if (lane >= maxLanes) {
      // Überlauf: pro x-Spalte (gerundet) zu einem +N-Marker auf der obersten
      // Spur bündeln. id = erstes überzähliges Event (Klick → Liste).
      const colKey = Math.round(x / minSlotPct);
      let chip = overflowByCol.get(colKey);
      if (!chip) {
        chip = { kind: 'more', id: it.id, x, lane: maxLanes - 1, count: 0 };
        overflowByCol.set(colKey, chip);
        markers.push(chip);
      }
      chip.count++;
      continue;
    }
    laneEnd[lane] = slotEnd;
    if (lane + 1 > usedLanes) usedLanes = lane + 1;
    markers.push({
      kind: 'event',
      id: it.id,
      x,
      lane,
      isRange,
      widthPct: isRange ? Math.max(xEnd - x, minSlotPct) : 0,
      subtyp: it.subtyp || 'sonstiges',
      extern: !!it.extern,
      content: it.content || '',
    });
  }
  return { lanes: Math.min(Math.max(usedLanes, overflowByCol.size ? maxLanes : 0), maxLanes), markers, bounds };
}

// Pure: "nette" Jahres-Ticks für die Achsenbeschriftung. Schrittweite aus einer
// festen Leiter (1/2/5/10/…) so gewählt, dass ~targetTicks Beschriftungen
// entstehen. Liefert [{ year, x }] (x = Prozent). Extrahiert für Tests.
export function bandAxisTicks(bounds, { targetTicks = 6 } = {}) {
  if (!bounds) return [];
  const y0 = new Date(bounds.min).getFullYear();
  const y1 = new Date(bounds.max).getFullYear();
  const yearsSpan = Math.max(1, y1 - y0);
  const ladder = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
  const step = ladder.find(s => yearsSpan / s <= targetTicks) || ladder[ladder.length - 1];
  const spanMs = Math.max(1, bounds.max - bounds.min);
  const start = Math.ceil(y0 / step) * step;
  const ticks = [];
  for (let y = start; y <= y1; y += step) {
    ticks.push({ year: y, x: ((_yearToMs(y) - bounds.min) / spanMs) * 100 });
  }
  if (!ticks.length) ticks.push({ year: y0, x: 0 }); // sehr kurze Spanne → Start-Jahr
  return ticks;
}

// Pure: komplettes Anzeige-Modell des Jahres-Bands aus der (gefilterten) Event-
// Liste. itemCount = Anzahl datierter Items (achsen-fähig; undatierte bleiben nur
// in der Liste), lanes/markers fürs Layout, ticks für die Achse. Extrahiert für
// Tests; in der Karte via memoizeByIdentity über die gefilterte Liste gecacht.
export function buildBandModel(events) {
  const items = buildTimelineItems(events);
  const { lanes, markers, bounds } = layoutBandItems(items);
  return { itemCount: items.length, lanes, markers, ticks: bandAxisTicks(bounds), bounds };
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

// Subtyp → Akzentfarbe des Band-Markers. Token-SSoT: `--card-accent-event-*`
// (public/css/tokens/colors.css), gleiche Codierung wie die Listen-Badges.
// Unbekannte Subtypen fallen auf 'sonstiges'; extern (Weltgeschehen) übersteuert
// mit der Error-Randfarbe — analog zur Listen-Darstellung.
const _SUBTYP_KEYS = new Set(Object.keys(SUBTYP_ICON));
export function bandMarkerColor(subtyp, extern) {
  if (extern) return 'var(--color-err-border)';
  const key = _SUBTYP_KEYS.has(subtyp) ? subtyp : 'sonstiges';
  return `var(--card-accent-event-${key})`;
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
    _memoFiltered: _memoEreignisse(),
    _memoBand: _memoBandModel(),
    // Listen-Index des aktuell hervorgehobenen Events (Klick auf Marker oder
    // Listen-Datum). Markiert den passenden Band-Marker und scrollt ihn ins Bild.
    selectedEventIndex: null,

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
          selectedEventIndex: null,
        },
        load: (root) => root._reloadZeitstrahl(),
        refreshNeedsBookId: false,
      });
      // Das Jahres-Band rendert deklarativ aus bandModel() (reaktiv über
      // filteredEreignisse) — kein imperativer Render-Pfad, kein Lazy-Lib-Load,
      // kein asynchrones Layout. Damit gibt es keinen Einklapp-/Expandier-Effekt.
    },

    destroy() {
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

    // Liste → Band: hebt den Marker zum Listen-Index hervor und scrollt ihn
    // horizontal ins Bild. No-op für undatierte Events (kein Marker auf der Achse).
    selectTimelineEvent(index) {
      this.selectedEventIndex = index;
      this.$nextTick(() => {
        const marker = this.$el?.querySelector(`.gz-band-marker[data-ev-id="${index}"]`);
        marker?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      });
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

    // --- Jahres-Band ---------------------------------------------------------
    // Anzeige-Modell (Achsen-Ticks + Lane-gepackte Marker), gecacht über die
    // Identität der gefilterten Liste. Das Template ruft bandModel() mehrfach
    // pro Render (Höhe, Tick-Loop, Marker-Loop) — Memo hält das Layout stabil.
    bandModel() {
      return this._memoBand([this.filteredEreignisse()]);
    },

    // Anzahl datierter Events (auf der Achse). Treibt die Sichtbarkeit des Bands
    // und den Hinweis auf undatierte Events. Getter statt State — kein
    // imperativer Render mehr, der ihn pflegen müsste.
    get timelineItemCount() {
      return this.bandModel().itemCount;
    },

    // Inline-CSS-Props eines Markers: x-Position (Prozent), Spur (Lane → top via
    // calc in der CSS), Akzentfarbe, sowie Breite bei Spannen. `:style`-Binding
    // mit Custom-Props ist das etablierte Muster (vgl. --span-years/--progress).
    bandMarkerStyle(m) {
      const style = {
        left: m.x.toFixed(3) + '%',
        '--gz-band-lane': m.lane,
        '--gz-marker-color': m.kind === 'more' ? 'var(--color-muted)' : bandMarkerColor(m.subtyp, m.extern),
      };
      if (m.isRange) style.width = m.widthPct.toFixed(3) + '%';
      return style;
    },

    // Klick auf einen Band-Marker → zum Listeneintrag scrollen + hervorheben.
    onBandMarkerClick(index) {
      this.selectedEventIndex = index;
      this.scrollToEventIndex(index);
    },
  }));
}
