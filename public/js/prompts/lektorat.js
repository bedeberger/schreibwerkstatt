// Lektorat-Prompts (Einzel- und Batch-Variante) + Stilkorrektur.
// Schema SCHEMA_LEKTORAT ist _isLocal-abhängig und wird via _rebuildLektoratSchema()
// nach configurePrompts() neu gebaut.

import { _isLocal } from './state.js';
import { _obj, _str, _num } from './schema-utils.js';
import {
  _buildStilBlock,
  _buildWiederholungBlock,
  _buildSchwacheVerbenBlock,
  _buildFuellwortBlock,
  _buildFilterwortBlock,
  _buildKlischeeBlock,
  _buildPleonasmusBlock,
  _buildFigurenkonsistenzBlock,
  _buildSchauplatzkonsistenzBlock,
  _buildShowVsTellBlock,
  _buildDialogformatBlock,
  _buildPassivBlock,
  _buildPerspektivbruchBlock,
  _buildTempuswechselBlock,
  _buildErzaehlformBlock,
  _buildAiSmellBlock,
} from './blocks.js';
import { STOPWORDS, ERKLAERUNG_RULE, KORREKTUR_REGELN } from './core.js';

function _buildLektoratPromptBody(text, textLabel, {
  stopwords = STOPWORDS,
  erklaerungRule = ERKLAERUNG_RULE,
  korrekturRegeln = KORREKTUR_REGELN,
  figuren = [],
  figurenBeziehungen = [],
  orte = [],
  pageName = null,
  chapterName = null,
  erzaehlperspektive = null,
  erzaehlzeit = null,
  buchtyp = null,
  previousExcerpt = null,
  langCode = 'de',
} = {}) {
  const metaParts = [];
  if (chapterName) metaParts.push(`Kapitel: «${chapterName}»`);
  if (pageName)    metaParts.push(`Seite: «${pageName}»`);
  const metaBlock = metaParts.length ? `\nVerortung im Buch: ${metaParts.join(' · ')}\n` : '';

  // Erzählform-Block dient nur perspektivbruch/tempuswechsel – lokal ohnehin nicht geprüft.
  const povBlock = _isLocal
    ? ''
    : _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'lektorat');

  // Lokal: nur Namen (+ Kurzname) als Erkennungshilfe – Geschlecht/Beruf/Typ/Beschreibung
  // werden für Rechtschreibung/Grammatik/Stil nicht gebraucht und kosten nur Tokens.
  const figurenBlock = figuren.length > 0
    ? (_isLocal
      ? `\nBekannte Figuren in diesem Kapitel (Namen sind KEINE Rechtschreibfehler):\n${figuren.map(f => {
          const parts = [f.name];
          if (f.kurzname && f.kurzname !== f.name) parts.push(f.kurzname);
          return '- ' + parts.join(' / ');
        }).join('\n')}\n`
      : `\nBekannte Figuren in diesem Kapitel (Kontext für Namenskonsistenz und Perspektivprüfung):\n${figuren.map(f => {
          const parts = [f.name];
          if (f.kurzname) parts.push(`Kurzname: ${f.kurzname}`);
          if (f.geschlecht) parts.push(f.geschlecht);
          if (f.beruf) parts.push(f.beruf);
          if (f.typ) parts.push(`Typ: ${f.typ}`);
          if (f.beschreibung) parts.push(f.beschreibung);
          return '- ' + parts.join(' | ');
        }).join('\n')}\nHinweis: Figurennamen und deren Varianten sind KEINE Rechtschreibfehler.\n`)
    : '';

  // Beziehungen dienen v.a. Anreden/Pronomen/Perspektiv-Prüfung – lokal nicht relevant.
  const beziehungenBlock = (_isLocal || figurenBeziehungen.length === 0)
    ? ''
    : `\nBeziehungen zwischen diesen Figuren (Kontext für Anreden, Pronomen, Rollen):\n${figurenBeziehungen.map(b => {
        const head = `${b.von} → ${b.zu}: ${b.typ}`;
        return b.beschreibung ? `- ${head} – ${b.beschreibung}` : `- ${head}`;
      }).join('\n')}\n`;

  // Lokal: nur Ortsnamen als Erkennungshilfe – Typ/Stimmung/Beschreibung sind für Lektorat irrelevant.
  const orteBlock = orte.length > 0
    ? (_isLocal
      ? `\nSchauplätze in diesem Kapitel (Ortsnamen sind KEINE Rechtschreibfehler):\n${orte.map(o => '- ' + o.name).join('\n')}\n`
      : `\nSchauplätze in diesem Kapitel (Kontext – Ortsnamen und deren Varianten sind KEINE Rechtschreibfehler):\n${orte.map(o => {
          const parts = [o.name];
          if (o.typ) parts.push(`Typ: ${o.typ}`);
          if (o.stimmung) parts.push(`Stimmung: ${o.stimmung}`);
          if (o.beschreibung) parts.push(o.beschreibung);
          return '- ' + parts.join(' | ');
        }).join('\n')}\n`)
    : '';

  // Vorseiten-Absatz dient Tempus-/Perspektiv-Übergang – lokal nicht geprüft.
  const previousBlock = (_isLocal || !previousExcerpt)
    ? ''
    : `\nLetzter Absatz der vorherigen Seite (NUR als Übergangskontext für Tempus-/Perspektiv-/Pronomen-Prüfung – NICHT bewerten, nicht in «fehler» aufnehmen):\n"""\n${previousExcerpt}\n"""\n`;

  // Lokaler Modus: kleinere Typ-Enum, keine Beispiele, keine spezialisierten Rule-Blöcke
  // (show_vs_tell, passiv, perspektivbruch, tempuswechsel). Diese Typen verlangen nuanciertes
  // Textverständnis, an dem kleine Modelle häufig scheitern oder in Wiederholungsloops geraten.
  const typEnum = _isLocal
    ? 'rechtschreibung|grammatik|stil|wiederholung|schwaches_verb|fuellwort'
    : 'rechtschreibung|grammatik|stil|wiederholung|schwaches_verb|fuellwort|filterwort|klischee|pleonasmus|ki_geruch|show_vs_tell|passiv|perspektivbruch|tempuswechsel|dialogformat|namenskonsistenz|figurenmerkmal|anrede|schauplatzmerkmal';

  // Lokal + Cloud: Typ-Priorität und Anti-Doppelung pro Textspanne. Verhindert,
  // dass derselbe Satz mehrfach gemeldet wird (z.B. fuellwort + schwaches_verb +
  // stil am gleichen Wort) – pro Span genau ein Eintrag mit dem spezifischsten Typ.
  const dedupTypen = _isLocal
    ? 'rechtschreibung > grammatik > wiederholung > schwaches_verb > fuellwort > stil'
    : 'dialogformat > rechtschreibung > grammatik > namenskonsistenz > figurenmerkmal > schauplatzmerkmal > anrede > pleonasmus > wiederholung > perspektivbruch > tempuswechsel > klischee > ki_geruch > passiv > show_vs_tell > filterwort > schwaches_verb > fuellwort > stil';

  const dedupBlock = `
EIN-EINTRAG-PRO-STELLE (Anti-Doppelung, alle Typen):
- Pro Textspanne (überlappendes Wort oder überlappende Phrase) maximal EIN Eintrag im «fehler»-Array.
- Typ-Priorität bei Überlappung (spezifisch schlägt generisch): ${dedupTypen}.
- Beispiel «Er war eigentlich wütend»: NICHT als «fuellwort» (eigentlich) UND «show_vs_tell» (war wütend) UND «stil» (ganze Phrase) melden. Den treffendsten Typ wählen; die anderen Aspekte können knapp in «erklaerung» mitschwingen, aber KEIN zweiter Eintrag am gleichen Span.
- Mehrere Einträge zum selben Satz sind erlaubt NUR bei klar getrennten, nicht-überlappenden Textspannen (z.B. Fehler am Satzanfang UND unabhängiger Fehler am Satzende).
- Selbsttest pro Eintrag: Überlappt «original» textlich mit einem bereits ausgewählten Eintrag (gleiches Wort, gleiche Phrase, oder ineinandergeschachtelt)? Wenn ja → Eintrag streichen oder mit dem bereits gewählten zusammenführen (treffenderen Typ behalten).
`;

  const wichtigBlock = _isLocal
    ? dedupBlock
    : `\nWICHTIG: Bei wirklich unabhängigen Problemen an unterschiedlichen Textspannen separate Einträge erstellen (niemals in einer gemeinsamen «erklaerung» zusammenfassen). Für überlappende Spannen gilt die folgende Anti-Doppelung-Regel:\n${dedupBlock}`;

  // Gilt für ALLE Typen (lokal + cloud). Modelle bündeln sonst Meta-Präfixe,
  // Anführungszeichen oder Begründungs-Anhänge in das «korrektur»-Feld – das
  // Feld muss aber 1:1 in den Editor einsetzbar sein.
  const korrekturPuritaetBlock = `
KORREKTUR-PURITÄT (zwingend für jeden Eintrag, alle Typen):
- «korrektur» enthält AUSSCHLIESSLICH den Ersatztext, der «original» wortwörtlich ersetzen soll – sonst nichts.
- VERBOTEN in «korrektur»: Meta-Präfixe («Satz kürzen auf:», «Ersetzen durch:», «Vorschlag:», «Besser:», «Stattdessen:» o.Ä.), umschliessende Anführungszeichen oder Guillemets («»/„“/“”) um den ganzen Ersatztext, Begründungs-Anhänge per Gedankenstrich («... – weil/damit/sonst ...»), Variantenlisten («A oder B»), Kommentare in Klammern.
- Begründungen, Hinweise, Alternativen gehören AUSSCHLIESSLICH in «erklaerung».
- Einsetz-Selbsttest: Würde «original» 1:1 durch «korrektur» ersetzt, ergäbe der Satz korrekten, lesbaren Fliesstext ohne Reste? Wenn nein → Eintrag korrigieren oder weglassen.

ZEICHENGENAUIGKEIT von «original» (zwingend, alle Typen):
- «original» MUSS exakt – Zeichen für Zeichen – aus dem oben gegebenen Originaltext kopiert sein. KEINE Normalisierung erlaubt:
  · Anführungszeichen / Guillemets: «...», „...", "...", '...', ‹...› → exakt so übernehmen wie im Text, nicht durch eine andere Variante ersetzen
  · Halbgeviertstrich (–), Bindestrich (-), Geviertstrich (—) → exakt so übernehmen
  · Geschützte Leerzeichen ( ), schmale Leerzeichen ( ), normale Leerzeichen → exakt so übernehmen
  · Apostroph-Varianten (gerade ', typografisch ' und '), Auslassungspunkte (…) vs. drei Punkte (...) → exakt so übernehmen
  · Gross-/Kleinschreibung, Satzzeichen, Whitespace → 1:1
- Wenn die Stelle im Text Zeichen enthält, die in deinem JSON-Output durch Escaping repräsentiert werden müssen (z.B. Anführungszeichen), entsprechend escapen – aber den ursprünglichen Zeichensatz beibehalten.
- Selbsttest: Wenn ein automatisierter String-Find mit «original» den Text durchsucht, MUSS er die Stelle genau einmal finden. Approximationen (z.B. „..." statt «...») bedeuten: Stelle wird im Editor nicht gefunden → Eintrag unbrauchbar.

SPAN-TYP-KONSISTENZ (zwischen «original» und «korrektur», zwingend):
- «original» und «korrektur» müssen DENSELBEN Span-Typ haben:
  · Wenn «original» eine einzelne Phrase / ein Wort ist → «korrektur» auch eine Phrase / ein Wort (Ersatz im Satz).
  · Wenn «original» ein vollständiger Satz ist → «korrektur» auch ein vollständiger, kompletter Satz.
- VERBOTEN: «original» = «wegen dem Regen», «korrektur» = «Wegen des Regens blieben wir zu Hause.» (Phrase vs. ganzer Satz). Richtig: «korrektur» = «wegen des Regens».
- VERBOTEN: «original» = ganzer Satz, «korrektur» = nur die ersetzte Phrase ohne Satzrest.
- Pflicht-Span-Typ pro Typ:
${_isLocal
  ? `  · rechtschreibung, grammatik: Phrase oder Wort (genau die fehlerhafte Stelle)
  · wiederholung, schwaches_verb, fuellwort: vollständiger Satz
  · stil: vollständiger Satz ODER eindeutig abgrenzbare Phrase – beide Felder müssen denselben Span-Typ haben`
  : `  · rechtschreibung, grammatik: Phrase oder Wort (genau die fehlerhafte Stelle)
  · namenskonsistenz: einzelnes Wort (der falsch geschriebene Name)
  · figurenmerkmal, anrede, schauplatzmerkmal, pleonasmus, dialogformat: Phrase (genau die widersprüchliche / redundante / typografisch falsche Stelle)
  · wiederholung, schwaches_verb, fuellwort, filterwort, passiv, show_vs_tell, perspektivbruch, tempuswechsel: vollständiger Satz
  · klischee, ki_geruch, stil: vollständiger Satz ODER eindeutig abgrenzbare Phrase – beide Felder müssen denselben Span-Typ haben`}
`;

  const filterBlock = _isLocal
    ? ''
    : `${erklaerungRule ? `\nFILTER-PFLICHT: ${erklaerungRule}\n` : ''}${korrekturRegeln ? `\n${korrekturRegeln}\n` : ''}`;

  // Severity + Findings-Obergrenze: Anti-Pedanterie. Cloud-only – kleine Modelle
  // produzieren ohnehin weniger und sollten nicht zusätzlich gefiltert werden.
  const severityBlock = _isLocal ? '' : `
SCHWERE-SCHWELLE (Anti-Pedanterie, Pflicht-Filter vor dem Aufnehmen ins «fehler»-Array):
- Melde NUR Schwächen, die einem ernsthaften Leser spürbar ins Auge fallen oder das Lese-Erlebnis nachweislich beeinträchtigen.
- Selbsttest pro Eintrag: «Würde ein professioneller Lektor diese Stelle in einem bezahlten Lektorat anstreichen?» Wenn die Antwort «vielleicht», «Geschmacksache» oder «nur am Rand» wäre → weglassen.
- VERWORFEN-Kandidaten: minimal alternative Synonyme ohne klaren Gewinn, Mikro-Stilpräferenzen, ein einzelnes «sehr» / «ein bisschen» wenn der Satz sonst rund läuft, vollkommen idiomatische Wendungen, regional übliche Formulierungen, ironisch oder bewusst eingesetzte «Schwächen».
- Qualität schlägt Quantität: lieber 5 starke, präzise Findings als 25 schwache. Wenn nach dem Selbsttest mehr als ~20 Einträge übrig bleiben, hart priorisieren: nur die schwersten 20 behalten, restliche weglassen.
- Echte Rechtschreib- und Grammatikfehler unterliegen der Schwere-Schwelle NICHT – diese werden immer gemeldet (eindeutige Falschschreibung, Kongruenzfehler, Kasusfehler etc.).
`;

  // Selbstkontroll-Pass: Sortierung + Schluss-Review. Hat bei Claude messbaren
  // Effekt; bei lokalen Modellen erhöht es Halluzinationsrisiko und wird
  // weggelassen.
  const selbstkontrollBlock = _isLocal ? '' : `
SELBSTKONTROLL-PASS (Pflicht vor dem Antworten):
Bevor du die JSON-Antwort ausgibst, gehe deine gesammelten Findings einmal durch und prüfe:
1. SCHWERE: Hat jeder Eintrag den Selbsttest «professioneller Lektor anstreichen?» bestanden? Wenn nein → streichen.
2. DOPPELUNG: Überlappt «original» eines Eintrags textlich mit dem «original» eines anderen Eintrags? Wenn ja → nur den mit dem treffendsten Typ (gemäss Typ-Priorität oben) behalten.
3. PURITÄT: Enthält «korrektur» Meta-Präfixe / Guillemets / Begründungs-Anhänge? Wenn ja → korrigieren oder Eintrag streichen.
4. ZEICHENGENAUIGKEIT: Liesse sich «original» mit einem String-Find im Originaltext genau einmal finden? Wenn nein → korrigieren oder streichen.
5. SPAN-TYP-KONSISTENZ: Sind «original» und «korrektur» beide gleichlange Spans (beide Phrase ODER beide Satz)? Wenn nein → korrigieren.
6. ERKLÄRUNGS-FILTER: Enthält «erklaerung» «kein Fehler» / «vertretbar» / «möglicherweise» / «akzeptabel» / «im Schweizer Kontext»? Wenn ja → Eintrag streichen.
7. SORTIERUNG: Sortiere das «fehler»-Array AUFSTEIGEND nach Textposition (erstes Auftreten von «original» im Originaltext – früh im Text zuerst, spät im Text zuletzt).
8. ZUSAMMENFASSUNGS-DISJUNKTION: Lies «stilanalyse», «fazit» und jedes «szenen[].kommentar» einzeln. Wenn ein Satz dort einen Mangel beschreibt, der textuell oder thematisch bereits durch einen Eintrag im «fehler»-Array abgedeckt ist (auch in Aggregat-Form wie «viele Wiederholungen», «passivlastig», «schwache Verben», «zu viele Füllwörter», «häufige Stilbrüche», «Show-vs-Tell-Probleme») → diesen Satz löschen oder durch eine inhaltlich nicht überlappende Beobachtung ersetzen. Selbsttest: Wäre der Satz überflüssig, wenn der Leser das «fehler»-Array bereits gesehen hat? Wenn ja → raus. Die drei Summary-Felder dürfen keine konkreten Findings paraphrasieren und keine Findings-Gruppen charakterisieren.
`;

  // Few-Shot: ein GUTES + ein VERWORFENES Beispiel. Das Erklärung-Filter-
  // Anti-Pattern ist bereits durch SCHWERE-SCHWELLE + SELBSTKONTROLL-PASS Step 6
  // explizit abgedeckt (Trigger-Wörter: kein Fehler / vertretbar / möglicherweise / akzeptabel)
  // — extra Beispiel wäre Token-Redundanz. Das Korrektur-Purität-Beispiel bleibt,
  // weil es einzigartig die IN-PLACE-Korrektur (Meta-Präfix raus + Reformulierung)
  // demonstriert, die keine Regel-Beschreibung gleichwertig zeigt.
  const beispielBlock = _isLocal ? '' : `
Beispiel eines GUTEN Eintrags:
{ "typ": "grammatik", "original": "wegen dem Regen", "korrektur": "wegen des Regens", "erklaerung": "«wegen» verlangt den Genitiv." }
Beispiel eines VERWORFENEN Eintrags (Korrektur-Purität verletzt):
{ "typ": "show_vs_tell", "original": "Dort versteckte er sich vor der Konfrontation, vor der eigentlich normalsten Auseinandersetzung zwischen Ehepartnern.", "korrektur": "Satz kürzen auf: «Dort versteckte er sich vor der Konfrontation.» – der erklärende Nachsatz nimmt dem Leser die Deutung vorweg.", "erklaerung": "..." } → «korrektur» enthält Meta-Präfix, Guillemets und Begründungs-Anhang → KORRIGIEREN zu: { "korrektur": "Dort versteckte er sich vor der Konfrontation.", "erklaerung": "Der erklärende Nachsatz nimmt dem Leser die Deutung vorweg – Satz kürzen." }
`;

  const figurenkonsistenzBlock = (!_isLocal && figuren.length > 0)
    ? _buildFigurenkonsistenzBlock()
    : '';
  const schauplatzkonsistenzBlock = (!_isLocal && orte.length > 0)
    ? _buildSchauplatzkonsistenzBlock()
    : '';

  const spezialBlocks = _isLocal
    ? ''
    : `${_buildFilterwortBlock()}
${_buildKlischeeBlock()}
${_buildPleonasmusBlock()}
${_buildShowVsTellBlock()}
${_buildDialogformatBlock(langCode)}
${_buildPassivBlock()}
${_buildPerspektivbruchBlock()}
${_buildTempuswechselBlock()}
${_buildAiSmellBlock()}
${figurenkonsistenzBlock}
${schauplatzkonsistenzBlock}
`;

  // Lokal: szenen/stilanalyse/fazit werden aus Schema und Prompt gestrichen. Kleine Modelle
  // halluzinieren diese Felder oft generisch und das Generieren kostet spürbar Output-Tokens.
  const schemaBlock = _isLocal
    ? `Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "${typEnum}",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "erklaerung": "Erklärung in EINEM Satz, maximal 25 Wörter – nur diesen einen Mangel beschreiben, keine Mehrfach-Begründungen, keine Alternativ-Vorschläge"
    }
  ]
}`
    : `Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "${typEnum}",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "erklaerung": "Erklärung in EINEM Satz, maximal 25 Wörter – nur diesen einen Mangel beschreiben, keine Mehrfach-Begründungen, keine Alternativ-Vorschläge"
    }
  ],
  "szenen": [
    {
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung). KEINE konkreten Fehler aus dem «fehler»-Array wiederholen (keine Wortwahl-, Stil-, Grammatik-, Wiederholungs-, Füllwort-Hinweise zu Einzelstellen). Nur szenen-übergreifende Beobachtungen (Spannungsbogen, Tempo, Konflikt, Figurenentwicklung, Schauplatzwirkung)."
    }
  ],
  "stilanalyse": "4-5 Sätze Stilanalyse – KEINE konkreten Fehler erwähnen, die bereits im «fehler»-Array stehen (weder Rechtschreibung, Grammatik, Stil, Wiederholungen, Füllwörter, schwache Verben, Show-vs-Tell, Passiv, Perspektive, Tempus noch andere Typen). KEINE Aggregat-Hinweise auf bereits gemeldete Muster («häufige Wiederholungen», «viele Füllwörter», «passivlastig», «schwache Verben dominieren» o.Ä.) – diese Muster sind durch die Einzel-Findings abgedeckt. Fokus ausschliesslich auf übergreifende Beobachtungen, die NICHT als Einzelfehler erfasst sind: Rhythmus über mehrere Absätze, Bildsprache, Erzählhaltung, Atmosphäre, Wirkung beim Leser.",
  "fazit": "ein Satz Gesamtfazit zur literarischen Qualität – KEINE Fehler aus dem «fehler»-Array wiederholen, zusammenfassen oder als Gruppe charakterisieren («viele Stilbrüche», «zahlreiche Wiederholungen» o.Ä.). Nur Gesamtwirkung, nicht das Findings-Resultat paraphrasieren."
}`;

  const szenenRegelnBlock = _isLocal ? '' : `
Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen`;

  const aufgabeSatz = _isLocal
    ? 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen.'
    : 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen. Bewerte ausserdem die Szenen der Seite.';

  // XML-Wrapper für die strukturell trennbaren Sektionen — hilft Claude beim
  // Parsen von Aufgabe, Schema, Beispielen und Originaltext als distinkte
  // Einheiten. Der mittlere Regel-Korpus bleibt als geordnete Textblöcke; die
  // bestehenden Section-Header (KORREKTUR-PURITÄT, SCHWERE-SCHWELLE, …) wirken
  // bereits als interne Marker.
  const beispielSection = beispielBlock.trim()
    ? `<beispiele>\n${beispielBlock.trim()}\n</beispiele>\n`
    : '';
  return `<aufgabe>
${aufgabeSatz}
</aufgabe>
${metaBlock}${povBlock}${wichtigBlock}${korrekturPuritaetBlock}${severityBlock}${filterBlock}
<output_format>
${schemaBlock}
</output_format>
${beispielSection}${szenenRegelnBlock}
${_buildStilBlock()}
${_buildWiederholungBlock(stopwords)}
${_buildSchwacheVerbenBlock()}
${_buildFuellwortBlock()}
${spezialBlocks}${figurenBlock}${beziehungenBlock}${orteBlock}${previousBlock}
${selbstkontrollBlock}
<originaltext label="${textLabel.replace(/:\s*$/, '')}">
${text}
</originaltext>`;
}

