// Ereignisse/Zeitstrahl-Methoden am Root-Spread (figuren.js ruft
// _buildGlobalZeitstrahl, app-komplett.js ruft _reloadZeitstrahl).

import { fetchJson } from '../utils.js';

// Sortier-Schlüssel mit strukturierten Datums-Feldern. Events ohne Jahr landen
// am Ende ("unbekannt"-Bucket). story_tag fängt relative Story-Zeit ohne Kalender.
function _sortKey(ev) {
  return [
    ev.datum_year  ?? 9999,
    ev.datum_month ?? 99,
    ev.datum_day   ?? 99,
    ev.story_tag   ?? 99999,
    ev.sort_order  ?? 0,
  ];
}
function _cmp(a, b) {
  const ka = _sortKey(a), kb = _sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

export const ereignisseMethods = {
  _buildGlobalZeitstrahl() {
    // Fallback-Pfad: konstruiert globalen Zeitstrahl aus figuren[].lebensereignisse
    // wenn der konsolidierte Server-Endpunkt nichts liefert. Strukturierte
    // Datums-Felder werden aus den figure_events-Feldern übernommen (kommen
    // dort an, sobald saveFigurenToDb das KI-Output mit datum_year/month/day
    // persistiert hat).
    const allEvents = [];
    for (const f of (this.figuren || [])) {
      for (const ev of (f.lebensereignisse || [])) {
        allEvents.push({
          datum:        ev.datum || '',
          datum_label:  ev.datum_label || ev.datum || '',
          datum_year:   ev.datum_year   ?? null,
          datum_month:  ev.datum_month  ?? null,
          datum_day:    ev.datum_day    ?? null,
          datum_ende_year:  ev.datum_ende_year  ?? null,
          datum_ende_month: ev.datum_ende_month ?? null,
          datum_ende_day:   ev.datum_ende_day   ?? null,
          story_tag:    ev.story_tag    ?? null,
          datum_unsicher: ev.datum_unsicher ?? false,
          ereignis: ev.ereignis || '',
          typ:      ev.typ || 'persoenlich',
          subtyp:   ev.subtyp || 'sonstiges',
          bedeutung: ev.bedeutung || '',
          sort_order: 0,
          kapitel: ev.kapitel || '',
          seite:   ev.seite || '',
          figur:   { id: f.id, name: f.kurzname || f.name, typ: f.typ },
        });
      }
    }

    // Events mit identischem datum+ereignis zusammenführen.
    const groups = [];
    const used = new Set();
    for (let i = 0; i < allEvents.length; i++) {
      if (used.has(i)) continue;
      const ev = allEvents[i];
      const group = {
        ...ev,
        kapitel:     ev.kapitel ? [ev.kapitel] : [],
        chapter_ids: [],
        seiten:      ev.seite   ? [ev.seite]   : [],
        page_ids:    [],
        figuren:     [ev.figur],
      };
      delete group.figur;
      delete group.seite;
      for (let j = i + 1; j < allEvents.length; j++) {
        if (used.has(j)) continue;
        const ev2 = allEvents[j];
        if (ev2.datum === ev.datum && ev2.ereignis === ev.ereignis) {
          group.figuren.push(ev2.figur);
          if (ev2.kapitel && !group.kapitel.includes(ev2.kapitel)) group.kapitel.push(ev2.kapitel);
          if (ev2.seite   && !group.seiten.includes(ev2.seite))   group.seiten.push(ev2.seite);
          used.add(j);
        }
      }
      used.add(i);
      groups.push(group);
    }

    groups.sort(_cmp);
    this.globalZeitstrahl = groups;
  },

  async _reloadZeitstrahl() {
    try {
      const { ereignisse } = await fetchJson(`/figures/zeitstrahl/${this.selectedBookId}`);
      if (ereignisse) {
        // Server liefert bereits strukturierte Felder sortiert; Client-Sortierung
        // ist defensiv (gegen abweichende Tiebreaker bei Auto-Reorder).
        this.globalZeitstrahl = [...ereignisse].sort(_cmp);
      } else if (!this.globalZeitstrahl.length) {
        this._buildGlobalZeitstrahl();
      }
    } catch (e) {
      console.error('[reloadZeitstrahl]', e);
      if (!this.globalZeitstrahl.length) this._buildGlobalZeitstrahl();
    }
  },
};
