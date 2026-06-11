// Alpine.data('worldFactsCard') — Welt-Fakten/Weltregeln-Karte (read-only).
//
// Selbstständige Karte: hält eigenen State + fetcht /world-facts/:bookId. Daten
// stammen ausschliesslich aus der Komplettanalyse (kein Edit-Pfad im Frontend).
// Gruppierung nach Kategorie; Filter über Suche + Kategorie-Combobox.
import { setupCardLifecycle } from './card-lifecycle.js';
import { fetchJson } from '../utils.js';

// Harte Kategorie-Gruppierung — SSoT für Reihenfolge + Icon je Key. Spiegelt die
// Whitelist FAKT_KATEGORIE_WL (db/schema.js) und das Prompt-Enum
// (prompts/komplett/schema-strings.js#FAKTEN_SCHEMA). Labels via i18n
// weltfakten.kategorie.<key>. Unbekannte/leere Werte → 'sonstiges'.
export const KAT_ORDER = [
  'figur', 'ort', 'objekt', 'organisation', 'technik', 'regel',
  'kultur', 'historie', 'zeit', 'soziolekt', 'ereignis', 'sonstiges',
];
const KAT_ICON = {
  figur:        'user',
  ort:          'map-pin',
  objekt:       'package',
  organisation: 'landmark',
  technik:      'cpu',
  regel:        'scale',
  kultur:       'book-open',
  historie:     'scroll',
  zeit:         'calendar',
  soziolekt:    'quote',
  ereignis:     'zap',
  sonstiges:    'more-horizontal',
};
const _katRank = new Map(KAT_ORDER.map((k, i) => [k, i]));
function _normKat(k) {
  return _katRank.has(k) ? k : 'sonstiges';
}

export function registerWorldFactsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('worldFactsCard', () => ({
    fakten: [],
    wfUpdatedAt: null,
    wfLoading: false,
    wfFilters: { suche: '', kategorie: '', seite: '' },
    wfOpenGroups: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'weltfakten',
        showFlag: 'showWorldFactsCard',
        resetState: { fakten: [], wfUpdatedAt: null, wfLoading: false, wfFilters: { suche: '', kategorie: '', seite: '' }, wfOpenGroups: {} },
        load: () => this.loadWorldFacts(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
    },

    async loadWorldFacts() {
      const bookId = window.__app?.selectedBookId;
      if (!bookId) return;
      this.wfLoading = true;
      try {
        const data = await fetchJson('/world-facts/' + bookId);
        this.fakten = data?.fakten || [];
        this.wfUpdatedAt = data?.updated_at || null;
      } catch (e) {
        console.error('[loadWorldFacts]', e);
      } finally {
        this.wfLoading = false;
      }
    },

    // Vorhandene Kategorien in kanonischer Reihenfolge (KAT_ORDER), nicht alphabetisch.
    get wfKategorieListe() {
      const present = new Set(this.fakten.map(f => _normKat(f.kategorie)));
      return KAT_ORDER.filter(k => present.has(k));
    },

    // i18n-Label + Lucide-Icon je Kategorie-Key (für Gruppen-Köpfe + Filter-Tabs).
    wfKatLabel(key) {
      return window.__app.t('weltfakten.kategorie.' + _normKat(key));
    },
    wfKatIcon(key) {
      return KAT_ICON[_normKat(key)] || KAT_ICON.sonstiges;
    },
    wfKatCount(key) {
      const k = _normKat(key);
      return this.fakten.reduce((n, f) => n + (_normKat(f.kategorie) === k ? 1 : 0), 0);
    },

    wfToggleGroup(key) {
      this.wfOpenGroups[key] = !this.wfOpenGroups[key];
    },
    // Gruppe sichtbar, wenn explizit aufgeklappt — oder zwangsoffen: bei aktiver
    // Suche/Kapitel-Filter (Treffer müssen sichtbar sein) und bei aktivem
    // Kategorie-Tab (Gruppen-Kopf ist dort ausgeblendet, Liste zeigt direkt).
    wfGroupOpen(key) {
      if (this.wfFilters.kategorie || this.wfFilters.seite || this.wfFilters.suche.trim()) return true;
      return !!this.wfOpenGroups[key];
    },

    // Alle in Fakten referenzierten Kapitel-/Seitennamen (aus seite_label).
    // Fallback auf f.kapitel, falls die Junction-Tabelle befüllt ist.
    get wfSeiteListe() {
      const refs = this.fakten.flatMap(f => f.seite ? [f.seite] : (f.kapitel || []));
      return [...new Set(refs)].sort((a, b) => a.localeCompare(b));
    },

    get wfFiltered() {
      const q = this.wfFilters.suche.trim().toLowerCase();
      const kat = this.wfFilters.kategorie;
      const seite = this.wfFilters.seite;
      return this.fakten.filter(f => {
        if (kat && _normKat(f.kategorie) !== kat) return false;
        if (seite && f.seite !== seite && !(f.kapitel || []).includes(seite)) return false;
        if (!q) return true;
        return (f.fakt || '').toLowerCase().includes(q)
          || (f.subjekt || '').toLowerCase().includes(q)
          || this.wfKatLabel(f.kategorie).toLowerCase().includes(q);
      });
    },

    // Gefilterte Fakten nach Kategorie gruppiert, in kanonischer Reihenfolge:
    // [{ kategorie (Key), fakten[] }].
    get wfGrouped() {
      const groups = new Map();
      for (const f of this.wfFiltered) {
        const k = _normKat(f.kategorie);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(f);
      }
      return KAT_ORDER
        .filter(k => groups.has(k))
        .map(k => ({ kategorie: k, fakten: groups.get(k) }));
    },
  }));
}
