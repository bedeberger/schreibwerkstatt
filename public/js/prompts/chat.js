// Seiten-Chat + Buch-Chat (klassisch + Agentic) Prompt-Builder.
// Liest SYSTEM_CHAT/SYSTEM_BOOK_CHAT live-bound aus core.js (von configurePrompts gesetzt).

import { _isLocal, JSON_ONLY } from './state.js';
import { _obj, _str } from './schema-utils.js';
import { SYSTEM_CHAT, SYSTEM_BOOK_CHAT } from './core.js';

/**
 * Baut den vollständigen System-Prompt für den Seiten-Chat.
 * @param {string}      pageName        Name der Seite
 * @param {string}      pageText        Aktueller Seiteninhalt als Plaintext
 * @param {Array}       figuren         Figuren-Array aus der DB (kann leer sein)
 * @param {Object}      review          Letzte Buchbewertung aus der DB (kann null sein)
 * @param {string|null} systemOverride  Optionaler System-Prompt-Override
 * @param {string|null} openingPageText Snapshot beim Chat-Öffnen; nur setzen wenn
 *                                      ungleich pageText (sonst null → keine
 *                                      redundante Section).
 * @param {Array}       ideen           Offene Ideen des Autors für diese Seite +
 *                                      das umliegende Kapitel — Notizen zu möglichen
 *                                      Fortsetzungen, Szenen, Ankern. Jedes Item hat
 *                                      `scope: 'page'|'chapter'`. KI darf sie
 *                                      aufgreifen/diskutieren, aber nicht
 *                                      eigenmächtig in Vorschläge umwandeln.
 * @param {Object|null} lektorat        Letztes Lektorat dieser Seite aus page_checks
 *                                      ({ checked_at, fehler, stilanalyse, fazit }).
 *                                      Kann gegenüber pageText veraltet sein.
 */
