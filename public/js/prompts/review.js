// Buch-/Kapitel-Review-Prompts und ihre Schemas. Statisch (nicht _isLocal-abhängig).

import { _obj, _str, _num } from './schema-utils.js';
import { _buildErzaehlformBlock } from './blocks.js';

// Verbindlicher Notenanker. Verhindert Drift zur Mitte (4.0–4.5) und erzwingt
// achsenbasierte Begründung. Wird in beide Buchreview-Prompts eingebaut.
const NOTENSKALA_BLOCK = `
Notenskala (verbindlich – nicht abweichen):
- 1.0–2.5: handwerklich mangelhaft – Plot, Stil oder Konsistenz gravierend defekt.
- 3.0–3.5: Idee tragfähig, Umsetzung schwach.
- 4.0:     solide Genreprosa, ohne herausstechende Stärke.
- 4.5:     gut, klare Stärken in mind. zwei Achsen (Plot / Figuren / Dramaturgie / Pacing / Stil / Thema).
- 5.0:     sehr gut, marktfähig.
- 5.5–6.0: ausgezeichnet bis herausragend.
- Eine Note über 4.5 verlangt eine konkrete Stärke pro Achse; ohne → maximal 4.5.
- Halbschritte (.0, .5) bevorzugen; .25 / .75 nur wenn die Bewertung klar zwischen zwei Stufen liegt.`;

// Bewertungsachsen pro Scope. Werden über `_buildAchsenBlock()` zu einem
// Prompt-Block geformt – Buch- und Kapitel-Review nutzen denselben Generator,
// damit das Achsen-Vokabular konsistent bleibt.
const BOOK_PROMPT_AXES = [
  { key: 'struktur',    hint: 'Aufbau, Kapitelgliederung, Übergänge, Logik der Abfolge.' },
  { key: 'stil',        hint: 'Sprache, Satzbau, Ton, Konsistenz über das Buch.' },
  { key: 'plot',        hint: 'Konflikt, Stakes, Wendepunkte, Auflösung. Wenn Buch sachlich/lyrisch: stattdessen Argumentationsgang / Bildlogik.' },
  { key: 'figuren',     hint: 'Hauptfiguren-Bogen, Nebenfiguren, Stimmigkeit und Entwicklung über das Buch hinweg.' },
  { key: 'dramaturgie', hint: 'Spannungskurve über die Kapitel, Aufbau, Höhepunkte, Schluss.' },
  { key: 'pacing',      hint: 'Tempo, Längen, Mittelteil-Loch, Rhythmus über das Buch.' },
  { key: 'thema',       hint: 'Roter Faden, durchgehende Frage / Idee, Konsequenz der Verfolgung.' },
];
const BOOK_PROMPT_GEWICHTUNG = 'Plot, Figuren, Dramaturgie und Stil tragen die Gesamtnote stärker als Mikro-Mängel oder einzelne Stellen.';

const CHAPTER_PROMPT_AXES = [
  { key: 'dramaturgie', hint: 'Spannungsbogen, Szenenabfolge, Aufbau, Höhepunkte.' },
  { key: 'pacing',      hint: 'Tempo, Längen, Leerlauf, Szenenrhythmus.' },
  { key: 'kohaerenz',   hint: 'Roter Faden, Übergänge zwischen Seiten/Szenen, Logik der Handlung.' },
  { key: 'perspektive', hint: 'Erzählperspektive und Konsistenz innerhalb des Kapitels.' },
  { key: 'figuren',     hint: 'Auftreten der Figuren im Kapitel, Stimmigkeit, Entwicklung.' },
];
const CHAPTER_PROMPT_GEWICHTUNG = 'Dramaturgie, Pacing und Kohärenz sind die zentralen Bewertungskriterien dieses Kapitels und fliessen stärker in die Gesamtnote ein als sprachliche Einzelmängel.';

function _buildAchsenBlock(axes, gewichtung) {
  const pad = Math.max(...axes.map(a => a.key.length)) + 1;
  const lines = axes.map(a => `- ${a.key}:${' '.repeat(pad - a.key.length)}${a.hint}`).join('\n');
  return `
Bewertungsachsen (alle ${axes.length} zwingend, je 2–5 Sätze, konkret und am Text belegt):
${lines}

GEWICHTUNG: ${gewichtung}`;
}

