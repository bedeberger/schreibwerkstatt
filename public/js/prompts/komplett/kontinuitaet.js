// Kontinuitätsprüfung: Namens-Disambiguierung, Kapitel-Fakten-Extraktion, Check + Single-Pass.
import { _buildErzaehlformBlock } from '../blocks.js';
import { FAKTEN_SCHEMA, FAKTEN_RULES, PROBLEME_SCHEMA, PROBLEME_RULES } from './schema-strings.js';

// ── Kontinuitätsprüfung ───────────────────────────────────────────────────────

// Figuren mit geteilten Namens-Tokens (z.B. zwei «Dieter») werden vom Modell
// sonst als dieselbe Person interpretiert und produzieren False-Positives in
// der Kontinuitätsprüfung. Wir listen Kollisionen explizit auf.
const _DISAMBIG_STOPWORDS = new Set([
  'herr', 'frau', 'dr', 'doktor', 'prof', 'professor', 'fräulein',
  'von', 'zu', 'van', 'der', 'die', 'das', 'den', 'dem', 'de', 'la',
]);
function _figurenNameCollisions(figurenKompakt) {
  if (!figurenKompakt || figurenKompakt.length < 2) return [];
  const byToken = new Map();
  for (const f of figurenKompakt) {
    const seen = new Set();
    const tokens = String(f.name || '')
      .toLowerCase()
      .split(/[\s\-.,]+/)
      .filter(t => t.length > 1 && !_DISAMBIG_STOPWORDS.has(t));
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(f);
    }
  }
  const collisions = [];
  const seenGroups = new Set();
  for (const [token, figs] of byToken) {
    if (figs.length < 2) continue;
    const key = figs.map(f => f.name).sort().join('|');
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    collisions.push({ token, figuren: figs });
  }
  return collisions;
}
function _buildDisambiguationBlock(figurenKompakt) {
  const collisions = _figurenNameCollisions(figurenKompakt);
  if (!collisions.length) return '';
  const lines = collisions.map(c =>
    `- Namens-Token «${c.token}» teilen: ${c.figuren.map(f => `«${f.name}»`).join(', ')}`
  ).join('\n');
  return `\n\n## Namens-Disambiguierung
Folgende Figuren teilen Namens-Token (typischerweise Vornamen). Sie sind UNTERSCHIEDLICHE Personen:
${lines}

Eine kontextfreie Erwähnung nur des geteilten Tokens (z.B. «Dieter») kann jede dieser Figuren meinen. Übertrage Eigenschaften, Aufenthalte, Ereignisse einer Figur NICHT auf die andere. Melde keinen Widerspruch, wenn die Zuordnung im Text mehrdeutig bleibt.`;
}

export function buildKontinuitaetChapterFactsPrompt(chapterName, chText) {
  return `Extrahiere alle konkreten Fakten und Behauptungen aus dem Kapitel «${chapterName}» die für die Kontinuitätsprüfung relevant sind: Figuren-Zustände (lebendig/tot, Verletzungen, Wissen, Beziehungen), Ortsbeschreibungen, Zeitangaben, Objekte und deren Besitz/Zustand, sowie wichtige Handlungsereignisse.

Antworte mit diesem JSON-Schema:
{
  ${FAKTEN_SCHEMA}
}

${FAKTEN_RULES}

Kapiteltext:

${chText}`;
}

export function buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt) {
  const factsText = chapterFacts.map(cf =>
    `## ${cf.kapitel}\n` + cf.fakten.map(f => `[${f.kategorie}] ${f.subjekt}: ${f.fakt}${f.seite ? ` (${f.seite})` : ''}`).join('\n')
  ).join('\n\n');

  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\n## Bekannte Figuren\n' + figurenKompakt.map(f => `${f.name} (${f.typ}): ${f.beschreibung || ''}`).join('\n')
    : '';
  const disambigStr = _buildDisambiguationBlock(figurenKompakt);
  const orteStr = orteKompakt && orteKompakt.length
    ? '\n\n## Bekannte Schauplätze\n' + orteKompakt.map(o => `${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}`).join('\n')
    : '';

  return `Prüfe das Buch «${bookName}» auf Kontinuitätsfehler und Widersprüche. Dir liegen die extrahierten Fakten aller Kapitel vor.${figurenStr}${disambigStr}${orteStr}

## Extrahierte Fakten nach Kapitel:

${factsText}

Suche nach Widersprüchen: Fakten, die sich gegenseitig ausschliessen oder nicht vereinbar sind. Beispiele: Figur stirbt in Kapitel 3 aber erscheint in Kapitel 7; Ort wird in Kap. 2 als verlassen beschrieben, in Kap. 5 als belebt; Figur weiss etwas, das sie noch nicht wissen konnte.

Prüfe zusätzlich die Soziolekt-Kohärenz: Spricht jede Figur konsistent mit der Herkunft, Bildung und sozialen Schicht, die in früheren Kapiteln durch ihren Soziolekt etabliert wurde? Registerwechsel (z.B. plötzlich formal statt umgangssprachlich, plötzlich Dialekt statt Hochsprache) die sich nicht durch die Situation oder dramaturgischen Kontext erklären lassen, sind Kontinuitätsfehler. Typ «soziolekt» verwenden.

Antworte mit diesem JSON-Schema:
${PROBLEME_SCHEMA}

${PROBLEME_RULES}`;
}

