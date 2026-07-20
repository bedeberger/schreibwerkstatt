// Motiv-Werkstatt: planende KI-Assistenz. Job-Typ Brainstorm — die KI liest den
// Buchtext und schlägt WIEDERKEHRENDE Motive + übergeordnete Themen vor, die noch
// nicht katalogisiert sind. Rein rückwärtsgewandt/planend: findet Bestehendes im
// Text, schreibt NIE Prosa ins Manuskript. Der Autor bestätigt Vorschläge, erst
// dann werden sie zu themes/motifs.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildMotivSystemPrompt() {
  return `Du bist Lektorin und Literaturwissenschaftlerin. Du analysierst den vorliegenden Buchtext auf wiederkehrende MOTIVE (konkrete, sich wiederholende Bilder/Objekte/Gesten/Wörter wie Wasser, Spiegel, ein Lied) und übergeordnete THEMEN (abstrakte Ideen wie Schuld & Vergebung, Preis der Freiheit).

WICHTIG: Du identifizierst nur, was IM TEXT bereits angelegt ist — du erfindest keine Motive und schreibst NIEMALS Prosa oder Fortsetzungen. Deine Vorschläge sind kurze Katalog-Einträge, keine ausformulierten Passagen.${_jsonOnly()}`;
}

function _catalogLines(themes, motifs) {
  const t = (themes || []).map(x => `- Thema: ${x.name}`);
  const m = (motifs || []).map(x => `- Motiv: ${x.name}`);
  const all = [...t, ...m];
  return all.length ? all.join('\n') : '(noch keine)';
}

// text: zusammengefügter Buchtext (bereits aufs Budget gekürzt). existingThemes/
// existingMotifs: bereits katalogisierte Namen (NICHT erneut vorschlagen).
export function buildMotivBrainstormPrompt(text, existingThemes = [], existingMotifs = [], buchKontext = '') {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  return `Die Autorin möchte die Motiv- und Themenarbeit ihres Buches ausbauen. Analysiere den folgenden Text und schlage 4–8 wiederkehrende Motive und/oder übergeordnete Themen vor, die TATSÄCHLICH im Text angelegt sind, aber noch NICHT im Katalog stehen.
${ctxSeg}
BEREITS KATALOGISIERT (NICHT wiederholen):
${_catalogLines(existingThemes, existingMotifs)}

BUCHTEXT (Auszug):
${text}

Regeln:
- Jeder Vorschlag ist entweder ein "thema" (abstrakte Idee) oder ein "motiv" (konkretes, wiederkehrendes Element).
- Nur was im Text belegbar wiederkehrt — keine Erfindungen, keine generische Literatur-Theorie.
- Für Motive: liefere 2–6 wörtliche Trigger-Begriffe (Wörter/Wortstämme, die im Text auf das Motiv hindeuten), für Themen ein leeres Array.
- Keine Dubletten zum Katalog, keine ausformulierte Prosa.

Antworte mit diesem JSON-Schema:
{
  "vorschlaege": [
    { "typ": "motiv", "name": "kurzer Name", "beschreibung": "1 Satz: wofür es steht / wie es im Text auftritt", "trigger_terms": ["Wort", "Wort"] }
  ]
}`;
}

export const SCHEMA_MOTIV_BRAINSTORM = _obj({
  vorschlaege: {
    type: 'array',
    items: _obj({
      typ: _str,
      name: _str,
      beschreibung: _str,
      trigger_terms: { type: 'array', items: _str },
    }),
  },
});