const ACHSEN_BLOCK_BOOK    = _buildAchsenBlock(BOOK_PROMPT_AXES,    BOOK_PROMPT_GEWICHTUNG);
const ACHSEN_BLOCK_CHAPTER = _buildAchsenBlock(CHAPTER_PROMPT_AXES, CHAPTER_PROMPT_GEWICHTUNG);

// Format-Block für die strukturierten Empfehlungen + Zitatbelege. Wird in
// Buch- und Kapitelreview-Prompts geteilt, damit die Schemas konsistent bleiben.
const EMPFEHLUNGEN_FORMAT_BLOCK = `
Empfehlungen – Format & Priorisierung:
- Jede Empfehlung ist ein Objekt { "prio": "hoch"|"mittel"|"niedrig", "kategorie": "plot"|"figuren"|"stil"|"struktur"|"dramaturgie"|"pacing"|"thema"|"perspektive"|"kohaerenz"|"mikro", "text": "konkrete Handlungsanweisung" }.
- "hoch": Eingriff, ohne den das Buch in zentralen Achsen nicht trägt (Plot-Logik, Figurenbogen, struktureller Bruch). Maximal so viele "hoch" wie wirklich gravierend.
- "mittel": klare Verbesserung mit spürbarem Effekt, aber das Buch trägt auch ohne sie.
- "niedrig": Feinschliff / Quick-Win (einzelne Stilstellen, Dopplungen, Mikro-Mängel).
- "text" ist eine Handlungsanweisung an den Autor (was tun), nicht eine erneute Beschreibung der Schwäche.
- 4–8 Empfehlungen insgesamt, sortiert nach Priorität (hoch zuerst). Keine Doppelungen zu staerken/schwaechen.

Beispielzitate – Format:
- Jedes Beispiel ist ein Objekt { "kind": "staerke"|"schwaeche", "zitat": "zeichengenaue Stelle aus dem Buch", "kommentar": "ein Satz: was die Stelle zeigt" }.
- 2–4 Zitate insgesamt, davon mindestens eines vom Typ "staerke" und eines "schwaeche" (sofern beide ableitbar).
- "zitat" MUSS wörtlich, zeichengenau, aus dem vorliegenden Buchtext stammen. Keine Paraphrase, keine Erfindung. Wenn ein passendes Zitat nicht zu finden ist: Eintrag weglassen, nicht erfinden.
- "kommentar" benennt knapp, wozu das Zitat steht (z.B. "verdichtet Atmosphäre in zwei Bildern", "Telling statt Showing", "Klischee").`;

const KAPITELANALYSE_FORMAT_BLOCK = `
Format der Kapitelanalyse (alle Felder ausfüllen, jeweils 1–2 Sätze, knapp und konkret):
- themen:           Hauptthemen und Inhalte.
- stil:             Schreibstilbeobachtungen (Wortwahl, Satzbau, Ton); bei vorgegebener Erzählform kurz Konsistenz beurteilen.
- qualitaet:        Allgemeiner Qualitätseindruck.
- dramaturgie_kurz: Spannungskurve im Kapitel (Aufbau, Höhepunkt, Schluss).
- figuren_kurz:     Welche Figuren tragen das Kapitel, wie verändert sich ihre Position.
- pacing_kurz:      Tempo und Längen, Leerlauf vs. Verdichtung.`;

/**
 * Erzeugt den Buchtyp-Schwerpunkt-Block für Buchreview- und Kapitelreview-Prompts.
 * Übersteuert nicht die ACHSEN, sondern schärft, worauf das Modell je nach Genre
 * zusätzlich achten soll (z.B. Krimi: Logik der Auflösung).
 *
 * @param {string} schwerpunkt Text aus prompt-config.json buchtypen[lang][key].reviewSchwerpunkt
 * @returns {string} Block oder '' (wenn schwerpunkt leer)
 */
