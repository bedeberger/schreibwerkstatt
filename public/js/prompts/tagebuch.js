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

// Formatiert die gefilterten Einträge für den Single-Pass-Call: ein Block pro
// Tag mit Datum-Header, damit das Modell Belege zeichengenau zuordnen kann.
function _formatEntries(entries) {
  return entries
    .map(e => `### ${e.datum}${e.titel && e.titel !== e.datum ? ` – ${e.titel}` : ''}\n${e.text}`)
    .join('\n\n---\n\n');
}

function _kontextBlock(figurenNamen, orteNamen) {
  const parts = [];
  if (figurenNamen?.length) {
    parts.push(`Bekannte Figuren dieses Buchs (nutze diese Schreibweise, wenn eine Person gemeint ist): ${figurenNamen.join(', ')}`);
  }
  if (orteNamen?.length) {
    parts.push(`Bekannte Orte dieses Buchs: ${orteNamen.join(', ')}`);
  }
  if (!parts.length) return '';
  return `\n<kontext>\n${parts.join('\n')}\n</kontext>`;
}

/**
 * Single-Pass-Rückblick über alle gefilterten Einträge eines Zeitraums.
 * @param {Array<{datum:string, titel:string, text:string}>} entries
 * @param {{ zeitraum:string, figurenNamen?:string[], orteNamen?:string[] }} opts
 */
export function buildRueckblickPrompt(entries, { zeitraum, figurenNamen = [], orteNamen = [] } = {}) {
  return `<aufgabe>
Erstelle einen rückwärtsgewandten Rückblick über die Tagebuch-Einträge des Zeitraums «${zeitraum}».
Verdichte das Geschriebene zu wiederkehrenden Themen, Personen, Orten und bemerkenswerten Tagen
sowie einer zusammenfassenden Betrachtung. Du bewertest nicht und schreibst nicht weiter.
</aufgabe>
${RUECKBLICK_CONSTRAINT}${_kontextBlock(figurenNamen, orteNamen)}
${RUECKBLICK_OUTPUT}
<eintraege zeitraum="${zeitraum}" anzahl="${entries.length}">
${_formatEntries(entries)}
</eintraege>${_jsonOnly()}`;
}

// Formatiert die Monats-Teilergebnisse für den Reduce-Call.
function _formatMonthResults(monthResults) {
  return monthResults.map(m => {
    const themen = (m.themen || []).map(t => `${t.label} (${t.haeufigkeit}×; ${(t.belege || []).join(', ')})`).join('; ') || '–';
    const personen = (m.personen || []).map(p => `${p.name} (${p.haeufigkeit}×; ${(p.belege || []).join(', ')})`).join('; ') || '–';
    const orte = (m.orte || []).map(o => `${o.name} (${o.haeufigkeit}×; ${(o.belege || []).join(', ')})`).join('; ') || '–';
    const tage = (m.bemerkenswerteTage || []).map(t => `${t.datum}: ${t.begruendung}`).join(' | ') || '–';
    return `## Monat ${m.monat}\nThemen: ${themen}\nPersonen: ${personen}\nOrte: ${orte}\nBemerkenswerte Tage: ${tage}\nZusammenfassung: ${m.zusammenfassung || '–'}`;
  }).join('\n\n');
}

/**
 * Reduce-Pass: konsolidiert pro Monat erzeugte Teilergebnisse zu einem
 * Gesamt-Rückblick über den Zeitraum (Jahr). Nur Aggregation der Belege —
 * keine neuen Aussagen über die Teilergebnisse hinaus.
 * @param {Array<object>} monthResults  je Monat ein SCHEMA_RUECKBLICK-Objekt + `monat`
 * @param {{ zeitraum:string }} opts
 */
export function buildRueckblickReducePrompt(monthResults, { zeitraum } = {}) {
  return `<aufgabe>
Konsolidiere die folgenden Monats-Teilrückblicke zu EINEM Gesamt-Rückblick über den Zeitraum «${zeitraum}».
Führe gleiche Themen/Personen/Orte zusammen und summiere ihre Häufigkeiten. Wähle die über den
ganzen Zeitraum bemerkenswertesten Tage aus. Erzeuge eine zusammenfassende Betrachtung des gesamten
Zeitraums. Nutze NUR Informationen aus den Teilrückblicken; füge nichts hinzu.
</aufgabe>
${RUECKBLICK_CONSTRAINT}
${RUECKBLICK_OUTPUT}
<monats_teilrueckblicke zeitraum="${zeitraum}" monate="${monthResults.length}">
${_formatMonthResults(monthResults)}
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