// Rückgabe: Array von System-Cache-Blöcken (für callAIChat → Claude separate
// cache_control-Blöcke; lokale Provider flatten sie auf einen String).
//   Block 1 (ttl '1h'): buch-stabiler Anteil (System + Figuren + Review) — ändert
//     sich weder über die Turns derselben Seite noch beim Seitenwechsel innerhalb
//     des Buchs. Der grosse SYSTEM_CHAT + die Figuren-JSON werden so über alle
//     Seiten-Chats eines Buchs aus dem Cache gelesen.
//   Block 2 (5min): seiten-spezifischer Anteil (Seitenname/-inhalt + Ideen +
//     Lektorat + JSON-Format-Trailer) — stabil über die Turns einer Seiten-Session,
//     invalidiert beim Seitenwechsel oder wenn der Autor die Seite editiert.
export function buildChatSystemPrompt(pageName, pageText, figuren, review, systemOverride = null, openingPageText = null, ideen = null, lektorat = null) {
  const stable = [systemOverride ?? SYSTEM_CHAT];

  if (figuren && figuren.length > 0) {
    stable.push('', '=== FIGUREN DES BUCHS ===', JSON.stringify(figuren, null, 2));
  }

  if (review) {
    stable.push('', '=== LETZTE BUCHBEWERTUNG ===', JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
  }

  const page = [
    `Aktuelle Seite: «${pageName}»`,
    '',
  ];

  if (openingPageText) {
    page.push(
      '=== SEITENINHALT BEIM CHAT-START ===',
      openingPageText,
      '',
      '=== SEITENINHALT JETZT (nach Änderungen des Autors) ===',
      pageText,
      '',
      'Hinweis: Der Autor hat die Seite seit Chat-Start verändert. Beziehe dich beim Antworten auf den aktuellen Stand; verweise nur auf den Chat-Start-Stand, wenn die Änderung selbst Thema ist.',
      '',
    );
  } else {
    page.push(
      '=== SEITENINHALT ===',
      pageText,
      '',
    );
  }

  if (Array.isArray(ideen) && ideen.length > 0) {
    page.push('=== OFFENE IDEEN (Notizen des Autors für diese Seite + das umliegende Kapitel) ===');
    for (const i of ideen) {
      const datum = i.created_at ? ` (${i.created_at.slice(0, 10)})` : '';
      const tag = i.scope === 'chapter' ? '[Kapitel] ' : '[Seite] ';
      page.push(`- ${tag}${i.content}${datum}`);
    }
    page.push('');
    page.push('Hinweis: Diese Ideen sind Notizen des Autors zu möglichen Fortsetzungen, Szenen oder inhaltlichen Ankern. [Kapitel]-Notizen gelten fürs ganze Kapitel, [Seite]-Notizen nur für diese Seite. Greife sie auf, hinterfrage oder ergänze sie konversationell — wandle sie aber nicht eigenmächtig in vorschlaege-Einträge um, solange der Autor nicht danach fragt.');
    page.push('');
  }

  if (lektorat && ((Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0) || lektorat.stilanalyse || lektorat.fazit)) {
    const datum = lektorat.checked_at ? lektorat.checked_at.slice(0, 16).replace('T', ' ') : null;
    page.push(`=== LETZTES LEKTORAT DIESER SEITE${datum ? ` (Stand ${datum})` : ''} ===`);
    page.push(JSON.stringify({
      ...(Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0 ? { fehler: lektorat.fehler } : {}),
      ...(lektorat.stilanalyse ? { stilanalyse: lektorat.stilanalyse } : {}),
      ...(lektorat.fazit ? { fazit: lektorat.fazit } : {}),
    }, null, 2));
    page.push('');
    page.push('Hinweis: Diese Beanstandungen stammen aus einem früheren Lektoratslauf. Der Seitentext kann seitdem überarbeitet worden sein — prüfe gegen den aktuellen Seiteninhalt, bevor du dich darauf beziehst. Wiederhole bereits erledigte Punkte nicht; greife noch offene Beanstandungen auf, wenn der Autor danach fragt oder daran arbeitet.');
    page.push('');
  }

  page.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)",',
    '  "vorschlaege": [',
    '    {',
    '      "original": "exakter Originaltext aus der Seite (zeichengenau)",',
    '      "ersatz": "Ersatztext",',
    '      "begruendung": "kurze Begründung"',
    '    }',
    '  ]',
    '}',
    '',
    'VORSCHLÄGE-REGELN:',
    '- Wenn du stilistische, inhaltliche oder sprachliche Schwächen erkennst oder der Autor nach Verbesserungen fragt: liefere mindestens einen konkreten Vorschlag mit original und ersatz.',
    '- original muss zeichengenau mit dem Seitentext übereinstimmen.',
    '- ersatz muss den Stil des Autors beibehalten.',
    '- vorschlaege ist nur dann ein leeres Array, wenn die Frage rein inhaltlich/konzeptionell ist und keine Textstelle betrifft (z.B. Plotfragen, Figurenmotivation).',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return [
    { text: stable.join('\n'), ttl: '1h' },
    { text: page.join('\n') },
  ];
}

/**
 * Baut den System-Prompt für den Agentic Buch-Chat (Tool-Use-Modus).
 * Unterscheidet sich von buildBookChatSystemPrompt: enthält KEINE Seiteninhalte,
 * dafür eine Anweisung an das Modell, Werkzeuge aufzurufen statt zu raten.
 * Figuren + Review bleiben im System-Prompt (klein, gecacht).
 */
// Synthese-Aufforderung für den Fall, dass die Werkzeug-Iterationen erschöpft
// sind, ohne dass das Modell final_answer gerufen hat. Statt mit einem Fehler
// aufzugeben, wird das Modell mit dieser Nachricht (und nur noch final_answer als
// verfügbarem Werkzeug) gezwungen, aus dem bereits Gesammelten zu antworten.
export const BOOK_CHAT_FORCE_FINAL_INSTRUCTION =
  'Du hast die maximale Zahl an Recherche-Iterationen erreicht — keine weitere Recherche mehr möglich. '
  + 'Fasse JETZT aus den bereits gesammelten Informationen die bestmögliche Antwort zusammen und liefere sie über das Werkzeug `final_answer`. '
  + 'Wenn die Recherche unvollständig blieb, beantworte die Frage so weit wie möglich mit dem Vorhandenen und weise kurz darauf hin, was nicht abgedeckt werden konnte. '
  + 'Sprache der Antwort: die der Userfrage.';