// Verify-Stufe für den Multi-Pass-Check: Der Fakten-basierte Check (buildKontinuitaetCheckPrompt)
// sieht nur extrahierte Fakten, nicht den Volltext – auflösender Kontext (Rückblende, Ironie,
// Konjunktiv, indirekte Rede) ist dort bereits weg und erzeugt systematisch False-Positives.
// Diese Stufe lädt pro gemeldetem Problem die Original-Textstellen nach und lässt das Modell
// den Widerspruch mit echtem Kontext bestätigen oder verwerfen. Single-Pass braucht das nicht
// (hat den Volltext bereits beim Check).
export function buildKontinuitaetVerifyPrompt(bookName, problem, excerptA, excerptB) {
  return `Im Buch «${bookName}» wurde ein möglicher Kontinuitätsfehler gemeldet – auf Basis extrahierter Fakten, OHNE Originaltext. Prüfe anhand der echten Textstellen, ob der Widerspruch WIRKLICH besteht.

Gemeldeter Widerspruch (${problem.typ || 'sonstiges'}): ${problem.beschreibung || ''}
Stelle A: ${problem.stelle_a || ''}
Stelle B: ${problem.stelle_b || ''}

## Originaltext rund um Stelle A
${excerptA || '(im Text nicht gefunden)'}

## Originaltext rund um Stelle B
${excerptB || '(im Text nicht gefunden)'}

Berücksichtige auflösenden Kontext, der in reinen Fakten verloren geht: Rückblende/Vorausblende, Traum/Vorstellung/Wunsch, Ironie/Sarkasmus, Konjunktiv/Hypothese («hätte», «wäre»), indirekte oder zitierte Rede, unzuverlässiger Erzähler, zwei verschiedene Figuren mit ähnlichem Namen, bewusste erzählerische Wiederholung. Löst der Kontext den scheinbaren Widerspruch auf, ist es KEIN echter Fehler (bestaetigt=false). Im Zweifel – wenn der Kontext den Widerspruch nicht klar auflöst – bestaetigt=true.

Antworte mit diesem JSON-Schema:
{
  "bestaetigt": true,
  "grund": "1 Satz: warum der Widerspruch echt ist bzw. durch welchen Kontext er sich auflöst"
}`;
}

export function buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null } = {}) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\n## Bekannte Figuren\n' + figurenKompakt.map(f => `${f.name} (${f.typ || ''}): ${f.beschreibung || ''}`).join('\n')
    : '';
  const disambigStr = _buildDisambiguationBlock(figurenKompakt);
  const orteStr = orteKompakt && orteKompakt.length
    ? '\n\n## Bekannte Schauplätze\n' + orteKompakt.map(o => `${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}`).join('\n')
    : '';
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const erzaehlformHint = (erzaehlperspektive || erzaehlzeit) && buchtyp !== 'kurzgeschichten'
    ? ' Erzählform-Brüche: Kapitel oder Passagen, die die oben angegebene Erzählperspektive oder Erzählzeit unbegründet verlassen (Wechsel nur an Szenen-/Kapitelgrenzen oder bei expliziten Rückblenden zulässig) – typ «sonstiges», Beschreibung: «Erzählform-Bruch: …».'
    : '';

  const textBlock = bookText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `Buchtext:\n\n${bookText}`;
  return `Prüfe das Buch «${bookName}» auf Kontinuitätsfehler und Widersprüche.${figurenStr}${disambigStr}${orteStr}
${povBlock}
Suche aktiv nach: Figuren die nach ihrem Tod wieder auftauchen; Orte die sich widersprüchlich beschrieben werden; Zeitangaben die nicht vereinbar sind; Objekte die falsch verwendet werden; Figuren die Wissen haben das sie noch nicht haben könnten; Charakterverhalten das ihrer etablierten Persönlichkeit widerspricht; Soziolekt-Brüche: Figuren die plötzlich anders sprechen als durch ihre Herkunft, Bildung und soziale Schicht etabliert (Registerwechsel ohne dramaturgische Begründung).${erzaehlformHint}

${textBlock}

Antworte mit diesem JSON-Schema:
${PROBLEME_SCHEMA}

${PROBLEME_RULES}`;
}
