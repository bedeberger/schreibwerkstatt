// Tagebuch-Rückblick-Prompts + Schema. Rückwärtsgewandte Verdichtung datierter
// Einträge eines Zeitraums (Monat 'YYYY-MM' oder Jahr 'YYYY'): häufige Themen,
// wiederkehrende Personen/Orte, bemerkenswerte Tage, Fliesstext-Zusammenfassung.
//
// App-Philosophie: KI ist rückwärtsgewandt und schreibt NIE in den Buchtext.
// Harter Halluzinations-Constraint: nur belegte Aussagen, jedes Thema/jeder Tag
// mit Datums-Beleg aus dem vorliegenden Material; keine erfundenen Ereignisse.

import { _obj, _str, _num } from './schema-utils.js';
import { _jsonOnly } from './state.js';

// Gemeinsamer Constraint-Block für Single-Pass und Reduce — hält die
// Halluzinations-Regeln an einer Stelle.
const RUECKBLICK_CONSTRAINT = `
Strenge Regeln (verbindlich):
- Stütze JEDE Aussage ausschliesslich auf die vorgelegten Einträge. Erfinde nichts.
- Jedes Thema, jede Person, jeder Ort und jeder bemerkenswerte Tag MUSS mit mindestens einem Eintragsdatum (YYYY-MM-DD) belegt sein, das im Material vorkommt.
- "belege" listet ALLE Eintragsdaten (YYYY-MM-DD), in denen das Thema / die Person / der Ort vorkommt — aufsteigend, nur tatsächlich vorhandene Daten.
- "haeufigkeit" ist die Anzahl der Einträge, in denen das Thema / die Person / der Ort vorkommt (= Länge von "belege") — keine Schätzung darüber hinaus.
- Personen und Orte nur nennen, wenn sie im Text tatsächlich erwähnt werden. Keine Auflösung von Pronomen zu erfundenen Namen.
- Schreibe NICHT in den Tagebuchtext, schlage keine neuen Einträge vor. Du verdichtest nur das Geschriebene.
- "zusammenfassung" ist ein beobachtender Rückblick (2–4 Absätze) über den Zeitraum, kein Ratgeber und keine Fortsetzung.`;

// Format des Ausgabe-Schemas als Prompt-Text (für Claude; lokale Provider nutzen
// zusätzlich SCHEMA_RUECKBLICK grammar-constrained).
const RUECKBLICK_OUTPUT = `
<output_format>
Antworte mit diesem JSON-Schema:
{
  "themen": [
    { "label": "kurzes Themen-Label", "haeufigkeit": 3, "belege": ["2024-03-04", "2024-03-12"] }
  ],
  "personen": [ { "name": "im Text genannter Name", "haeufigkeit": 5, "belege": ["2024-03-04", "2024-03-12"] } ],
  "orte":     [ { "name": "im Text genannter Ort", "haeufigkeit": 2, "belege": ["2024-03-04"] } ],
  "bemerkenswerteTage": [ { "datum": "2024-03-15", "begruendung": "ein Satz, warum dieser Tag heraussticht" } ],
  "zusammenfassung": "2–4 Absätze Fliesstext: zentrale Stimmungen, Entwicklungen und roter Faden des Zeitraums – nur belegt"
}
</output_format>`;

// Reduzierte Ausgabe des Reduce-Passes: Themen/Personen/Orte werden deterministisch
// im Code zusammengeführt (mergeRueckblickFacets), das Modell liefert nur noch die
// synthetisierenden Teile — die über den ganzen Zeitraum bemerkenswertesten Tage
// und die Fliesstext-Betrachtung.
const RUECKBLICK_SYNTH_OUTPUT = `
<output_format>
Antworte mit diesem JSON-Schema:
{
  "bemerkenswerteTage": [ { "datum": "2024-03-15", "begruendung": "ein Satz, warum dieser Tag heraussticht" } ],
  "zusammenfassung": "2–4 Absätze Fliesstext: zentrale Stimmungen, Entwicklungen und roter Faden des Zeitraums – nur belegt"
}
</output_format>`;

// Formatiert die gefilterten Einträge für den Single-Pass-Call: ein Block pro
// Tag mit Datum-Header, damit das Modell Belege zeichengenau zuordnen kann.
function _formatEntries(entries) {
  return entries
    .map(e => `### ${e.datum}${e.titel && e.titel !== e.datum ? ` – ${e.titel}` : ''}\n${e.text}`)
    .join('\n\n---\n\n');
}

// Eine Entitäts-Zeile: akzeptiert nackten Namen (String) oder ein Objekt
// { name, info } — info trägt Rolle/Beruf/Alias bzw. Land/Typ, in Klammern.
// Die kanonische Schreibweise steht stets VOR der Klammer.
function _entityLine(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || !item.name) return '';
  const info = (item.info || '').trim();
  return info ? `${item.name} (${info})` : item.name;
}