function _buildReviewSchwerpunktBlock(schwerpunkt) {
  const t = (schwerpunkt || '').trim();
  if (!t) return '';
  return `\nGenre-Schwerpunkt (zusätzlich zu den Achsen, nicht statt ihnen):\n${t}\n`;
}

/**
 * Baut den Strukturdaten-Block aus Komplettanalyse-Daten.
 * Erscheint nur, wenn mindestens eine Quelle Daten liefert.
 *
 * Wichtig: die Daten gelten als Wahrheit. Modell darf sich darauf beziehen
 * (z.B. "die Figurenkartei nennt Anna als Lehrerin – im Kap. 5 wird sie
 * Ärztin genannt"). Bei leeren Quellen wird der jeweilige Abschnitt weggelassen –
 * keine erfundenen Befunde.
 *
 * @param {{figuren:Array, beziehungen:Array, continuityIssues:Array, zeitstrahl:Array}} ctx
 * @returns {string} Block oder '' (wenn alle Buckets leer)
 */
function _buildKomplettContextBlock(ctx) {
  if (!ctx) return '';
  const parts = [];

  if (ctx.figuren?.length) {
    const lines = ctx.figuren.map(f => {
      const head = [f.name, f.kurzname && f.kurzname !== f.name ? `«${f.kurzname}»` : null].filter(Boolean).join(' ');
      const attrs = [f.typ, f.geschlecht, f.beruf].filter(Boolean).join(', ');
      const desc = f.beschreibung ? ` – ${f.beschreibung}` : '';
      return `- ${head}${attrs ? ` (${attrs})` : ''}${desc}`;
    });
    parts.push(`Figurenkartei (Stamm, verbindliche Wahrheit über das Buch):\n${lines.join('\n')}`);
  }

  if (ctx.beziehungen?.length) {
    const lines = ctx.beziehungen.map(b => {
      const desc = b.beschreibung ? ` – ${b.beschreibung}` : '';
      return `- ${b.von} → ${b.zu}: ${b.typ}${desc}`;
    });
    parts.push(`Soziogramm (Figurenbeziehungen):\n${lines.join('\n')}`);
  }

  if (ctx.continuityIssues?.length) {
    const lines = ctx.continuityIssues.map(i => {
      const kap = i.kapitel?.length ? ` [${i.kapitel.join(' / ')}]` : '';
      const fig = i.figuren?.length ? ` (Figuren: ${i.figuren.join(', ')})` : '';
      return `- ${i.schwere || '–'} | ${i.typ || '–'}${kap}: ${i.beschreibung}${fig}`;
    });
    parts.push(`Kontinuitäts-Befunde aus der letzten Komplettanalyse (Plot-Logik nicht ignorieren):\n${lines.join('\n')}`);
  }

  if (ctx.zeitstrahl?.length) {
    const lines = ctx.zeitstrahl.map(e => {
      const kap = e.kapitel ? ` [${e.kapitel}]` : '';
      const typ = e.typ ? ` (${e.typ})` : '';
      return `- ${e.datum || '?'}${typ}${kap}: ${e.ereignis}`;
    });
    parts.push(`Globaler Zeitstrahl (Reihenfolge der wichtigen Ereignisse):\n${lines.join('\n')}`);
  }

  if (!parts.length) return '';
  return `
=== STRUKTURDATEN AUS DER KOMPLETTANALYSE (verbindlich) ===
Wo Aussagen im Buchtext den folgenden Strukturdaten widersprechen, beziehe dich in
"plot" oder "figuren" konkret auf die widersprüchliche Stelle und nenne die
Kartei-Wahrheit. Wo die Strukturdaten schweigen, NICHT raten.

${parts.join('\n\n')}
=== ENDE STRUKTURDATEN ===
`;
}

