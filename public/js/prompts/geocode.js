// Geocode-Resolver: normalisiert beschreibende/fiktive Schauplatz-Labels eines
// Buchs auf einen realen Karten-Anker (Toponym + ISO-3166-1-alpha-2-Land), bevor
// der externe Geocoder anlaeuft. Rein rueckwaertsgewandt — liest bestehende
// Ortslabels, generiert keinen Buchtext. KI-Fallback, wenn die regelbasierte
// Heuristik in lib/geocode.js (parseToponym + Zwei-Pass) keinen Treffer findet.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildSystemGeocodeResolve() {
  return `Du bist ein Geografie-Resolver fuer eine Buch-Schauplatzkarte. Du bekommst beschreibende oder erfundene Schauplatz-Labels aus einem Roman (z.B. «Bar in Olten», «Badi Olten», «Schuetzenmattstrasse Olten», «Hogwarts»). Deine Aufgabe: zu jedem Label die praeziseste REALE Geocoder-Anfrage bestimmen, mit der sich der Ort auf einer Weltkarte pinnen laesst.

Regeln:
- Gib die praeziseste reale Anfrage zurueck, die das Label hergibt — so genau wie moeglich, aber nie ungenauer als der reale Anker.
- BEHALTE echte geografische Bestandteile (Strasse, Quartier, Gemeinde, Stadt, Region). «Schuetzenmattstrasse Olten» → «Schuetzenmattstrasse, Olten» (die Strasse ist geografisch praezise).
- ENTFERNE nicht-geografische Beschreibungen (Bar, Badi, Cafe, Hotel, Restaurant, Schule, Spielplatz …), wenn sie keinen eigenen Geocoder-Treffer ergeben — der reale Anker bleibt der genannte Ort.
  - «Bar in Olten» → «Olten» (die Bar ist nur ein Detail in der realen Stadt Olten).
  - «Badi Olten» → «Olten» («Badi» = Badeanstalt, kein Toponym; Anker ist die Stadt Olten).
- Beruecksichtige regionale/umgangssprachliche Begriffe (CH-Deutsch: Badi = Badeanstalt, Beiz = Wirtschaft, …) und loese sie auf die genannte reale Ortschaft auf.
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