function _entityList(items) {
  return (items || []).map(_entityLine).filter(Boolean).map(l => `- ${l}`).join('\n');
}

function _kontextBlock(figuren, orte) {
  const parts = [];
  const figLines = _entityList(figuren);
  if (figLines) {
    parts.push(`Bekannte Figuren dieses Buchs (kanonische Schreibweise steht vor der Klammer; nutze sie, wenn eine Person gemeint ist):\n${figLines}`);
  }
  const ortLines = _entityList(orte);
  if (ortLines) {
    parts.push(`Bekannte Orte dieses Buchs:\n${ortLines}`);
  }
  if (!parts.length) return '';
  return `\n<kontext>\n${parts.join('\n')}\n</kontext>`;
}

// Verdichteter Rückblick des vorangegangenen Zeitraums. Dient NUR der Einordnung
// von Entwicklungen über die Zeit — Belege/Fakten dürfen NICHT übernommen werden.
function _vorblickBlock(vorblick) {
  if (!vorblick || !vorblick.result) return '';
  const r = vorblick.result;
  const themen   = (r.themen   || []).slice(0, 8).map(t => t.label).filter(Boolean).join(', ');
  const personen = (r.personen || []).slice(0, 12).map(p => p.name).filter(Boolean).join(', ');
  const orte     = (r.orte     || []).slice(0, 12).map(o => o.name).filter(Boolean).join(', ');
  const zus      = (r.zusammenfassung || '').trim();
  const lines = [];
  if (themen)   lines.push(`Themen: ${themen}`);
  if (personen) lines.push(`Personen: ${personen}`);
  if (orte)     lines.push(`Orte: ${orte}`);
  if (zus)      lines.push(`Zusammenfassung: ${zus}`);
  if (!lines.length) return '';
  return `\n<vorheriger_rueckblick zeitraum="${vorblick.zeitraum}">
Verdichteter Rückblick des unmittelbar vorangegangenen Zeitraums. Nutze ihn AUSSCHLIESSLICH, um
Entwicklungen über die Zeit zu benennen (z.B. fortgesetzt, neu hinzugekommen, nicht mehr erwähnt).
Übernimm KEINE Belege, Daten oder Fakten daraus — jeder Beleg im neuen Rückblick muss aus den
aktuellen Einträgen stammen.
${lines.join('\n')}
</vorheriger_rueckblick>`;
}

/**
 * Single-Pass-Rückblick über alle gefilterten Einträge eines Zeitraums.
 * @param {Array<{datum:string, titel:string, text:string}>} entries
 * @param {{ zeitraum:string, figuren?:Array, orte?:Array, vorblick?:{zeitraum:string, result:object} }} opts
 *   figuren/orte: Namen (String) oder { name, info } (info = Rolle/Beruf/Alias bzw. Land/Typ).
 */
export function buildRueckblickPrompt(entries, { zeitraum, figuren = [], orte = [], vorblick = null } = {}) {
  return `<aufgabe>
Erstelle einen rückwärtsgewandten Rückblick über die Tagebuch-Einträge des Zeitraums «${zeitraum}».
Verdichte das Geschriebene zu wiederkehrenden Themen, Personen, Orten und bemerkenswerten Tagen
sowie einer zusammenfassenden Betrachtung. Du bewertest nicht und schreibst nicht weiter.
</aufgabe>
${RUECKBLICK_CONSTRAINT}${_kontextBlock(figuren, orte)}${_vorblickBlock(vorblick)}
${RUECKBLICK_OUTPUT}
<eintraege zeitraum="${zeitraum}" anzahl="${entries.length}">
${_formatEntries(entries)}
</eintraege>${_jsonOnly()}`;
}

// Führt die Facetten (Themen/Personen/Orte) der Teilrückblicke deterministisch
// zusammen: gleiche Labels/Namen (case-insensitiv) verschmelzen, Belege werden
// vereinigt, "haeufigkeit" = Anzahl eindeutiger Belegtage. Rein numerische
// Aggregation gehört in den Code, nicht in einen zweiten KI-Call (spart Tokens,
// eliminiert Zähl-Halluzination). Absteigend nach Häufigkeit.
function _mergeFacet(partResults, arrKey, labelKey) {
  const map = new Map();
  for (const part of (partResults || [])) {
    for (const item of (part[arrKey] || [])) {
      const display = String(item[labelKey] || '').trim();
      if (!display) continue;
      const nk = display.toLowerCase();
      let rec = map.get(nk);
      if (!rec) { rec = { display, belege: new Set() }; map.set(nk, rec); }
      for (const b of (item.belege || [])) {
        const d = String(b).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) rec.belege.add(d);
      }
    }
  }
  return [...map.values()]
    .map(v => ({ [labelKey]: v.display, haeufigkeit: v.belege.size, belege: [...v.belege].sort() }))
    .sort((a, b) => b.haeufigkeit - a.haeufigkeit);
}