export function buildBookChatAgentSystemPrompt(bookName, figuren, review, systemOverride = null, maxToolIter = 6) {
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
    'Du hast Zugriff auf Werkzeuge, die Fragen über das gesamte Buch aus einem vorberechneten Index beantworten. Nutze sie, bevor du antwortest, wann immer die Frage gemessen oder aus konkreten Textstellen belegt werden kann:',
    '- Häufigkeit, Verteilung, Erzählperspektive → count_pronouns, get_stil_metrics',
    '- Figurenverteilung, erstes Auftreten → get_figure_mentions, list_chapters',
    '- Konkrete Textstellen oder Zitate → search_passages, quote_match, quote_passage',
    '- Ganze Kapitel lesen → get_chapter_text (statt list_chapters→get_pages)',
    '- Lektorat: Übersicht → get_lektorat_hotspots, konkrete Findings → get_lektorat_findings',
    '- Kapitel-Qualität, Stärken/Schwächen → get_reviews',
    '- Geplante Handlung / Beat-Board / was noch nicht geschrieben ist → get_plot_board',
    '- Geplante Themen & Motive, Soll/Ist-Abgleich (welche Motive fehlen im Text) → get_motifs, get_motif_occurrences',
    '',
    'Rufe Werkzeuge an, bevor du vermutest.',
    'STRATEGIE — Suche vs. Lektüre: `search_passages` ist Stichwort-Suche („wo kommt das bekannte Wort/der Name X vor?"). Für SEMANTISCHE Aufgaben, bei denen du Stellen nach einer EIGENSCHAFT auswählst (lustigste/schönste/spannendste/traurigste Stellen, Humor, Ton, Stimmung, Beispiele für ein Stilmittel) hat das Gesuchte KEINE Stichwort-Signatur — rate dann NICHT mit search_passages nach Wörtern. Lies stattdessen den Text selbst: lade ganze Kapitel via `get_chapter_text` (mehrere gebündelt in einer Runde) und wähle die Stellen aus eigener Lektüre aus. Bei kleinen/mittleren Büchern, die in den Kontext passen (siehe `hint` aus list_chapters), lade gleich das ganze Buch statt es in vielen Runden zu durchforsten.',
    'Wörtliche Zitate: IMMER über quote_match (Pattern → Stelle) oder quote_passage (offset+length) holen, NIE aus Erinnerung paraphrasieren. Beim final_answer-Call jedes wörtliche Zitat in `zitate` mitliefern — Server validiert.',
    `Maximal ${maxToolIter} Werkzeug-Iterationen pro Antwort (eine Iteration = eine Runde, NICHT ein Tool-Call). Halte Werkzeug-Argumente präzise und kurz. Die Iterationen sind knapp — verschwende sie nicht mit seriellem Stichwort-Raten, wenn ein paar gebündelte get_chapter_text-Calls den ganzen relevanten Text in einer Runde liefern.`,
    'WICHTIG — bündle Werkzeuge: Rufe in EINER Runde alle Werkzeuge parallel auf, die nicht voneinander abhängen, statt eines nach dem anderen. Bei breiten Aufgaben (z.B. „Zitate/Stellen aus vielen Kapiteln") gleich mehrere search_passages/get_chapter_text gleichzeitig absetzen. Erst danach in der nächsten Runde zitieren/auswerten. So reichen die Iterationen auch für umfangreiche Recherchen.',
    '',
  ];

  if (figuren && figuren.length > 0) {
    parts.push('=== FIGUREN DES BUCHS ===');
    parts.push(JSON.stringify(figuren, null, 2));
    parts.push('');
  }

  if (review) {
    parts.push('=== LETZTE BUCHBEWERTUNG ===');
    parts.push(JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
    parts.push('');
  }

  parts.push(
    'Liefere deine finale Antwort IMMER über das Werkzeug `final_answer` (Pflicht-Endpunkt). Kein Freitext-Output ohne Tool-Call — auch wenn keine Recherche-Tools nötig sind, muss die Antwort via final_answer kommen. Sprache der Antwort: passe dich der Sprache der Userfrage an, nicht der Sprache dieses Prompts.',
  );

  return parts.join('\n');
}

