// Geocode-Resolver: normalisiert beschreibende/fiktive Schauplatz-Labels eines
// Buchs auf einen realen Karten-Anker (Toponym + ISO-3166-1-alpha-2-Land), bevor
// der externe Geocoder anlaeuft. Rein rueckwaertsgewandt — liest bestehende
// Ortslabels, generiert keinen Buchtext. KI-Fallback, wenn die regelbasierte
// Heuristik in lib/geocode.js (parseToponym + Zwei-Pass) keinen Treffer findet.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildSystemGeocodeResolve() {
  return `Du bist ein Geografie-Resolver fuer eine Buch-Schauplatzkarte. Du bekommst beschreibende oder erfundene Schauplatz-Labels aus einem Roman (z.B. «Bar in Olten», «Marktplatz von Bern», «Hogwarts»). Deine Aufgabe: zu jedem Label den wahrscheinlichsten REALEN Ort bestimmen, der auf einer Weltkarte gepinnt werden kann.

Regeln:
- Extrahiere den realen geografischen Anker aus dem Label. «Bar in Olten» → Ort «Olten» (die Bar ist nur ein Detail innerhalb der realen Stadt Olten).
- Gib einen sauberen, eindeutigen Toponym zurueck (Stadt/Gemeinde/Region/Land), wie ihn ein Geocoder findet — keine beschreibenden Zusaetze, keine Strassen-Details, wenn der Ort auch ohne sie eindeutig ist.
- Bestimme das Land als ISO-3166-1-alpha-2-Code (z.B. CH, DE, AT). Wenn unklar, leer lassen.
- Rein erfundene Orte ohne realen Anker (z.B. «Hogwarts», «Mittelerde»): «ort» leer lassen.
- Bei Mehrdeutigkeit den bekanntesten/groessten realen Ort waehlen; den Laender-Hinweis (falls gegeben) bevorzugen.${_jsonOnly()}`;
}

export function buildGeocodeResolvePrompt(items, regionHint) {
  const hint = regionHint ? `\nLaender-Hinweis des Buchs (bei Mehrdeutigkeit bevorzugen): ${regionHint}` : '';
  const list = items.map(it => `- id=${it.id}: ${it.name}`).join('\n');
  return `Bestimme zu jedem folgenden Schauplatz-Label den realen Karten-Anker.${hint}

Labels:
${list}

Antworte mit diesem JSON-Schema:
{
  "orte": [
    { "id": "exakt die id von oben", "ort": "realer Toponym oder leerer String", "land": "ISO-3166-1-alpha-2 oder leerer String" }
  ]
}`;
}

export const SCHEMA_GEOCODE_RESOLVE = _obj({
  orte: {
    type: 'array',
    items: _obj({ id: _str, ort: _str, land: _str }),
  },
});