export function mergeRueckblickFacets(partResults) {
  return {
    themen:   _mergeFacet(partResults, 'themen', 'label'),
    personen: _mergeFacet(partResults, 'personen', 'name'),
    orte:     _mergeFacet(partResults, 'orte', 'name'),
  };
}

// Kompakte Darstellung der bereits verdichteten Facetten für den Reduce-Prompt.
function _formatMergedFacets(merged) {
  const line = (arr, key) => (arr || []).slice(0, 40).map(x => `${x[key]} (${x.haeufigkeit}×)`).join(', ') || '–';
  return `Themen: ${line(merged.themen, 'label')}\nPersonen: ${line(merged.personen, 'name')}\nOrte: ${line(merged.orte, 'name')}`;
}

// Bemerkenswerte-Tage-Kandidaten + Zusammenfassungen je Teil (fürs Synthese-Urteil).
function _formatMonthSummaries(partResults) {
  return (partResults || []).map(m => {
    const tage = (m.bemerkenswerteTage || []).map(t => `${t.datum}: ${t.begruendung}`).join(' | ') || '–';
    return `## ${m.monat}\nBemerkenswerte Tage: ${tage}\nZusammenfassung: ${m.zusammenfassung || '–'}`;
  }).join('\n\n');
}

/**
 * Reduce-/Synthese-Pass: die Facetten (Themen/Personen/Orte) sind bereits
 * deterministisch gemergt (mergeRueckblickFacets); dieser Call liefert nur noch
 * die synthetisierenden Teile — die über den ganzen Zeitraum bemerkenswertesten
 * Tage und die Fliesstext-Betrachtung. Nutzt NUR die Teilrückblicke; nichts Neues.
 * @param {Array<object>} partResults  je Teil ein SCHEMA_RUECKBLICK-Objekt + `monat` (Label)
 * @param {{ zeitraum:string, vorblick?:object, merged?:object }} opts  merged = mergeRueckblickFacets(partResults)
 */
export function buildRueckblickReducePrompt(partResults, { zeitraum, vorblick = null, merged = null } = {}) {
  const facets = merged || mergeRueckblickFacets(partResults);
  return `<aufgabe>
Aus den folgenden Teil-Rückblicken eines Zeitraums «${zeitraum}» sind die wiederkehrenden Themen,
Personen und Orte bereits final zusammengeführt (siehe <verdichtete_facetten>). Deine Aufgabe:
1. Wähle die über den GANZEN Zeitraum bemerkenswertesten Tage aus (nur Tage aus den Teilrückblicken).
2. Schreibe eine zusammenfassende Betrachtung (2–4 Absätze) des gesamten Zeitraums.
Nutze NUR Informationen aus den Teilrückblicken und den verdichteten Facetten; füge nichts hinzu.
Gib die Facetten NICHT erneut aus — sie sind bereits final.
</aufgabe>
${RUECKBLICK_CONSTRAINT}${_vorblickBlock(vorblick)}
${RUECKBLICK_SYNTH_OUTPUT}
<verdichtete_facetten zeitraum="${zeitraum}">
${_formatMergedFacets(facets)}
</verdichtete_facetten>
<monats_teilrueckblicke zeitraum="${zeitraum}" teile="${(partResults || []).length}">
${_formatMonthSummaries(partResults)}
</monats_teilrueckblicke>${_jsonOnly()}`;
}

// ── Schema ─────────────────────────────────────────────────────────────────────

const _themaItem = _obj({
  label:       _str,
  haeufigkeit: _num,
  belege:      { type: 'array', items: _str },
});

const _nennungItem = _obj({
  name:        _str,
  haeufigkeit: _num,
  belege:      { type: 'array', items: _str },
});

const _tagItem = _obj({
  datum:       _str,
  begruendung: _str,
});

export const SCHEMA_RUECKBLICK = _obj({
  themen:              { type: 'array', items: _themaItem },
  personen:            { type: 'array', items: _nennungItem },
  orte:                { type: 'array', items: _nennungItem },
  bemerkenswerteTage:  { type: 'array', items: _tagItem },
  zusammenfassung:     _str,
});

// Reduzierte Ausgabe des Reduce-/Synthese-Passes (Facetten kommen deterministisch
// aus mergeRueckblickFacets, nicht vom Modell).
export const SCHEMA_RUECKBLICK_SYNTH = _obj({
  bemerkenswerteTage:  { type: 'array', items: _tagItem },
  zusammenfassung:     _str,
});