export function buildBookReviewSinglePassPrompt(bookName, pageCount, bookText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, reviewSchwerpunkt = '', komplettContext = null } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const schwerpunktBlock = _buildReviewSchwerpunktBlock(reviewSchwerpunkt);
  const kontextBlock = _buildKomplettContextBlock(komplettContext);
  return `<aufgabe>
Bewerte das folgende Buch «${bookName}» kritisch und umfassend.
</aufgabe>
${ACHSEN_BLOCK_BOOK}
${NOTENSKALA_BLOCK}
${EMPFEHLUNGEN_FORMAT_BLOCK}
${schwerpunktBlock}${povBlock}${kontextBlock}
<output_format>
Antworte mit diesem JSON-Schema:
{
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz warum diese Note (gesamtnote als Dezimalzahl von 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte bevorzugt) – muss sich auf die unten gefüllten Achsen stützen",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur":    "Aufbau und Gliederung (2-4 Sätze)",
  "stil":        "Schreibstil und Konsistenz (2-4 Sätze) – falls eine Erzählform vorgegeben ist: kurz beurteilen, ob Perspektive und Zeit über das Buch hinweg konsistent gehalten werden",
  "plot":        "Konflikt, Stakes, Wendepunkte, Auflösung über das ganze Buch (3-5 Sätze)",
  "figuren":     "Hauptfiguren-Bogen, Nebenfiguren, Stimmigkeit über das Buch (3-5 Sätze)",
  "dramaturgie": "Spannungskurve, Aufbau, Höhepunkte, Schluss (2-4 Sätze)",
  "pacing":      "Tempo, Längen, Mittelteil, Rhythmus (2-3 Sätze)",
  "thema":       "Roter Faden, zentrale Frage / Idee, Konsequenz der Verfolgung (2-3 Sätze)",
  "staerken":    ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen":  ["Schwäche 1", "Schwäche 2"],
  "empfehlungen":[
    { "prio": "hoch",    "kategorie": "plot",    "text": "konkrete Handlungsanweisung an den Autor" },
    { "prio": "mittel",  "kategorie": "stil",    "text": "…" },
    { "prio": "niedrig", "kategorie": "mikro",   "text": "…" }
  ],
  "beispielzitate":[
    { "kind": "staerke",  "zitat": "wörtlich aus dem Text", "kommentar": "was diese Stelle zeigt" },
    { "kind": "schwaeche","zitat": "wörtlich aus dem Text", "kommentar": "was diese Stelle zeigt" }
  ],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}
</output_format>
<buchinhalt seiten="${pageCount}">
${bookText}
</buchinhalt>`;
}

export function buildChapterAnalysisPrompt(chapterName, bookName, pageCount, chText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  return `<aufgabe>
Analysiere das Kapitel «${chapterName}» aus dem Buch «${bookName}».
Lies den vollständigen Kapiteltext und gib eine kompakte Analyse als JSON zurück.
Die Ausgabe dient als Eingabe für eine Buchebene-Synthese – sie MUSS deshalb auch
Dramaturgie, Figuren und Pacing knapp benennen (nicht nur Themen/Stil).
</aufgabe>
${KAPITELANALYSE_FORMAT_BLOCK}
${povBlock}
<output_format>
Antworte mit diesem JSON-Schema:
{
  "themen": "Hauptthemen und Inhalte in 1-2 Sätzen",
  "stil": "Schreibstilbeobachtungen: Wortwahl, Satzbau, Ton in 1-2 Sätzen – falls eine Erzählform vorgegeben ist, kurz beurteilen, ob das Kapitel diese konsistent einhält",
  "qualitaet": "Allgemeiner Qualitätseindruck in 1-2 Sätzen",
  "dramaturgie_kurz": "Spannungskurve im Kapitel: Aufbau, Höhepunkt, Schluss (1-2 Sätze)",
  "figuren_kurz": "Welche Figuren tragen das Kapitel, wie verschiebt sich ihre Position (1-2 Sätze)",
  "pacing_kurz": "Tempo und Längen, Leerlauf vs. Verdichtung (1 Satz)",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"]
}
</output_format>
<kapitelinhalt seiten="${pageCount}">
${chText}
</kapitelinhalt>`;
}