// Werkzeug-Definitionen für den Agentic Buch-Chat: docs/buchchat-tools.md.
export { BOOK_CHAT_TOOLS } from './book-chat-tools.js';


// Rückgabe: Array von System-Cache-Blöcken (für callAIChat → Claude separate
// cache_control-Blöcke; lokale Provider flatten sie auf einen String).
//   Block 1 (ttl '1h'): buch-stabiler Anteil (System + Buchname + Figuren +
//     Review) — ändert sich über die Turns einer Session nicht. Der potenziell
//     grosse Figuren-/Review-Kontext wird so über alle Turns aus dem Cache gelesen.
//   Block 2 (cache:false): die pro Query neu keyword-selektierten Buchseiten +
//     JSON-Format-Trailer. Bewusst OHNE Breakpoint, weil der Block jede Runde
//     andere Seiten trägt — ein Breakpoint wäre ein cache_write ohne je gelesen
//     zu werden. Steht am Ende, damit Block 1 ein stabiler Präfix bleibt.
export function buildBookChatSystemPrompt(bookName, relevantPages, figuren, review, systemOverride = null, opts = {}) {
  const stable = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
  ];

  if (figuren && figuren.length > 0) {
    stable.push('', '=== FIGUREN DES BUCHS ===', JSON.stringify(figuren, null, 2));
  }

  if (review) {
    stable.push('', '=== LETZTE BUCHBEWERTUNG ===', JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
  }

  const volatil = [];
  if (relevantPages && relevantPages.length > 0) {
    // excerpt=true: die Textstellen sind semantisch retrievte Chunk-Auszüge (Mini-RAG),
    // nicht ganze Seiten — das Modell darf daraus nicht auf Vollständigkeit der Seite schliessen.
    const excerpt = opts.excerpt === true;
    if (excerpt) {
      volatil.push('=== RELEVANTE TEXTSTELLEN AUS DEM BUCH ===');
      volatil.push('(Bedeutungs-relevanteste Auszüge, nach Ähnlichkeit sortiert; können unvollständig sein.)');
    } else {
      volatil.push('=== RELEVANTE BUCHSEITEN ===');
    }
    for (const page of relevantPages) {
      volatil.push(excerpt ? `--- Auszug aus Seite: ${page.name} ---` : `--- Seite: ${page.name} ---`);
      volatil.push(page.text);
      volatil.push('');
    }
  }

  volatil.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return [
    { text: stable.join('\n'), ttl: '1h' },
    { text: volatil.join('\n'), cache: false },
  ];
}

// ── Chat-Titel ────────────────────────────────────────────────────────────────

/**
 * System-Prompt für die KI-Zusammenfassung eines Chat-Verlaufs zu einem kurzen
 * History-Titel. Genutzt von allen drei Chats (Seiten-/Buch-/Recherche-Chat) über
 * routes/jobs/chat-title.js. Bewusst knapp — der Titel steht in einer schmalen
 * History-Liste, nicht als ganzer Satz.
 */
export function buildChatTitlePrompt() {
  const parts = [
    'Du erstellst einen sehr kurzen, prägnanten Titel für einen Chat-Verlauf.',
    'Fasse das Thema der folgenden Konversation in maximal 6 Wörtern zusammen.',
    'Regeln:',
    '- Verwende dieselbe Sprache wie die Konversation.',
    '- Beschreibe das Thema; wiederhole nicht wörtlich die ganze Frage.',
    '- Kein Schlusspunkt, keine Anführungszeichen, keine Emojis, keine Aufzählung.',
    '',
    'Antworte ausschliesslich als JSON-Objekt: {"titel": "…"}',
  ];
  if (!_isLocal) parts.push('', JSON_ONLY);
  return parts.join('\n');
}

export const SCHEMA_CHAT_TITLE = _obj({ titel: _str });

// ── Schemas ──────────────────────────────────────────────────────────────────

export const SCHEMA_CHAT = _obj({
  antwort: _str,
  vorschlaege: {
    type: 'array',
    items: _obj({ original: _str, ersatz: _str, begruendung: _str }),
  },
});

export const SCHEMA_BOOK_CHAT = _obj({ antwort: _str });
