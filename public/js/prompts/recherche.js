// Recherche-Verknüpfungs-Resolver: ordnet einen Recherche-Schnipsel (Notiz,
// Zitat, Faktensplitter, Link) den passenden bereits existierenden Buch-
// Entitäten zu (Figuren/Orte/Szenen/Plot-Beats). Rein rückwärtsgewandt — liest
// vorhandene Entitäten + Schnipseltext, generiert keinen Buchtext und schlägt
// NIEMALS neue Entitäten vor. Die KI darf ausschliesslich IDs aus der
// gelieferten Kandidatenliste zurückgeben; alles andere wird verworfen.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildSystemResearchLink() {
  return `Du bist ein Verknüpfungs-Assistent für ein Recherche-Archiv eines Buchprojekts. Du bekommst einen Recherche-Schnipsel (Notiz, Zitat, Fakt oder Link) und Listen bereits existierender Buch-Entitäten: Figuren, Schauplätze, Szenen und Plot-Abschnitte. Jede Entität hat eine id.

Deine Aufgabe: bestimme, auf welche dieser Entitäten sich der Schnipsel bezieht — also wo diese Recherche beim Schreiben relevant wäre.

Regeln:
- Gib NUR Verknüpfungen zurück, deren id exakt in den gelieferten Listen steht. Erfinde keine ids und keine neuen Entitäten.
- Verknüpfe nur bei klarem inhaltlichem Bezug (genannte Figur, beschriebener Ort, thematisch passende Szene). Im Zweifel weglassen — lieber wenige präzise Treffer als viele vage.
- Eine Entität höchstens einmal.
- «art» ist die Kategorie der Entität: «figur», «ort», «szene» oder «beat».
- «grund» ist eine sehr kurze Begründung (wenige Wörter), warum der Schnipsel zu dieser Entität passt.${_jsonOnly()}`;
}

export function buildResearchLinkPrompt(snippet, candidates) {
  const block = (label, arr) => {
    if (!arr || !arr.length) return `${label}: (keine)`;
    return `${label}:\n` + arr.map(c => `- id=${c.id}: ${c.label}`).join('\n');
  };
  const parts = [
    block('Figuren', candidates.figur),
    block('Schauplätze', candidates.ort),
    block('Szenen', candidates.szene),
    block('Plot-Abschnitte', candidates.beat),
  ].join('\n\n');
  const snip = [snippet.title, snippet.body, snippet.source, snippet.url]
    .filter(Boolean).join('\n').slice(0, 4000);
  return `Recherche-Schnipsel:
"""
${snip}
"""

Vorhandene Buch-Entitäten (nur aus diesen darfst du ids wählen):

${parts}

Antworte mit diesem JSON-Schema:
{
  "links": [
    { "art": "figur|ort|szene|beat", "id": "exakt eine id von oben", "grund": "kurze Begründung" }
  ]
}
Gib ein leeres "links"-Array zurück, wenn keine Entität klar passt.`;
}

export const SCHEMA_RESEARCH_LINK = _obj({
  links: {
    type: 'array',
    items: _obj({ art: _str, id: _str, grund: _str }),
  },
});