// Kapitel-Review: makro-kritische Bewertung eines einzelnen Kapitels.
// Fokus: Dramaturgie, Pacing, Kohärenz, Perspektive, Figuren – Dinge, die
// beim Seiten-Lektorat (Mikro-Fehler) und bei der Buchbewertung (Gesamtnote)
// naturgemäss nicht erfasst werden.
export function buildChapterReviewPrompt(chapterName, bookName, pageCount, chText, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, reviewSchwerpunkt = '' } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const schwerpunktBlock = _buildReviewSchwerpunktBlock(reviewSchwerpunkt);
  return `Bewerte das Kapitel «${chapterName}» aus dem Buch «${bookName}» kritisch und umfassend.
Der Fokus liegt auf seitenübergreifenden Qualitäten – nicht auf Mikro-Fehlern (dafür gibt es das Seiten-Lektorat).
${ACHSEN_BLOCK_CHAPTER}
${NOTENSKALA_BLOCK}
${EMPFEHLUNGEN_FORMAT_BLOCK}
${schwerpunktBlock}${povBlock}
Antworte mit diesem JSON-Schema:
{
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz warum diese Note (gesamtnote als Dezimalzahl von 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte bevorzugt) – muss sich auf die unten gefüllten Achsen stützen",
  "zusammenfassung": "2-3 Sätze Gesamteindruck dieses Kapitels",
  "dramaturgie": "Spannungsbogen, Szenenstruktur, Aufbau (3-4 Sätze)",
  "pacing": "Tempo, Längen, Leerlauf (2-3 Sätze)",
  "kohaerenz": "Roter Faden und Übergänge zwischen Seiten/Szenen (2-3 Sätze)",
  "perspektive": "Erzählperspektive und Konsistenz innerhalb des Kapitels (1-2 Sätze) – falls eine Erzählform vorgegeben ist: explizit beurteilen, ob das Kapitel ihr folgt oder davon abweicht",
  "figuren": "Auftreten und Stimmigkeit der Figuren in diesem Kapitel (2-3 Sätze)",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2", "konkrete Stärke 3"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"],
  "empfehlungen":[
    { "prio": "hoch",    "kategorie": "dramaturgie", "text": "konkrete Handlungsanweisung an den Autor" },
    { "prio": "mittel",  "kategorie": "stil",        "text": "…" },
    { "prio": "niedrig", "kategorie": "mikro",       "text": "…" }
  ],
  "beispielzitate":[
    { "kind": "staerke",  "zitat": "wörtlich aus dem Kapitel", "kommentar": "was diese Stelle zeigt" },
    { "kind": "schwaeche","zitat": "wörtlich aus dem Kapitel", "kommentar": "was diese Stelle zeigt" }
  ],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}

Kapitelinhalt (${pageCount} Seiten):

${chText}`;
}

