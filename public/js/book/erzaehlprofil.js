// Kapitel-Erzählprofil-Methoden (in Alpine.data('erzaehlprofilCard') gespreadet).
// Ergebnisse stammen aus der Komplettanalyse-Phase «Erzählprofil» und werden via
// _loadErzaehlprofil (GET) angezeigt: POV/Erzählzeit pro Kapitel (+ Abweichung von
// der deklarierten Soll-Perspektive), Spannungskurve (Intensität 1–5) und
// Themen-/Motiv-Verteilung übers Buch. Rein lesend, nie generativ im Buchtext.

import { fetchJson } from '../utils.js';

const _POV_KEYS = ['ich', 'du', 'er_sie_personal', 'er_sie_auktorial', 'wir', 'gemischt'];
const _TEMPUS_KEYS = ['praeteritum', 'praesens', 'gemischt'];

export const erzaehlprofilMethods = {
  async _loadErzaehlprofil() {
    try {
      const data = await fetchJson('/jobs/erzaehlprofil/' + Alpine.store('nav').selectedBookId);
      this.erzaehlprofilResult = data;
    } catch (e) {
      console.error('[_loadErzaehlprofil]', e);
    }
  },

  erzaehlprofilChapters() {
    return this.erzaehlprofilResult?.chapters || [];
  },

  erzaehlprofilHasData() {
    return this.erzaehlprofilChapters().length > 0;
  },

  // Label-Helfer (i18n mit Fallback auf den Rohwert für unbekannte Keys).
  erzaehlprofilPovLabel(key) {
    if (!key) return '';
    const t = window.__app.t('erzaehlprofil.pov.' + key);
    return t === 'erzaehlprofil.pov.' + key ? key : t;
  },
  erzaehlprofilTempusLabel(key) {
    if (!key) return '';
    const t = window.__app.t('erzaehlprofil.tempus.' + key);
    return t === 'erzaehlprofil.tempus.' + key ? key : t;
  },
  erzaehlprofilThemaTypLabel(typ) {
    if (!typ) return '';
    const t = window.__app.t('erzaehlprofil.themaTyp.' + typ);
    return t === 'erzaehlprofil.themaTyp.' + typ ? typ : t;
  },

  // Deklarierte Soll-Perspektive/-zeit (aus book_settings) als lesbare Labels –
  // Baseline für die Abweichungs-Anzeige. Null wenn nichts deklariert.
  erzaehlprofilDeclaredLabel() {
    const d = this.erzaehlprofilResult?.declared || {};
    const parts = [];
    if (d.erzaehlperspektive) parts.push(this.erzaehlprofilPovLabel(d.erzaehlperspektive));
    if (d.erzaehlzeit) parts.push(this.erzaehlprofilTempusLabel(d.erzaehlzeit));
    return parts.join(' · ');
  },

  // Kapitel mit erkannter Abweichung von der deklarierten Soll-Perspektive.
  erzaehlprofilDeviations() {
    return this.erzaehlprofilChapters().filter(c => c.pov_abweichung);
  },

  // Spannungskurven-Punkte: pro Kapitel { kapitel, chapter_id, intensitaet(1–5),
  // begruendung }. Kapitel ohne Intensität → 0 (keine Balkenhöhe).
  erzaehlprofilCurve() {
    return this.erzaehlprofilChapters().map(c => ({
      kapitel: c.kapitel,
      chapter_id: c.chapter_id,
      intensitaet: Number.isFinite(c.intensitaet) ? c.intensitaet : 0,
      begruendung: c.intensitaet_begruendung || '',
    }));
  },

  // Themen/Motive/Symbole über alle Kapitel aggregiert: gleicher (normalisierter)
  // Name → ein Eintrag mit Häufigkeit + Kapitelliste. Sortiert nach Häufigkeit.
  erzaehlprofilThemenAggregiert() {
    const byKey = new Map();
    for (const ch of this.erzaehlprofilChapters()) {
      for (const t of (ch.themen || [])) {
        const name = (t.thema || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, { thema: name, typ: t.typ || null, count: 0, kapitel: [] });
        const e = byKey.get(key);
        e.count++;
        if (ch.kapitel && !e.kapitel.includes(ch.kapitel)) e.kapitel.push(ch.kapitel);
      }
    }
    return [...byKey.values()].sort((a, b) => b.count - a.count || a.thema.localeCompare(b.thema));
  },

  // Navigation zur ersten Seite eines Kapitels (Klick auf Kurvenbalken/Kapitelzeile).
  erzaehlprofilGotoKapitel(chapterId) {
    if (chapterId == null) return;
    const chapter = (Alpine.store('nav').tree || []).find(t => t.type === 'chapter' && t.id === chapterId);
    const page = chapter?.pages?.[0];
    if (page) window.__app.selectPage(page);
  },

  erzaehlprofilChapterKey(ch, i) {
    return ch?.chapter_id != null ? 'ch:' + ch.chapter_id : 'i:' + i;
  },
};

export { _POV_KEYS, _TEMPUS_KEYS };