export function buildLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Originaltext:', opts);
}

// Batch-Variante ohne korrekturen_html (spart Output-Tokens, für Server-Side-Jobs)
export function buildBatchLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Text:', opts);
}

export function buildStilkorrekturPrompt(html, styles) {
  const liste = styles.map((s, i) =>
    `${i + 1}. Originalstelle (kann durch andere Korrekturen schon verändert sein): "${s.original}"\n   Empfehlung: "${s.korrektur}"\n   Begründung: ${s.erklaerung}`
  ).join('\n\n');

  return `Du bekommst einen HTML-Text und eine Liste stilistischer Verbesserungsvorschläge. Für jede Stelle entscheidest du selbst, wie die beste Formulierung lautet – die Empfehlung ist ein Hinweis, keine Vorgabe.

Wichtige Regeln für das "original"-Feld:
- Der HTML-Text unten ist die VERBINDLICHE Wahrheit. Andere Korrekturen können den Wortlaut bereits verändert haben — die "Originalstelle" oben ist daher nur ein Hinweis, NICHT der zu suchende Text.
- Suche im HTML-Text die Passage, die der Originalstelle entspricht, und gib den jetzt im HTML stehenden Wortlaut zeichen-für-zeichen exakt zurück (inkl. Anführungszeichen-Stil, Whitespace, geschützte Leerzeichen, Tags wenn sie mitten in der Passage liegen).
- Wenn die Stelle so nicht (mehr) im HTML steht, lass den Eintrag komplett weg — niemals erfinden, niemals approximieren.
- Wenn die Originalstelle keine Verbesserung braucht (Ersatz wäre identisch oder gleichwertig), lass den Eintrag ebenfalls weg — gib nicht "original" und "ersatz" identisch zurück.

Stilistische Verbesserungen:
${liste}

Antworte mit diesem JSON-Schema. Das Feld "index" ist die 1-basierte Position aus der nummerierten Liste oben (also 1 für den ersten Eintrag, 2 für den zweiten usw.) — gib es immer korrekt an, damit deine Antwort dem ursprünglichen Vorschlag zugeordnet werden kann:
{
  "korrekturen": [
    { "index": 1, "original": "zeichengenauer Wortlaut aus dem HTML-Text unten", "ersatz": "deine gewählte Ersatzformulierung" }
  ]
}

HTML-Text:
${html}`;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

// SCHEMA_LEKTORAT ist _isLocal-abhängig (lokale Provider erhalten ein reduziertes
// Schema ohne szenen/stilanalyse/fazit) → wird via _rebuildLektoratSchema() neu
// gebaut, damit der dynamisch gesetzte _isLocal-Flag korrekt wirkt.
export let SCHEMA_LEKTORAT = null;

function _buildLektoratSchema() {
  const enumLocal = ['rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'schwaches_verb', 'fuellwort'];
  const enumCloud = [
    ...enumLocal,
    'filterwort', 'klischee', 'pleonasmus', 'ki_geruch',
    'show_vs_tell', 'passiv', 'perspektivbruch', 'tempuswechsel',
    'dialogformat',
    'namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal',
  ];
  const fehlerField = {
    type: 'array',
    items: _obj({
      typ: { type: 'string', enum: _isLocal ? enumLocal : enumCloud },
      original: _str,
      korrektur: _str,
      erklaerung: _str,
    }),
  };
  if (_isLocal) return _obj({ fehler: fehlerField });
  return _obj({
    fehler: fehlerField,
    szenen: {
      type: 'array',
      items: _obj({
        titel: _str,
        wertung: { type: 'string', enum: ['stark', 'mittel', 'schwach'] },
        kommentar: _str,
      }),
    },
    stilanalyse: _str,
    fazit: _str,
  });
}

export function _rebuildLektoratSchema() {
  SCHEMA_LEKTORAT = _buildLektoratSchema();
}

_rebuildLektoratSchema();

// Statisches Schema – nicht _isLocal-abhängig.
// `index` (1-basiert) referenziert die Position in der Eingabeliste; erlaubt
// eindeutiges Mapping zurück auf die Stil-Findings auch wenn die KI Einträge
// auslässt (z.B. weil keine Verbesserung nötig).
export const SCHEMA_STILKORREKTUR = _obj({
  korrekturen: {
    type: 'array',
    items: _obj({ index: _num, original: _str, ersatz: _str }),
  },
});