export function buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, totalPageCount, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, reviewSchwerpunkt = '', komplettContext = null } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const schwerpunktBlock = _buildReviewSchwerpunktBlock(reviewSchwerpunkt);
  const kontextBlock = _buildKomplettContextBlock(komplettContext);
  const synthIn = chapterAnalyses.map((ca, i) => {
    const lines = [
      `## Kapitel ${i + 1}: ${ca.name} (${ca.pageCount} Seiten)`,
      `Themen: ${ca.themen || '–'}`,
      `Stil: ${ca.stil || '–'}`,
      `Qualität: ${ca.qualitaet || '–'}`,
      `Dramaturgie: ${ca.dramaturgie_kurz || '–'}`,
      `Figuren: ${ca.figuren_kurz || '–'}`,
      `Pacing: ${ca.pacing_kurz || '–'}`,
      `Stärken: ${(ca.staerken || []).join(' | ') || '–'}`,
      `Schwächen: ${(ca.schwaechen || []).join(' | ') || '–'}`,
    ];
    return lines.join('\n');
  }).join('\n\n');
  return `Bewerte das Buch «${bookName}» kritisch und umfassend.
Grundlage sind die Analysen aller ${chapterAnalyses.length} Kapitel (insgesamt ${totalPageCount} Seiten).
Leite Plot, Figurenbogen, Dramaturgie und Pacing aus der Abfolge der Kapitelanalysen ab –
auch wenn die einzelnen Kapitelausgaben kompakt sind, MUSS die Buchebene alle sechs Achsen
benennen. Wo eine Achse aus den Kapitelanalysen nicht ableitbar ist, dies offen benennen
("aus den Kapitelanalysen nicht eindeutig …") statt zu raten.
${ACHSEN_BLOCK_BOOK}
${NOTENSKALA_BLOCK}
${EMPFEHLUNGEN_FORMAT_BLOCK}
HINWEIS: Für "beispielzitate" stehen im Multi-Pass keine Volltexte zur Verfügung.
Wenn aus den Kapitelanalysen keine wörtlichen Zitate ableitbar sind, das Feld
"beispielzitate" auf [] setzen statt zu raten.
${schwerpunktBlock}${povBlock}${kontextBlock}
Kapitelanalysen:

${synthIn}

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz warum diese Note (gesamtnote als Dezimalzahl von 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte bevorzugt) – muss sich auf die unten gefüllten Achsen stützen",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur":    "Aufbau und Gliederung über alle Kapitel (3-5 Sätze)",
  "stil":        "Schreibstil und Konsistenz über das gesamte Buch (3-5 Sätze)",
  "plot":        "Konflikt, Stakes, Wendepunkte, Auflösung über alle Kapitel (3-5 Sätze)",
  "figuren":     "Hauptfiguren-Bogen, Nebenfiguren, Stimmigkeit über alle Kapitel (3-5 Sätze)",
  "dramaturgie": "Spannungskurve, Aufbau, Höhepunkte, Schluss über alle Kapitel (2-4 Sätze)",
  "pacing":      "Tempo, Längen, Mittelteil, Rhythmus über alle Kapitel (2-3 Sätze)",
  "thema":       "Roter Faden, zentrale Frage / Idee, Konsequenz der Verfolgung (2-3 Sätze)",
  "staerken":    ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen":  ["Schwäche 1", "Schwäche 2"],
  "empfehlungen":[
    { "prio": "hoch",    "kategorie": "plot",  "text": "konkrete Handlungsanweisung an den Autor" },
    { "prio": "mittel",  "kategorie": "stil",  "text": "…" },
    { "prio": "niedrig", "kategorie": "mikro", "text": "…" }
  ],
  "beispielzitate": [],
  "fazit":       "Abschliessendes Urteil in 1-3 Sätzen"
}`;
}

