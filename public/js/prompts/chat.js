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
 * @param {Array}       ideen           Offene Ideen des Autors für diese Seite —
 *                                      Notizen zu möglichen Fortsetzungen, Szenen,
 *                                      Ankern. KI darf sie aufgreifen/diskutieren,
 *                                      aber nicht eigenmächtig in Vorschläge umwandeln.
 * @param {Object|null} lektorat        Letztes Lektorat dieser Seite aus page_checks
 *                                      ({ checked_at, fehler, stilanalyse, fazit }).
 *                                      Kann gegenüber pageText veraltet sein.
 */
export function buildChatSystemPrompt(pageName, pageText, figuren, review, systemOverride = null, openingPageText = null, ideen = null, lektorat = null) {
  const parts = [
    systemOverride ?? SYSTEM_CHAT,
    '',
    `Aktuelle Seite: «${pageName}»`,
    '',
  ];

  if (openingPageText) {
    parts.push(
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
    parts.push(
      '=== SEITENINHALT ===',
      pageText,
      '',
    );
  }

  if (Array.isArray(ideen) && ideen.length > 0) {
    parts.push('=== OFFENE IDEEN (Notizen des Autors für diese Seite) ===');
    for (const i of ideen) {
      const datum = i.created_at ? ` (${i.created_at.slice(0, 10)})` : '';
      parts.push(`- ${i.content}${datum}`);
    }
    parts.push('');
    parts.push('Hinweis: Diese Ideen sind Notizen des Autors zu möglichen Fortsetzungen, Szenen oder inhaltlichen Ankern. Greife sie auf, hinterfrage oder ergänze sie konversationell — wandle sie aber nicht eigenmächtig in vorschlaege-Einträge um, solange der Autor nicht danach fragt.');
    parts.push('');
  }

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

  if (lektorat && ((Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0) || lektorat.stilanalyse || lektorat.fazit)) {
    const datum = lektorat.checked_at ? lektorat.checked_at.slice(0, 16).replace('T', ' ') : null;
    parts.push(`=== LETZTES LEKTORAT DIESER SEITE${datum ? ` (Stand ${datum})` : ''} ===`);
    parts.push(JSON.stringify({
      ...(Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0 ? { fehler: lektorat.fehler } : {}),
      ...(lektorat.stilanalyse ? { stilanalyse: lektorat.stilanalyse } : {}),
      ...(lektorat.fazit ? { fazit: lektorat.fazit } : {}),
    }, null, 2));
    parts.push('');
    parts.push('Hinweis: Diese Beanstandungen stammen aus einem früheren Lektoratslauf. Der Seitentext kann seitdem überarbeitet worden sein — prüfe gegen den aktuellen Seiteninhalt, bevor du dich darauf beziehst. Wiederhole bereits erledigte Punkte nicht; greife noch offene Beanstandungen auf, wenn der Autor danach fragt oder daran arbeitet.');
    parts.push('');
  }

  parts.push(
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

  return parts.join('\n');
}

/**
 * Baut den System-Prompt für den Agentic Buch-Chat (Tool-Use-Modus).
 * Unterscheidet sich von buildBookChatSystemPrompt: enthält KEINE Seiteninhalte,
 * dafür eine Anweisung an das Modell, Werkzeuge aufzurufen statt zu raten.
 * Figuren + Review bleiben im System-Prompt (klein, gecacht).
 */
export function buildBookChatAgentSystemPrompt(bookName, figuren, review, systemOverride = null, maxToolIter = 6) {
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
    'Du hast Zugriff auf Werkzeuge, die Fragen über das gesamte Buch aus einem vorberechneten Index beantworten. Nutze sie, bevor du antwortest, wann immer die Frage gemessen oder aus konkreten Textstellen belegt werden kann:',
    '- Häufigkeit, Verteilung, Erzählperspektive → count_pronouns, get_chapter_stats',
    '- Figurenverteilung, erstes Auftreten → get_figure_mentions, list_chapters',
    '- Konkrete Textstellen oder Zitate → search_passages, get_pages',
    '- Kapitel-Qualität, Stärken/Schwächen, beste/schwächste Kapitel → list_chapter_reviews',
    '',
    'Rufe Werkzeuge an, bevor du vermutest. Bei interpretatorischen Fragen (Stil, Ton, Wirkung) kannst du direkt antworten oder mit search_passages Belege suchen.',
    `Maximal ${maxToolIter} Werkzeug-Iterationen pro Antwort. Halte Werkzeug-Argumente präzise und kurz.`,
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
    'Deine finale Antwort (nach allen nötigen Werkzeug-Aufrufen) hat dieses JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return parts.join('\n');
}

/**
 * Werkzeug-Definitionen für den Agentic Buch-Chat.
 * Anthropic-Tool-Format (name/description/input_schema). lib/ai.js liest daraus direkt.
 * Beschreibungen bewusst kurz — kosten Input-Tokens.
 */
export const BOOK_CHAT_TOOLS = [
  {
    name: 'list_chapters',
    description: 'Liefert die komplette Kapitel- und Seitenliste: pro Kapitel chapter_id, Name, Seitenzahl, Wortzahl UND pages[{page_id,page_name,words}]. Zusätzlich total_pages/total_words für das ganze Buch. Nutze dies zuerst für einen Überblick – und um page_ids für get_pages zu bekommen, z.B. wenn du bei einem kleinen Buch alle Seiten laden willst.',
    input_schema: { type: 'object', properties: {}, required: [] },
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
    name: 'get_chapter_stats',
    description: 'Zusammenfassende Statistik eines Kapitels: Wortzahl, Satzzahl, Dialoganteil, Top-Figuren-Erwähnungen.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'ID des Kapitels (aus list_chapters).' },
      },
      required: ['chapter_id'],
    },
  },
  {
    name: 'get_figure_mentions',
    description: 'Wo und wie oft wird eine Figur erwähnt? Antwort nach Kapitel und Seite, mit Count je Seite. Ideal für "wann taucht X erstmals auf?". Gib figur_id (bevorzugt) ODER figur_name an.',
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
    description: 'Durchsucht das Buch nach Textstellen. Liefert Treffer mit Kurzkontext (Snippet). Standard: case-insensitive Literal-Suche; mit regex=true als Regex.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string',  description: 'Suchmuster (literal oder Regex).' },
        regex:       { type: 'boolean', description: 'true = pattern als Regex interpretieren. Default: false.' },
        max_results: { type: 'integer', description: 'Maximale Anzahl Treffer (default 10, max 30).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'get_pages',
    description: 'Lädt den vollen Text bestimmter Seiten (bei Bedarf für Zitate oder Detail-Analyse). Bis zu 20 Seiten pro Aufruf – bei kleinen Büchern kannst du in einem Call das ganze Buch laden (Page-IDs vorher via list_chapters holen). Falls für die Seite ein gespeichertes Lektorat existiert, kommt es als latest_check {checked_at, error_count, fazit, stilanalyse} mit.',
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
    name: 'list_chapter_reviews',
    description: 'Liefert die letzten Kapitelbewertungen für dieses Buch und diesen User: pro Kapitel gesamtnote (1.0–6.0), Stärken, Schwächen, Fazit, Zusammenfassung. Antwortet ohne weiteren KI-Call (liest gespeicherte chapter_reviews). Beantwortet direkt Fragen wie „welche Kapitel sind am stärksten/schwächsten?", „wo ist die Dramaturgie am besten?". ohne_bewertung listet noch nicht bewertete Kapitel.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_ids: { type: 'array', items: { type: 'integer' }, description: 'Optional: nur diese Kapitel-IDs. Ohne Angabe: alle bewerteten Kapitel.' },
        sort:        { type: 'string', enum: ['note_desc', 'note_asc', 'chapter'], description: 'Reihenfolge der reviews. Default: note_desc (stärkste zuerst).' },
        limit:       { type: 'integer', description: 'Maximale Anzahl Reviews (default 30, max 100).' },
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
    description: 'Vollständiges Profil einer Figur: Stammdaten (Typ, Geburtstag, Beruf, Rolle, Motivation, Konflikt, Entwicklung, Sozialschicht, Präsenz), Tags, Schlüsselzitate, alle Lebensereignisse (mit Kapitel/Seite), Szenen, Kapitel-Auftritte und alle Beziehungen (beide Richtungen). Schwergewichtig — für "was weißt du über X?" oder Detail-Analyse einer Figur. Gib figur_id (bevorzugt) ODER figur_name an.',
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
    name: 'get_book_review',
    description: 'Liefert die letzte gespeicherte Buchbewertung dieses Users: gesamtnote (1.0–6.0), Stärken, Schwächen, Fazit, Zusammenfassung, Modell, Datum. Antwortet ohne KI-Call (liest book_reviews). Pendant zu list_chapter_reviews, aber Buchebene. Beantwortet "wie gut ist das Buch insgesamt?" anhand der existierenden Bewertung.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_ideen',
    description: 'Listet die Notizen/Ideen, die der User im Editor zu einzelnen Seiten gespeichert hat (mit Kapitel-/Seitenkontext). Ideal um offene Anmerkungen aufzugreifen, oder zu beantworten "was wollte ich an Kapitel X noch ändern?". Filterbar nach erledigt, page_id, chapter_id. Offene Ideen erscheinen zuerst.',
    input_schema: {
      type: 'object',
      properties: {
        erledigt:   { type: 'boolean', description: 'true = nur erledigte, false = nur offene. Ohne Angabe: beide.' },
        page_id:    { type: 'integer', description: 'Nur Ideen zu dieser Seite.' },
        chapter_id: { type: 'integer', description: 'Nur Ideen zu Seiten dieses Kapitels.' },
        limit:      { type: 'integer', description: 'Maximale Anzahl (default 50, max 200).' },
      },
      required: [],
    },
  },
  {
    name: 'get_lektorat_hotspots',
    description: 'Aggregat über page_checks (letzter Check pro Seite): pro Kapitel total/avg/max Fehleranzahl plus Top-N-Seiten mit den meisten Fehlern (inkl. fazit-Snippet). Beantwortet "wo sind die schwersten Lektorat-Probleme?", "welche Kapitel brauchen am meisten Arbeit?". Schneller Überblick statt vielfacher get_pages-Aufrufe.',
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
    name: 'get_stil_metrics',
    description: 'Stil- und Lesbarkeitsmetriken aus page_stats. Drei Modi via scope: "book" (Aggregat über das ganze Buch), "chapter" (Aufschlüsselung pro Kapitel), "page" (Top-N-Seiten nach einer Metrik). Liefert words/chars/sentences/dialog_chars/dialog_ratio_percent/filler_count/passive_count/adverb_count/avg_sentence_len/sentence_len_p90/lix/flesch_de. Ideal für "wie viel Passiv im Buch?", "welche Kapitel haben am meisten Dialog?", "welche Seiten haben höchsten LIX (schwere Lesbarkeit)?".',
    input_schema: {
      type: 'object',
      properties: {
        scope:      { type: 'string', enum: ['book', 'chapter', 'page'], description: 'Aggregations-Scope. Default: book.' },
        chapter_id: { type: 'integer', description: 'Nur für scope=chapter: einzelnes Kapitel statt aller.' },
        metric:     {
          type: 'string',
          enum: ['filler_count', 'passive_count', 'adverb_count', 'sentences', 'dialog_chars', 'avg_sentence_len', 'sentence_len_p90', 'lix', 'flesch_de'],
          description: 'Nur für scope=page: nach welcher Metrik sortiert wird. Default: passive_count.',
        },
        order:      { type: 'string', enum: ['asc', 'desc'], description: 'Nur für scope=page: Sortier-Richtung. Default: desc (höchster Wert zuerst).' },
        limit:      { type: 'integer', description: 'Nur für scope=page: Anzahl Seiten (default 10, max 50).' },
      },
      required: [],
    },
  },
  {
    name: 'list_locations',
    description: 'Liefert alle Schauplätze/Orte des Buchs: Name, Typ, Beschreibung, Stimmung, erste Erwähnung, betroffene Kapitel (mit Häufigkeit), assoziierte Figuren. Pendant zu Figurenliste, aber für Orte. Filterbar nach chapter_id (nur Orte, die in diesem Kapitel vorkommen).',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'Nur Orte, die in diesem Kapitel auftauchen.' },
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
    description: 'Listet die Figuren-Werkstatt-Drafts dieses Users für das Buch: pro Draft Name, Archetyp, Quell-Figur (falls Import), notes-Vorschau, Anzahl Brainstorm-/Consistency-Läufe und Metadaten zum letzten KI-Lauf. Werkstatt-Drafts sind vom Katalog (get_figure_profile) getrennte Vorwärts-Entwicklungs-Mindmaps für Figuren. Beantwortet "an welchen Figuren arbeitet der User in der Werkstatt?".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_werkstatt_draft',
    description: 'Lädt einen Werkstatt-Draft mit kompletter Mindmap (als hierarchischer Plaintext: eingerückte Bullet-Liste der Knoten in User-Locale aufgelöst) und optional die KI-Läufe (Brainstorm-Vorschläge, Consistency-Konflikte+Fazit) gekürzt. Ideal für "was hat der User für Figur X notiert?", "was kam beim Brainstorm raus?", "welche Inkonsistenzen wurden bei der Werkstatt-Figur gefunden?". draft_id (bevorzugt) ODER figur_name angeben.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id:     { type: 'integer', description: 'Draft-ID aus list_werkstatt_drafts.' },
        figur_name:   { type: 'string',  description: 'Alternative: Name des Werkstatt-Drafts (exakt oder Substring).' },
        include_runs: { type: 'boolean', description: 'true = KI-Läufe (Brainstorm/Consistency) mitliefern. Default: true.' },
        run_limit:    { type: 'integer', description: 'Maximale Anzahl Läufe (default 5, max 20). Neueste zuerst.' },
      },
      required: [],
    },
  },
];

export function buildBookChatSystemPrompt(bookName, relevantPages, figuren, review, systemOverride = null) {
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
  ];

  if (relevantPages && relevantPages.length > 0) {
    parts.push('=== RELEVANTE BUCHSEITEN ===');
    for (const page of relevantPages) {
      parts.push(`--- Seite: ${page.name} ---`);
      parts.push(page.text);
      parts.push('');
    }
  }

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
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return parts.join('\n');
}

// ── Schemas ──────────────────────────────────────────────────────────────────

export const SCHEMA_CHAT = _obj({
  antwort: _str,
  vorschlaege: {
    type: 'array',
    items: _obj({ original: _str, ersatz: _str, begruendung: _str }),
  },
});

export const SCHEMA_BOOK_CHAT = _obj({ antwort: _str });
