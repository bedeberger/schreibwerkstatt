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

/**
 * Werkzeug-Definitionen für den Agentic Buch-Chat.
 * Anthropic-Tool-Format (name/description/input_schema). lib/ai.js liest daraus direkt.
 * Beschreibungen bewusst kurz — kosten Input-Tokens.
 * Übersicht aller Tools: docs/buchchat-tools.md
 */
export const BOOK_CHAT_TOOLS = [
  {
    name: 'list_chapters',
    description: 'Liefert die komplette Kapitel- und Seitenliste: pro Kapitel chapter_id, Name, Seitenzahl, Wortzahl UND pages[{page_id,page_name,words}]. Zusätzlich total_pages/total_words für das ganze Buch. Nutze dies zuerst für einen Überblick – und um page_ids für get_pages zu bekommen, z.B. wenn du bei einem kleinen Buch alle Seiten laden willst. Nicht nutzen für Detailstatistik eines einzelnen Kapitels (Dialoganteil, Top-Figuren-Erwähnungen) – dafür `get_stil_metrics` (scope=chapter, include_figures).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_figures',
    description: 'Flacher Figurenkatalog des Buchs: pro Figur fig_id, Name, Kurzname, Typ, Rolle, Präsenz und Gesamt-Erwähnungen (aus Index). Leichtgewichtig – ideal als Einstieg, um zu wissen, welche Figuren existieren und welche IDs für die anderen Figuren-Tools nötig sind. Nicht nutzen für Detail einer Figur (Profil, Beziehungen, Lebensereignisse) – dafür `get_figure_profile`.',
    input_schema: {
      type: 'object',
      properties: {
        sort:  { type: 'string', enum: ['mentions_desc', 'name', 'presence_desc'], description: 'Reihenfolge. Default: mentions_desc (häufigste zuerst).' },
        limit: { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'count_pronouns',
    description: 'Zählt Pronomen im ganzen Buch (Summe) oder pro Kapitel (per_chapter=true). Unterscheidet narrativen Text und Dialog. Ideal für Fragen zur Erzählperspektive ("kommt der Ich-Erzähler häufiger vor?").',
    input_schema: {
      type: 'object',
      properties: {
        per_chapter: { type: 'boolean', description: 'true = pro Kapitel aufschlüsseln, false = gesamt (default).' },
        pronouns: {
          type: 'array',
          items: { type: 'string', enum: ['ich', 'du', 'er', 'sie_sg', 'wir', 'ihr_pl', 'man'] },
          description: 'Optionaler Filter auf bestimmte Pronomen-Gruppen. Ohne Angabe: alle.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_figure_mentions',
    description: 'Wo und wie oft wird eine Figur erwähnt? Antwort nach Kapitel und Seite, mit Count je Seite. Liefert ausserdem `first_appearance`, `last_appearance`, `total_mentions`, `pages_with_mention` – deckt Arc-Tracking-Fragen ("wann zuerst, wann zuletzt?", "wie lange präsent?") direkt ab. Leichtgewichtig – nur Auftrittsverteilung. Nicht nutzen für Profil, Beziehungen oder Lebensereignisse von X – dafür `get_figure_profile`. Gib figur_id (bevorzugt) ODER figur_name an.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'fig_id aus der Figurenliste (z.B. "fig_3").' },
        figur_name: { type: 'string', description: 'Alternative: Name oder Kurzname der Figur.' },
      },
      required: [],
    },
  },
  {
    name: 'search_passages',
    description: 'Durchsucht den Buch-Volltext via FTS5 (Literal-Pfad, bm25-sortiert) und liefert exakte Treffer-Offsets + Snippets. Standard: case-insensitive Literal-Suche; mit regex=true als JavaScript-Regex (umgeht FTS5 und scannt alle Seiten direkt). Mit chapter_id/page_id auf ein Kapitel oder eine Seite einschränken. Offsets sind kompatibel mit `quote_passage`. Nutze dies für "wo kommt X vor?"-Fragen über das ganze Buch, wenn X ein KONKRETES Wort/Name/eine Phrase ist. NICHT nutzen, um Stellen nach einer Eigenschaft zu finden, die nicht im Wortlaut steht (lustig/schön/spannend/traurig, Humor, Ton, Stimmung) — solche Aufgaben durch eigene Lektüre lösen (→ `get_chapter_text`, ganze Kapitel gebündelt laden), nicht durch Raten von Stichwörtern. Auch nicht nutzen, wenn du bereits page_ids kennst und den vollen Seitentext brauchst (→ `get_pages` / `get_chapter_text`) oder für Figuren-Auftritte (→ `get_figure_mentions`).',
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string',  description: 'Suchmuster (literal oder Regex). Im Literal-Modus ist dies eine PHRASEN-Suche, KEINE Stichwort-ODER-Suche: mehrere Wörter werden als exakte Wortfolge gesucht (FTS5 filtert die Seiten nur vor). „lustig komisch witzig" matcht also nur diese Wortfolge, nicht Seiten, die irgendeines der Wörter enthalten. Suche nach EINEM konkreten Wort/Namen/einer festen Phrase; für „irgendwo etwas Lustiges/Schönes" ist das Tool ungeeignet (→ Kapitel lesen). Mehrere Alternativen brauchst du regex=true (z.B. `lustig|komisch|witzig`).' },
        regex:       { type: 'boolean', description: 'true = pattern als JavaScript-Regex interpretieren, scannt alle Buchseiten ohne FTS5-Vorfilter. Default: false.' },
        chapter_id:  { type: 'integer', description: 'Optional: Suche auf ein Kapitel einschränken.' },
        page_id:     { type: 'integer', description: 'Optional: Suche auf eine einzelne Seite einschränken (überschreibt chapter_id-Wirkung).' },
        max_results: { type: 'integer', description: 'Maximale Anzahl Treffer (default 10, max 30).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'get_pages',
    description: 'Lädt den vollen Text bestimmter Seiten (bei Bedarf für Zitate oder Detail-Analyse). Bis zu 20 Seiten pro Aufruf – bei kleinen Büchern kannst du in einem Call das ganze Buch laden (Page-IDs vorher via list_chapters holen). Falls für die Seite ein gespeichertes Lektorat existiert, kommt es als latest_check {checked_at, error_count, fazit, stilanalyse} mit. Schwergewichtig (Volltext) – nicht nutzen für blosse Trefferlisten oder „wo kommt X vor?", dafür `search_passages` / `get_figure_mentions`. Für ein ganzes Kapitel bequemer: `get_chapter_text`. Nicht zur Massen-Inspektion ganzer Bücher aufrufen, wenn ein Aggregat-Tool (z.B. `get_stil_metrics`, `get_lektorat_hotspots`) die Frage direkt beantwortet.',
    input_schema: {
      type: 'object',
      properties: {
        ids:                { type: 'array', items: { type: 'integer' }, description: 'Liste der page_ids (aus list_chapters oder anderen Tool-Ergebnissen).' },
        max_chars_per_page: { type: 'integer', description: 'Harte Kürzung pro Seite. Server clamped automatisch an das Kontextfenster – nur setzen, wenn explizit weniger gewünscht.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_chapter_text',
    description: 'Lädt den Volltext aller Seiten eines Kapitels in einem Call (max 20 Seiten, automatische Sortierung nach page_id). Spart die Sequenz list_chapters → get_pages. Liefert pages[{page_id,page_name,text,truncated}] + total_pages. Ideal für "fasse Kapitel X zusammen", "wie endet Kapitel 3?", "welche Szenen sind in Kapitel 2?". Falls das Kapitel >20 Seiten hat, kommt `dropped` zurück — restliche Seiten dann gezielt via `get_pages` nachladen.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id:         { type: 'integer', description: 'Kapitel-ID aus list_chapters (Pflicht).' },
        max_pages:          { type: 'integer', description: 'Anzahl Seiten max. (1-20, Default: alle Seiten des Kapitels bis 20).' },
        max_chars_per_page: { type: 'integer', description: 'Harte Kürzung pro Seite. Server clamped automatisch ans Kontextfenster.' },
      },
      required: ['chapter_id'],
    },
  },
  {
    name: 'get_reviews',
    description: 'Liefert gespeicherte Bewertungen für dieses Buch und diesen User. `scope="book"`: letzte Buchbewertung (gesamtnote 1.0–6.0, Stärken/Schwächen/Fazit/Zusammenfassung). `scope="chapter"` (Default): Liste der Kapitelbewertungen — pro Kapitel gesamtnote, Stärken, Schwächen, Fazit, Zusammenfassung; plus `ohne_bewertung[]` für noch nicht bewertete Kapitel. Antwortet ohne weiteren KI-Call. Beantwortet "wie gut ist das Buch insgesamt?" (book) bzw. "welche Kapitel sind am stärksten/schwächsten?" (chapter).',
    input_schema: {
      type: 'object',
      properties: {
        scope:       { type: 'string', enum: ['book', 'chapter'], description: 'Aggregations-Scope. Default: chapter.' },
        chapter_ids: { type: 'array', items: { type: 'integer' }, description: 'Nur für scope=chapter: filtert auf diese Kapitel-IDs. Ohne Angabe: alle bewerteten Kapitel.' },
        sort:        { type: 'string', enum: ['note_desc', 'note_asc', 'chapter'], description: 'Nur für scope=chapter. Default: note_desc (stärkste zuerst).' },
        limit:       { type: 'integer', description: 'Nur für scope=chapter. Default 30, max 100.' },
      },
      required: [],
    },
  },
  {
    name: 'get_figure_relations',
    description: 'Liefert das Soziogramm: alle Figurenbeziehungen als gerichtete Kanten (from → to) mit Typ, Beschreibung, Machtverhältnis und bis zu 3 Belegen. Ohne Filter: ganzes Buch. Mit figur_id/figur_name: nur Kanten, die diese Figur berühren. Ideal für "wer kennt wen?", "Konflikte zwischen X und Y", "wer dominiert?".',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'Optional: nur Kanten dieser Figur (fig_id, z.B. "fig_3").' },
        figur_name: { type: 'string', description: 'Alternative: Name/Kurzname der Figur.' },
      },
      required: [],
    },
  },
  {
    name: 'get_figure_profile',
    description: 'Vollständiges Profil einer Figur: Stammdaten (Typ, Geburtstag, Beruf, Rolle, Motivation, Konflikt, Entwicklung, Sozialschicht, Präsenz), Tags, Schlüsselzitate, alle Lebensereignisse (mit Kapitel/Seite), Szenen, Kapitel-Auftritte und alle Beziehungen (beide Richtungen). Schwergewichtig — für "was weißt du über X?" oder Detail-Analyse einer Figur. Enthält bereits Beziehungen – kein zusätzliches `get_figure_relations` nötig. Nicht nutzen, wenn nur Auftrittsverteilung gefragt ist (→ `get_figure_mentions`) oder nur Kanten zwischen mehreren Figuren (→ `get_figure_relations` ohne Filter). Gib figur_id (bevorzugt) ODER figur_name an.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'fig_id (z.B. "fig_3").' },
        figur_name: { type: 'string', description: 'Alternative: Name/Kurzname.' },
      },
      required: [],
    },
  },
  {
    name: 'list_continuity_issues',
    description: 'Listet die Befunde des letzten Kontinuitätschecks: pro Issue Typ, Schwere, Beschreibung, betroffene Stellen (stelle_a/stelle_b), Empfehlung sowie betroffene Figuren und Kapitel. Beantwortet "wo widerspricht sich das Buch?", "was sind die schwersten Lücken?", "Kontinuitätsprobleme in Kapitel X". Liefert nichts, wenn noch kein Check ausgeführt wurde.',
    input_schema: {
      type: 'object',
      properties: {
        schwere:    { type: 'string', description: 'Optionaler Filter (z.B. "hoch", "mittel", "niedrig"). Vergleich case-insensitive.' },
        typ:        { type: 'string', description: 'Optionaler Typ-Filter (z.B. "zeit", "ort", "fakt"). Vergleich case-insensitive.' },
        chapter_id: { type: 'integer', description: 'Nur Issues, die dieses Kapitel betreffen.' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 30, max 100).' },
      },
      required: [],
    },
  },
  {
    name: 'get_timeline',
    description: 'Liefert den konsolidierten Zeitstrahl (zeitstrahl_events) chronologisch nach sort_order: Datum, Ereignis, Typ, Bedeutung, betroffene Kapitel/Seiten/Figuren. Mit figur_id/figur_name filtert auf Ereignisse, an denen diese Figur beteiligt ist. Mit typ filtert auf Ereignistyp (z.B. "persoenlich", "historisch"). Ideal für "wann passiert was?", "biografische Timeline von X".',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'Optional: nur Ereignisse dieser Figur (fig_id).' },
        figur_name: { type: 'string', description: 'Alternative: Name/Kurzname der Figur.' },
        typ:        { type: 'string', description: 'Optional: Typ-Filter (case-insensitive).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 60, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_ideen',
    description: 'Listet die Notizen/Ideen, die der User zu einzelnen Seiten oder ganzen Kapiteln gespeichert hat (mit Kapitel-/Seitenkontext). Jede Idee hat `scope: "page"` oder `"chapter"`. Ideal um offene Anmerkungen aufzugreifen, oder zu beantworten "was wollte ich an Kapitel X noch ändern?". Filterbar nach erledigt, page_id, chapter_id (Chapter-Filter umfasst sowohl direkt-am-Kapitel-Ideen als auch Ideen zu Seiten des Kapitels). Offene Ideen erscheinen zuerst.',
    input_schema: {
      type: 'object',
      properties: {
        erledigt:   { type: 'boolean', description: 'true = nur erledigte, false = nur offene. Ohne Angabe: beide.' },
        page_id:    { type: 'integer', description: 'Nur Ideen zu dieser Seite.' },
        chapter_id: { type: 'integer', description: 'Nur Ideen zu diesem Kapitel (direkt-am-Kapitel + Seiten des Kapitels).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'get_lektorat_hotspots',
    description: 'Aggregat über page_checks (letzter Check pro Seite): pro Kapitel total/avg/max Fehleranzahl plus Top-N-Seiten mit den meisten Fehlern (inkl. fazit-Snippet). Beantwortet "wo sind die schwersten Lektorat-Probleme?", "welche Kapitel brauchen am meisten Arbeit?". Schneller Überblick. Nutze danach `get_lektorat_findings` für die konkreten Findings einer Seite/eines Kapitels. Nicht nutzen für Stil-/Lesbarkeitsmetriken (Passiv-Anteil, LIX, Dialoganteil) – dafür `get_stil_metrics`. Hotspots zählen Fehler-Findings; Metriken messen Satzstruktur.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Seiten dieses Kapitels.' },
        min_errors: { type: 'integer', description: 'Mindest-Fehleranzahl pro Seite (default 0).' },
        limit:      { type: 'integer', description: 'Anzahl Top-Seiten (default 20, max 100).' },
      },
      required: [],
    },
  },
  {
    name: 'get_lektorat_findings',
    description: 'Konkrete Lektorat-Findings (Einzelbefunde, nicht nur Aggregat). Liefert findings[{page_id,page_name,chapter_id,chapter_name,checked_at,typ,original,korrektur,erklaerung,offset?,length?}] aus dem letzten Check pro Seite. Plus by_typ-Verteilung und total_findings. Filterbar nach page_id, chapter_id und typ (z.B. "stil","grammatik","rechtschreibung","interpunktion","fluss","wortwahl"). Ideal für "welche Stilfehler gibt es im Kapitel?", "zeig mir konkrete Lektorat-Vorschläge zu Seite X", "wo wurden Grammatikfehler gefunden?". Vorlauf: `get_lektorat_hotspots` für Überblick, dann hier ins Detail.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:    { type: 'integer', description: 'Nur Findings dieser Seite.' },
        chapter_id: { type: 'integer', description: 'Nur Findings dieses Kapitels (ignoriert wenn page_id gesetzt).' },
        typ:        { type: 'string',  description: 'Optional: Filter nach Fehler-Typ (case-insensitive, z.B. "stil").' },
        limit:      { type: 'integer', description: 'Max. Findings im Output (default 30, max 100). Aggregate (by_typ, total_findings) zählen alle Treffer.' },
      },
      required: [],
    },
  },
  {
    name: 'get_stil_metrics',
    description: 'Stil- und Lesbarkeitsmetriken aus page_stats. Drei Modi via scope: "book" (Aggregat über das ganze Buch), "chapter" (Aufschlüsselung pro Kapitel, optional gefiltert via chapter_id), "page" (Top-N-Seiten nach einer Metrik). Liefert words/chars/sentences/dialog_chars/dialog_ratio_percent/filler_count/passive_count/adverb_count/avg_sentence_len/sentence_len_p90/lix/flesch_de. Mit `include_figures=true` (nur scope=chapter) kommen pro Kapitel Top-5-Figuren-Erwähnungen mit. Ideal für "wie viel Passiv im Buch?", "welche Kapitel haben am meisten Dialog?", "welche Seiten haben höchsten LIX?", "wer ist in Kapitel X am häufigsten?". Nicht nutzen für Fehleranzahl/Lektorat-Hotspots – dafür `get_lektorat_hotspots`.',
    input_schema: {
      type: 'object',
      properties: {
        scope:           { type: 'string', enum: ['book', 'chapter', 'page'], description: 'Aggregations-Scope. Default: book.' },
        chapter_id:      { type: 'integer', description: 'Nur für scope=chapter: einzelnes Kapitel statt aller.' },
        include_figures: { type: 'boolean', description: 'Nur für scope=chapter: hängt pro Kapitel `top_figuren` (max 5) an.' },
        metric:          {
          type: 'string',
          enum: ['filler_count', 'passive_count', 'adverb_count', 'sentences', 'dialog_chars', 'avg_sentence_len', 'sentence_len_p90', 'lix', 'flesch_de'],
          description: 'Nur für scope=page: nach welcher Metrik sortiert wird. Default: passive_count.',
        },
        order:           { type: 'string', enum: ['asc', 'desc'], description: 'Nur für scope=page: Sortier-Richtung. Default: desc (höchster Wert zuerst).' },
        limit:           { type: 'integer', description: 'Nur für scope=page: Anzahl Seiten (default 10, max 50).' },
      },
      required: [],
    },
  },
  {
    name: 'list_locations',
    description: 'Liefert alle Schauplätze/Orte des Buchs: Name, Typ, Beschreibung, Stimmung, erste Erwähnung, betroffene Kapitel (mit Häufigkeit), `last_chapter` (kapitel-genaues Arc-Ende), assoziierte Figuren. Pendant zu Figurenliste, aber für Orte. Filterbar nach chapter_id (nur Orte, die in diesem Kapitel vorkommen).',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Orte, die in diesem Kapitel auftauchen.' },
      },
      required: [],
    },
  },
  {
    name: 'get_location_profile',
    description: 'Tiefes Einzel-Ort-Profil (Pendant zu get_figure_profile): Stammdaten (Typ, Beschreibung, Stimmung, erste Erwähnung) + alle Kapitel mit Häufigkeit + `last_chapter` (Arc-Ende) + alle assoziierten Figuren + alle Szenen, die an diesem Ort spielen (mit Titel, Wertung, Kapitel/Seite). Für "erzähl mir alles über den Wald", "welche Szenen spielen im Schloss?", "wer war je am Hafen?". Auswahl per `loc_id` (aus list_locations) oder `name` (exakt oder Substring).',
    input_schema: {
      type: 'object',
      properties: {
        loc_id: { type: 'string', description: 'loc_id des Orts (aus list_locations).' },
        name:   { type: 'string', description: 'Alternative: Ortsname (exakt oder Substring, case-insensitive).' },
      },
      required: [],
    },
  },
  {
    name: 'list_world_facts',
    description: 'Liefert die etablierten Welt-Fakten/Weltregeln des Buchs (deklaratives Buch-Wissen aus der Komplettanalyse): Magiesystem-Regeln, Geografie, Daten, etablierte Aussagen. Pro Fakt: kategorie, subjekt, fakt-Text, betroffene Kapitel. Beantwortet "welche Weltregeln gelten?", "wie funktioniert die Magie?", "welche Fakten über Ort/Figur X sind etabliert?". Filterbar nach kategorie (exakt) und subjekt (Teilstring).',
    input_schema: {
      type: 'object',
      properties: {
        kategorie: { type: 'string', description: 'Nur Fakten dieser Kategorie. Gültige Werte: figur, ort, objekt, organisation, technik, regel, kultur, historie, zeit, soziolekt, ereignis, sonstiges.' },
        subjekt:   { type: 'string', description: 'Nur Fakten zu diesem Subjekt (Teilstring, case-insensitive).' },
      },
      required: [],
    },
  },
  {
    name: 'list_songs',
    description: 'Listet die Songs/den Soundtrack des Buchs (Musikbibliothek): Titel, Interpret, Genre, Kontext-Typ, Beschreibung, Stimmung, erste Erwähnung + verknüpfte Kapitel (mit Häufigkeit), Figuren und Szenen. Beantwortet "welche Musik/Songs gehören zum Buch?", "welcher Song zu Figur X?", "Soundtrack von Kapitel 3?". Filterbar nach chapter_id, figur_id/figur_name, scene_id.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Songs, die in diesem Kapitel verknüpft sind.' },
        figur_id:   { type: 'string',  description: 'Nur Songs zu dieser Figur (fig_id).' },
        figur_name: { type: 'string',  description: 'Alternative: Name/Kurzname der Figur.' },
        scene_id:   { type: 'integer', description: 'Nur Songs zu dieser Szene (scene_id aus list_scenes).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_scenes',
    description: 'Listet Szenen aus dem Szenenkatalog (figure_scenes) mit Titel, Wertung, Kommentar, Kapitel/Seite, beteiligten Figuren und Orten. Filterbar nach chapter_id, page_id, figur_id/figur_name (Figur ist in der Szene), loc_id (Ort der Szene). Ideal für "welche Szenen spielt X?", "Szenen in Kapitel 3", "Szenen im Wald".',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Szenen dieses Kapitels.' },
        page_id:    { type: 'integer', description: 'Nur Szenen dieser Seite.' },
        figur_id:   { type: 'string',  description: 'Nur Szenen mit dieser Figur (fig_id).' },
        figur_name: { type: 'string',  description: 'Alternative: Name/Kurzname.' },
        loc_id:     { type: 'string',  description: 'Nur Szenen an diesem Ort (loc_id).' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'list_werkstatt_drafts',
    description: 'Listet die Figuren-Werkstatt-Drafts dieses Users (Vorwärts-Entwicklungs-Mindmaps, vom Katalog/get_figure_profile getrennt): Name, Archetyp, Quell-Figur, notes-Vorschau, Brainstorm-/Consistency-Counts, letzter Lauf. Beantwortet "an welchen Figuren arbeitet der User?". Für Details (Mindmap-Text + Run-Inhalte) anschliessend `get_werkstatt_draft` rufen.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_werkstatt_draft',
    description: 'Detail-Output eines Figuren-Werkstatt-Drafts: Mindmap (eingerückter Plaintext in User-Locale) + KI-Läufe (Brainstorm-Vorschläge, Consistency-Konflikte+Fazit) gekürzt. Liefert "was hat der User für Figur X notiert?", "was kam beim Brainstorm raus?". Auswahl per `draft_id` (aus list_werkstatt_drafts) oder `figur_name` (exakt oder Substring, case-insensitive).',
    input_schema: {
      type: 'object',
      properties: {
        draft_id:     { type: 'integer', description: 'Draft-ID aus list_werkstatt_drafts.' },
        figur_name:   { type: 'string',  description: 'Alternative: Name des Werkstatt-Drafts (exakt oder Substring).' },
        include_runs: { type: 'boolean', description: 'true = KI-Läufe mitliefern. Default: true.' },
        run_limit:    { type: 'integer', description: 'Max. Anzahl Läufe (default 5, max 20).' },
      },
      required: [],
    },
  },
  {
    name: 'get_plot_board',
    description: 'Liefert das geplante Beat-Board der Plot-Werkstatt: Akte (Spalten) → Beats (Handlungspunkte) mit Titel, Beschreibung, Status (geplant = Idee / im_buch = eingearbeitet; verworfen ist ein separates Flag), verknüpftem Zielkapitel, Strang (thread, falls Swimlanes angelegt) und beteiligten Figuren (Katalog + Werkstatt). Bei mehreren Hauptfiguren legt der User optional Handlungsstränge (threads, Swimlanes) an — parallele Erzähllinien, oft je Hauptfigur; das Top-Level-Feld threads listet sie (mit gebundener Hauptfigur), und jeder Beat trägt sein thread-Feld (Strang-Name oder null). Das ist die VORWÄRTSGERICHTETE Planung des Users (was er vorhat), getrennt von der rückwärtsgewandten Szenen-/Ereignis-Analyse des geschriebenen Texts. Beantwortet "wie ist die Handlung geplant?", "welche Beats sind noch nicht geschrieben (status=geplant)?", "welcher Beat gehört zu Kapitel X?", "wie entwickelt sich Strang/Hauptfigur Y?", "passt der Plot zum bisherigen Buch?". Pro Buch + User. Leeres Board heisst nur: keine separate Plot-Planung angelegt – nicht, dass das Buch keine Handlung hat. Für den GESCHRIEBENEN Text nutze list_scenes/get_timeline statt dieses Tools.',
    input_schema: {
      type: 'object',
      properties: {
        status:  { type: 'string', enum: ['geplant', 'im_buch'], description: 'Optional: nur Beats mit diesem Status zurückgeben (geplant = Idee, im_buch = eingearbeitet). status_counts zeigt immer die Gesamtverteilung über alle Beats (inkl. verworfen-Zählung).' },
        act_id:  { type: 'integer', description: 'Optional: nur diesen Akt (Spalte) zurückgeben (id aus einem vorherigen Aufruf).' },
      },
      required: [],
    },
  },
  {
    name: 'find_first_last_mention',
    description: 'Liefert erste + letzte Erwähnung einer Figur (page_figure_mentions) oder eines Orts (location_chapters). Schmaler als `get_figure_mentions` – nur die zwei Endpunkte, ohne Per-Kapitel-Aggregat. Beantwortet "wo erscheint X zuerst?", "wann verschwindet X aus dem Buch?". Pflicht: `figur_id` ∨ `figur_name` ∨ `loc_id`. Ohne Index (Komplettanalyse fehlt): freundlicher Fehler statt 0-Werten.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'fig_id der Figur.' },
        figur_name: { type: 'string', description: 'Alternativ: Name/Kurzname der Figur.' },
        loc_id:     { type: 'string', description: 'Alternative: loc_id eines Ortes (aus list_locations).' },
      },
      required: [],
    },
  },
  {
    name: 'get_book_settings',
    description: 'Liefert die Stamm-Einstellungen des Buchs: Sprache, Region, Buchtyp (roman/krimi/lyrik/sachbuch/…), Erzählperspektive (Ich/3.Person personal/auktorial/…), Erzählzeit (Präteritum/Präsens), is_finished-Status, freier buch_kontext-Text (Vorgaben des Users an die KI). Pflichtig vor jeder Stilfrage oder vor jedem Vorschlag, der Sprache/Tonfall/Tempus berührt – sonst kollidiert die Antwort mit den expliziten User-Vorgaben.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'find_repetitions',
    description: 'Findet N-Gramm-Wiederholungen (häufige Wortgruppen) im Buchtext – ideal für Sprach-Tics, Lieblings-Formulierungen, redundante Phrasen. Standard: n=3 (Tri-Gramme), scope=book, min_count=5, Stopwort-Filter aktiv (sonst dominieren "und der die"). Returns results[{phrase, count, sample_pages:[{page_id,page_name,count}]}]. Nicht nutzen, um eine einzelne bekannte Phrase zu suchen – dafür `search_passages`.',
    input_schema: {
      type: 'object',
      properties: {
        n:                { type: 'integer', description: 'Wortzahl der N-Gramme (2-5). Default: 3.' },
        scope:            { type: 'string', enum: ['book', 'chapter', 'page'], description: 'Default: book.' },
        chapter_id:       { type: 'integer', description: 'Pflicht für scope=chapter.' },
        page_id:          { type: 'integer', description: 'Pflicht für scope=page.' },
        min_count:        { type: 'integer', description: 'Mindesthäufigkeit. Default: 5 (book) bzw. 2.' },
        limit:            { type: 'integer', description: 'Max. Treffer (default 30, max 100).' },
        ignore_stopwords: { type: 'boolean', description: 'true (default): N-Gramme nur aus Funktionswörtern werden ignoriert.' },
      },
      required: [],
    },
  },
  {
    name: 'get_dialogue',
    description: 'Extrahiert Dialog-Passagen (heuristisch via Anführungszeichen «»/„"/""/»«, Speech-Verb+Doppelpunkt, Em-Dash am Zeilenanfang). Mit figur_id/figur_name nur Dialoge, in deren ±100 Zeichen Umfeld der Figurenname vorkommt (Sprecher-Heuristik). Liefert results[{page_id, page_name, offset, length, text, before, after}] – die offsets sind kompatibel mit `quote_passage` und `search_passages`. Ideal für "wie spricht X?", "Dialoge in Kapitel 3", "wo wird viel gesprochen?". Auch der beste Einstieg für inhaltliche Zitat-Selektion nach Eigenschaft (lustigste/schlagfertigste/markanteste Stellen, Humor, Figuren-Stimme): Pointen leben meist im Dialog — gezielter als search_passages (das nur Wortlaut findet) und bei grossen Büchern fokussierter als ganze Kapitel zu laden. Einfache gerade Quotes (\'…\') werden bewusst NICHT erkannt (Apostroph-False-Positives).',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Dialoge dieses Kapitels.' },
        page_id:    { type: 'integer', description: 'Nur Dialoge dieser Seite.' },
        figur_id:   { type: 'string',  description: 'Nur Dialoge im Umfeld dieser Figur (fig_id).' },
        figur_name: { type: 'string',  description: 'Alternative: Name/Kurzname.' },
        min_length: { type: 'integer', description: 'Minimale Dialog-Länge in Zeichen (default 4).' },
        limit:      { type: 'integer', description: 'Max. Dialoge (default 30, max 100).' },
      },
      required: [],
    },
  },
  {
    name: 'list_revisions',
    description: 'Listet die gespeicherten Revisionen einer Seite (neueste zuerst): rev_id, created_at, source (focus/main/book/chat-apply/lektorat-apply/import/conflict), chars, words, summary. Plus total_revisions. Voraussetzung, um gezielt `diff_page_revisions` zwischen bestimmten Revisionen zu rufen, statt nur den Default-Pfad (zwei jüngste) zu nehmen.',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'integer', description: 'Seiten-ID (Pflicht).' },
        limit:   { type: 'integer', description: 'Maximale Anzahl Revisionen (default 20, max 100).' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'diff_page_revisions',
    description: 'Vergleicht zwei Revisionen einer Seite (Plain-Text-Word-Diff). Ohne from_rev_id/to_rev_id: die zwei jüngsten Revisionen. Liefert summary{add,del,change}, chars_delta und blocks[{kind:add/del/change, text|from/to}]. Beantwortet "was hat sich an Seite X seit letztem Edit geändert?", "wie hat sich der Text entwickelt?". Für gezielten Vergleich vorher `list_revisions` rufen, um rev_ids zu holen.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:     { type: 'integer', description: 'Seiten-ID (Pflicht).' },
        from_rev_id: { type: 'integer', description: 'Optional: ältere Revision-ID (Default: zweitneueste).' },
        to_rev_id:   { type: 'integer', description: 'Optional: neuere Revision-ID (Default: neueste).' },
      },
      required: ['page_id'],
    },
  },
  {
    name: 'quote_passage',
    description: 'Liefert ein zeichengenaues Zitat aus einer Seite (offset+length im Plain-Text, kompatibel mit den offsets aus `search_passages` und `get_dialogue`). Liefert page_name, chapter_name, quote (exakte Passage), before/after-Kontext und page_chars. Nutze dies vor JEDEM wörtlichen Zitat in der finalen Antwort – nie aus Erinnerung paraphrasieren oder aus get_pages-Ausschnitten Quotes zusammenkürzen. Wenn du nur Pattern + page_id kennst (kein offset): nimm `quote_match`. Max length: 800 Zeichen; max context_chars: 300.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:       { type: 'integer', description: 'Seiten-ID (Pflicht).' },
        offset:        { type: 'integer', description: 'Start-Offset im Plain-Text (Pflicht, >=0).' },
        length:        { type: 'integer', description: 'Länge in Zeichen (Pflicht, 1-800).' },
        context_chars: { type: 'integer', description: 'Vor-/Nach-Kontext (default 80, max 300, 0 = ohne).' },
      },
      required: ['page_id', 'offset', 'length'],
    },
  },
  {
    name: 'quote_match',
    description: 'Bequemes Pendant zu `quote_passage`: Server sucht den Pattern (case-insensitive Literal-Substring) selbst auf der Seite und gibt das zeichengenaue Zitat + offset/length zurück. Spart die Sequenz search_passages → quote_passage, wenn du nur ein Pattern und eine page_id hast. Liefert quote, offset, length, before/after, occurrence und total_matches. Bei mehreren Treffern: `occurrence` (1-basiert) wählt den n-ten Treffer; ohne Angabe der erste. Max pattern-Länge: 800. Nicht für Regex – nur Literal. Für Buch-weite Suche ohne bekannte page_id zuerst `search_passages` rufen.',
    input_schema: {
      type: 'object',
      properties: {
        page_id:       { type: 'integer', description: 'Seiten-ID (Pflicht).' },
        pattern:       { type: 'string',  description: 'Literaler Substring, der zitiert werden soll (case-insensitive, max 800 Zeichen). Das gefundene Zitat hat die Original-Schreibweise aus dem Seitentext.' },
        occurrence:    { type: 'integer', description: 'Wenn das Pattern mehrfach vorkommt: welches Vorkommen (1-basiert)? Default: 1.' },
        context_chars: { type: 'integer', description: 'Vor-/Nach-Kontext (default 80, max 300, 0 = ohne).' },
      },
      required: ['page_id', 'pattern'],
    },
  },
  {
    name: 'generate_image',
    description: 'Erzeugt EIN Bild zu einer textuellen Beschreibung und zeigt es dem User unter deiner Antwort an (im Chat-Verlauf, herunterladbar). Nutze dies nur, wenn der User ausdrücklich ein Bild/eine Illustration/eine Visualisierung wünscht — z.B. ein Figurenporträt, einen Schauplatz, eine Szene oder eine Stimmungs-Illustration zum Buch. Baue den Bild-Prompt selbst aus dem Buchwissen (Aussehen einer Figur, Beschreibung eines Orts/einer Szene) — am besten auf Englisch und mit konkreten visuellen Details (Stil, Licht, Komposition), das liefert bessere Resultate. Das Bild ist reine Visualisierung und wird NICHT in den Buchtext geschrieben. Nach dem Aufruf in final_answer kurz auf das angezeigte Bild verweisen, aber KEINE Bild-URL und keine Markdown-Bildsyntax ausgeben (das Bild rendert das Frontend selbst). Nicht ungefragt aufrufen und nicht für Textfragen verwenden.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Bildbeschreibung für den Generator. Konkret und visuell; bevorzugt Englisch. Pflichtfeld.' },
        size:   { type: 'string', description: 'Optionales Seitenverhältnis/Format als "BREITExHÖHE" (z.B. "1024x1024", "1024x1536"). Ohne Angabe: Server-Default.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'final_answer',
    description: 'Liefert die finale Antwort an den User. Rufe dieses Werkzeug als ALLERLETZTEN Aufruf einer Runde — danach folgt keine weitere Iteration und keine weitere Recherche. Pflicht-Endpunkt: jede Antwort an den User MUSS über dieses Werkzeug laufen. Freitext ohne final_answer wird nicht als Antwort akzeptiert. Schreibe die Antwort in der Sprache der Userfrage. Wenn du in der antwort wörtlich zitierst: hänge JEDES Zitat in das Feld `zitate` mit {page_id, offset, length, quote} aus quote_passage/quote_match/search_passages. Der Server validiert post-hoc; ungültige Zitate werden geloggt.',
    input_schema: {
      type: 'object',
      properties: {
        antwort: { type: 'string', description: 'Antwort an den User als Freitext, Markdown erlaubt. Pflichtfeld.' },
        zitate: {
          type: 'array',
          description: 'Optional: alle wörtlichen Zitate, die in der antwort vorkommen, je mit page_id, offset, length und exakt dem zitierten Text. Halluzinationsschutz — der Server prüft, ob text.slice(offset, offset+length) == quote im aktuellen Seitentext.',
          items: {
            type: 'object',
            properties: {
              page_id: { type: 'integer', description: 'Seiten-ID des Zitats.' },
              offset:  { type: 'integer', description: 'Start-Offset im Plain-Text (>=0).' },
              length:  { type: 'integer', description: 'Länge des Zitats in Zeichen (>0).' },
              quote:   { type: 'string',  description: 'Der exakt zitierte Text (zeichengenau zum Seiteninhalt).' },
            },
            required: ['page_id', 'offset', 'length', 'quote'],
          },
        },
      },
      required: ['antwort'],
    },
  },
];

// Rückgabe: Array von System-Cache-Blöcken (für callAIChat → Claude separate
// cache_control-Blöcke; lokale Provider flatten sie auf einen String).
//   Block 1 (ttl '1h'): buch-stabiler Anteil (System + Buchname + Figuren +
//     Review) — ändert sich über die Turns einer Session nicht. Der potenziell
//     grosse Figuren-/Review-Kontext wird so über alle Turns aus dem Cache gelesen.
//   Block 2 (cache:false): die pro Query neu keyword-selektierten Buchseiten +
//     JSON-Format-Trailer. Bewusst OHNE Breakpoint, weil der Block jede Runde
//     andere Seiten trägt — ein Breakpoint wäre ein cache_write ohne je gelesen
//     zu werden. Steht am Ende, damit Block 1 ein stabiler Präfix bleibt.
export function buildBookChatSystemPrompt(bookName, relevantPages, figuren, review, systemOverride = null) {
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
    volatil.push('=== RELEVANTE BUCHSEITEN ===');
    for (const page of relevantPages) {
      volatil.push(`--- Seite: ${page.name} ---`);
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