// Multi-Pass-Variante der Kapitelbewertung: wird verwendet, wenn ein einzelnes
// Kapitel das Input-Budget des Modells sprengt. Sub-Chunks wurden zuvor mit
// `buildChapterAnalysisPrompt` (SCHEMA_CHAPTER_ANALYSIS) analysiert und werden
// hier zu einer Kapitelbewertung (SCHEMA_CHAPTER_REVIEW) zusammengeführt.
export function buildChapterReviewMultiPassPrompt(chapterName, bookName, subAnalyses, totalPageCount, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null, reviewSchwerpunkt = '' } = {}) {
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const schwerpunktBlock = _buildReviewSchwerpunktBlock(reviewSchwerpunkt);
  const synthIn = subAnalyses.map((ca, i) => {
    const lines = [
      `## Abschnitt ${i + 1} (${ca.pageCount} Seiten)`,
      `Themen: ${ca.themen || '–'}`,
      `Stil: ${ca.stil || '–'}`,
      `Qualität: ${ca.qualitaet || '–'}`,
      `Dramaturgie: ${ca.dramaturgie_kurz || '–'}`,
      `Figuren: ${ca.figuren_kurz || '–'}`,
      `Pacing: ${ca.pacing_kurz || '–'}`,
      `Stärken: ${(ca.staerken || []).join(' | ') || '–'}`,
      `Schwächen: ${(ca.schwaechen || []).join(' | ') || '–'}`,
    ];
    return lines.join('\n');
  }).join('\n\n');
  return `Bewerte das Kapitel «${chapterName}» aus dem Buch «${bookName}» kritisch und umfassend.
Grundlage sind die Analysen von ${subAnalyses.length} Teilabschnitten des Kapitels (insgesamt ${totalPageCount} Seiten).
Leite Dramaturgie, Pacing, Kohärenz, Perspektive und Figurenführung aus der Abfolge der Teil-Analysen ab –
auch wenn die einzelnen Ausgaben kompakt sind, MUSS die Kapitelbewertung alle Achsen
benennen. Wo eine Achse aus den Teil-Analysen nicht ableitbar ist, dies offen benennen
("aus den Teil-Analysen nicht eindeutig …") statt zu raten.
${ACHSEN_BLOCK_CHAPTER}
${NOTENSKALA_BLOCK}
${EMPFEHLUNGEN_FORMAT_BLOCK}
HINWEIS: Für "beispielzitate" stehen im Multi-Pass keine Volltexte zur Verfügung.
Wenn aus den Teil-Analysen keine wörtlichen Zitate ableitbar sind, das Feld
"beispielzitate" auf [] setzen statt zu raten.
${schwerpunktBlock}${povBlock}
Teil-Analysen:

${synthIn}

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz warum diese Note (gesamtnote als Dezimalzahl von 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte bevorzugt) – muss sich auf die unten gefüllten Achsen stützen",
  "zusammenfassung": "2-3 Sätze Gesamteindruck dieses Kapitels",
  "dramaturgie": "Spannungsbogen, Szenenstruktur, Aufbau über alle Abschnitte (3-4 Sätze)",
  "pacing": "Tempo, Längen, Leerlauf über alle Abschnitte (2-3 Sätze)",
  "kohaerenz": "Roter Faden und Übergänge zwischen den Abschnitten (2-3 Sätze)",
  "perspektive": "Erzählperspektive und Konsistenz innerhalb des Kapitels (1-2 Sätze) – falls eine Erzählform vorgegeben ist: explizit beurteilen, ob das Kapitel ihr folgt oder davon abweicht",
  "figuren": "Auftreten und Stimmigkeit der Figuren über das Kapitel (2-3 Sätze)",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2", "konkrete Stärke 3"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"],
  "empfehlungen":[
    { "prio": "hoch",    "kategorie": "dramaturgie", "text": "konkrete Handlungsanweisung an den Autor" },
    { "prio": "mittel",  "kategorie": "stil",        "text": "…" },
    { "prio": "niedrig", "kategorie": "mikro",       "text": "…" }
  ],
  "beispielzitate": [],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}`;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const _empfehlungItem = _obj({
  prio:      { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
  kategorie: { type: 'string', enum: ['plot', 'figuren', 'stil', 'struktur', 'dramaturgie', 'pacing', 'thema', 'perspektive', 'kohaerenz', 'mikro'] },
  text:      _str,
});

const _zitatItem = _obj({
  kind:      { type: 'string', enum: ['staerke', 'schwaeche'] },
  zitat:     _str,
  kommentar: _str,
});

export const SCHEMA_REVIEW = _obj({
  gesamtnote: _num,
  gesamtnote_begruendung: _str,
  zusammenfassung: _str,
  struktur: _str,
  stil: _str,
  plot: _str,
  figuren: _str,
  dramaturgie: _str,
  pacing: _str,
  thema: _str,
  staerken: { type: 'array', items: _str },
  schwaechen: { type: 'array', items: _str },
  empfehlungen: { type: 'array', items: _empfehlungItem },
  beispielzitate: { type: 'array', items: _zitatItem },
  fazit: _str,
});

export const SCHEMA_CHAPTER_ANALYSIS = _obj({
  themen: _str,
  stil: _str,
  qualitaet: _str,
  dramaturgie_kurz: _str,
  figuren_kurz: _str,
  pacing_kurz: _str,
  staerken: { type: 'array', items: _str },
  schwaechen: { type: 'array', items: _str },
});

export const SCHEMA_CHAPTER_REVIEW = _obj({
  gesamtnote: _num,
  gesamtnote_begruendung: _str,
  zusammenfassung: _str,
  dramaturgie: _str,
  pacing: _str,
  kohaerenz: _str,
  perspektive: _str,
  figuren: _str,
  staerken: { type: 'array', items: _str },
  schwaechen: { type: 'array', items: _str },
  empfehlungen: { type: 'array', items: _empfehlungItem },
  beispielzitate: { type: 'array', items: _zitatItem },
  fazit: _str,
});
