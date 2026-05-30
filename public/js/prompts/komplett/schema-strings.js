// Geteilte Schema-Text- und Regel-Bausteine der Komplett-Pipeline.
// Reine Strings/Funktionen ohne Provider-State – von extraktion.js, figuren.js,
// konsolidierung.js und kontinuitaet.js konsumiert.

// ── Figurenextraktion (Basis – ohne Lebensereignisse) ─────────────────────────

export const FIGUREN_BASIS_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|randfigur|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "wohnadresse": "Wohnort/Wohnadresse der Figur oder leer wenn nicht belegt",
      "rolle": "1 Satz: Funktion in der Handlung (z.B. 'Ermittelt den Mordfall', 'Erzählerin, blickt rückblickend zurück')",
      "motivation": "1 Satz: was die Figur antreibt; leer wenn nicht belegt",
      "konflikt": "1 Satz: zentraler innerer oder äusserer Konflikt; leer wenn nicht belegt",
      "beschreibung": "2-3 Sätze: Rolle + Persönlichkeit + Bedeutung, textnah",
      "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "praesenz": "zentral|regelmaessig|punktuell|randfigur",
      "entwicklung": "statisch|Kurzbeschreibung des Wandels (1 Satz, z.B. 'verliert Vertrauen in Mentor')",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "schluesselzitate": ["Bis zu 3 charakterisierende Zitate, wörtlich aus dem Text"],
      "kapitel": [{ "name": "Kapitelname" }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|patronage|geschaeft|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz", "belege": [{ "kapitel": "Kapitelname (ohne ##-Präfix)", "seite": "Seitentitel (ohne ###-Präfix); leer wenn = Kapitel oder unklar" }] }]
    }
  ]
}`;

// Stammdaten-Variante OHNE Beziehungen (Claude-Single-Pass A1; Beziehungen folgen im A2-Pass).
// Aus FIGUREN_BASIS_SCHEMA abgeleitet, damit neue Felder automatisch mitwandern – die
// beziehungen-Zeile wird entfernt und das dadurch entstehende Trailing-Comma bereinigt.
export const FIGUREN_STAMM_SCHEMA = FIGUREN_BASIS_SCHEMA
  .split('\n')
  .filter(l => !l.trimStart().startsWith('"beziehungen"'))
  .join('\n')
  .replace(/,(\s*\}\s*\]\s*\})\s*$/, '$1');

export const figurenBasisRules = (kontext = '') => `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; name = immer der Kapitelname (aus dem ## Kapitel-Header über dem Abschnitt oder aus dem Prompt-Kontext) – NIEMALS Seitentitel als Kapitelnamen verwenden. haeufigkeit (= Anzahl Seiten/Abschnitte mit aktivem Auftreten) NUR ergänzen wenn >1; bei Einzelauftreten weglassen.
- typ: Figuren-Archetyp. hauptfigur=trägt zentral die Handlung, antagonist=Gegenspieler, mentor=Anleiter/Lehrerin, nebenfigur=klar identifizierbarer Sekundärcharakter mit mehreren Auftritten, randfigur=tritt nur am Rand in Erscheinung (kaum mehr als Erwähnung), andere=nicht zuordenbar. NICHT mit praesenz verwechseln (Typ = Rolle, Präsenz = Handlungsgewicht).
- praesenz: Gewichtung der Figur im Gesamtbuch. zentral=Haupthandlungsträger, regelmaessig=wiederkehrend und handlungsrelevant, punktuell=taucht in einzelnen Szenen auf, randfigur=kaum mehr als Erwähnung. Bei Einzelkapitel-Analyse: Einschätzung basiert nur auf diesem Kapitel.
- rolle / motivation / konflikt: je 1 Satz, textnah. Leer lassen wenn nicht belegt – nicht spekulieren.
- beschreibung: 2-3 Sätze Zusammenfassung (Fallback für Anzeige und Chat-Kontext). Soll KEINE Spekulation enthalten.
- schluesselzitate: bis zu 3 wörtliche Zitate (max. 80 Zeichen) die die Figur charakterisieren – exakt aus dem Text, in der Original-Interpunktion. Leer lassen wenn keine prägnanten Stellen gefunden.
- erste_erwaehnung: Kapitel- oder Seitenname der ersten Erwähnung (so präzise wie belegt). Leer wenn unklar.
- wohnadresse: Wohnort oder Wohnadresse der Figur, so präzise wie textnah belegt (z.B. «Zürich», «Bahnhofstrasse 12, Bern», «kleines Bauernhaus am Waldrand»). Nur ausfüllen wenn explizit aus dem Text hervorgeht. Leer wenn nicht erwähnt – nicht spekulieren.
- entwicklung: "statisch" wenn die Figur über das Buch hinweg unverändert bleibt, sonst 1 Satz zum Wandel. Leer wenn nicht eindeutig.
- sozialschicht: gesellschaftliche Schicht der Figur${kontext ? ` (${kontext})` : ''} – nur vergeben wenn eindeutig belegt; wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation, prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig
- beziehungen.machtverhaltnis: ganzzahlig im Bereich -2 bis 2 (KEIN führendes Plus-Zeichen). Machtasymmetrie: 2=Gegenüber (figur_id) dominiert klar, 1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- beziehungen.belege: HÖCHSTENS 1 Stelle (Kapitelname + Seitentitel) an der die Beziehung klar wird. Genau wie im Text stehen lassen; leer lassen wenn unsicher. seite leer lassen wenn identisch mit dem Kapitelnamen (z.B. 1 Seite pro Kapitel) oder unklar. Seitennamen aus ### Überschriften, Kapitelnamen aus ## Überschriften oder dem Prompt-Kontext.
- Beziehungstypen: typ beschreibt die ROLLE von figur_id (NICHT der aktuellen Figur!). Bei Figur X der Eintrag {figur_id: Y, typ: elternteil} bedeutet: Y IST der Elternteil von X. Konkretes Beispiel: Robert hat Mutter Sandra → bei Robert eintragen {figur_id: «<Sandras fig_id>», typ: elternteil, machtverhaltnis: 2}. patronage=Schutzherrschaft (figur_id = Patron), geschaeft=wirtschaftliche Beziehung, geschwister=undirektional, übrige selbsterklärend
- Pro Figurenpaar höchstens EINE Beziehung eintragen – aus der Perspektive EINER Figur. Keine widersprüchlichen Angaben (z.B. nicht gleichzeitig elternteil und kind für dasselbe Paar)
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin)
- Sortiert nach Wichtigkeit (zentral zuerst)
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren. Leere Strings/Arrays sind besser als erfundene Inhalte.
- DEDUPLIZIERUNG MIT KONTEXTABGLEICH: Figuren zusammenführen wenn der Name übereinstimmt (gleicher Vor- und Nachname) ODER ein Teilname (nur Vorname oder nur Nachname) mit mindestens einem inhaltlichen Indiz zusammenpasst – z.B. gleicher Beruf, überschneidende Fachkenntnisse, konsistente Charakterzüge oder übereinstimmendes Verhalten kapitelübergreifend. Beispiel: «Maria» die in Kapitel 1 als Kräuterkundige gilt und «Maria Huber» die in Kapitel 3 Naturheilkunde beherrscht – zusammenführen. Widersprechen sich Eigenschaften eindeutig, getrennt behalten. Gibt es nur Namensähnlichkeit ohne inhaltliche Überschneidung: getrennt behalten.`;

// ── Schauplatz-Schemata (auch verwendet in Komplett-Analyse) ─────────────────

export const ORTE_SCHEMA = `{
  "orte": [
    {
      "id": "ort_1",
      "name": "Name des Schauplatz",
      "typ": "stadt|gebaeude|raum|landschaft|region|andere",
      "beschreibung": "2-3 Sätze zu Erscheinungsbild, Atmosphäre, Bedeutung für die Handlung",
      "land": "ISO-3166-1-alpha-2-Ländercode des Schauplatzes in Kleinbuchstaben (z.B. ch, de, fr, us); leer wenn nicht bestimmbar",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "stimmung": "Grundatmosphäre in 2-3 Worten (z.B. bedrohlich, heimelig, verlassen, belebt)",
      "kapitel": ["Kapitelname"],
      "figuren": ["fig_1", "fig_2"]
    }
  ]
}`;

export const ORTE_RULES = `Regeln:
- Eindeutige IDs (ort_1, ort_2, …)
- SEHR GROSSZÜGIG erfassen: alle Schauplätze inklusive Nebenschauplätze und einmaliger Erwähnungen; lieber inkludieren als weglassen. haeufigkeit=1 ist gültig.
- figuren: nur IDs aus der gelieferten Figurenliste (leer lassen wenn keine Figuren bekannt)
- kapitel: flaches Array der Kapitelnamen (Strings), in denen der Ort aktiv vorkommt – jeder Kapitelname höchstens einmal
- land: ISO-3166-1-alpha-2 in Kleinbuchstaben. Belege das Land aus dem Text (genannte Stadt/Region/Land). Ist im Text kein anderes Land erkennbar, ordne den Ort dem HAUPT-SCHAUPLATZLAND des Buchs zu (falls im Kontext angegeben). Reine Innenräume/Gebäude ohne geografischen Hinweis erben das Land der umgebenden Stadt/Region. Nur leer lassen, wenn weder Text noch Hauptland eine Zuordnung erlauben.
- Kein Cap auf Anzahl Orte – vollständige Erfassung wichtiger als Kürze`;

// ── Musik-Schema (Songs/Musikstücke) ────────────────────────────────────────
// Parallel zu ORTE_SCHEMA. Pflicht-Feld kontext_typ (hört/spielt/erwähnt/
// leitmotiv/diegetisch); figuren = wer hört/spielt/komponiert/singt.

export const SONGS_SCHEMA = `{
  "songs": [
    {
      "id": "song_1",
      "titel": "Exakter Titel des Songs/Stücks wie im Text genannt",
      "interpret": "Interpret, Band, Komponist oder Soundtrack (leer wenn nicht belegt)",
      "genre": "Hip-Hop|Rock|Pop|Klassik|Jazz|Electronic|Volksmusik|Soundtrack|Schlager|Punk|Metal|Country|Blues|Folk|R&B|Reggae|Chanson|Lied|Hymne|andere – leer wenn unklar",
      "kontext_typ": "hört|spielt|erwähnt|leitmotiv|diegetisch",
      "beschreibung": "1-2 Sätze: in welcher Szene/Situation der Song auftaucht, welche Funktion er hat",
      "stimmung": "Grundatmosphäre in 2-3 Worten (z.B. melancholisch, euphorisch, beklemmend)",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 2 }],
      "figuren": ["fig_1", "fig_2"]
    }
  ]
}`;

export const SONGS_RULES = `Regeln:
- Eindeutige IDs (song_1, song_2, …)
- SEHR GROSSZÜGIG erfassen: jeden namentlich genannten Song, Track, Klassik-Stück, Hymne, Soundtrack, jede konkrete Band/Interpret-Erwähnung als eigenen Eintrag, auch bei einmaliger Erwähnung.
- KEINE generischen Genre-Erwähnungen ohne konkreten Titel/Interpret («Klassische Musik im Hintergrund» reicht nicht). Pflicht: mindestens titel ODER interpret.
- kontext_typ: «hört» = Figur konsumiert (Radio, Kopfhörer, Konzert); «spielt» = Figur produziert aktiv (Instrument, Gesang); «erwähnt» = Song wird im Dialog/Erzähltext genannt, ohne dass jemand ihn hört oder spielt; «leitmotiv» = Song zieht sich als wiederkehrendes Motiv durchs Buch; «diegetisch» = Musik im Hintergrund einer Szene (Bar, Auto, Party) ohne aktive Figur-Bindung.
- figuren: nur IDs aus der gelieferten Figurenliste (leer lassen wenn keine Figur klar zuordenbar oder Figurenliste fehlt)
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Vorkommen
- Klassische Stücke ohne Interpret: Komponist als interpret eintragen («Beethoven» für «Mondscheinsonate»)
- Kein Cap – vollständige Erfassung wichtiger als Kürze`;

// ── Fakten-Schema (verwendet in Komplett-Analyse und Kontinuität) ────────────

export const FAKTEN_SCHEMA = `"fakten": [
    {
      "kategorie": "figur|ort|objekt|zeit|ereignis|soziolekt|sonstiges",
      "subjekt": "Über wen/was geht es (Name oder Bezeichnung)",
      "fakt": "Was genau behauptet wird (1 Satz, so präzise wie möglich)",
      "seite": "Seitenname oder Abschnittsname (leer wenn unklar)"
    }
  ]`;

export const FAKTEN_RULES = `Fakten-Regeln:
- Nur konkrete, prüfbare Aussagen – keine Interpretationen
- Figuren-Zustände besonders genau erfassen (Wissen, Können, körperlicher Zustand, Wohnort, Beruf)
- Soziolekt: Wenn eine Figur erstmals oder markant spricht, ein Faktum erfassen das ihr Sprachregister beschreibt. Kategorie «soziolekt» verwenden.
- Objekte: Wer besitzt was, wo liegt was, in welchem Zustand
- Zeitangaben: Relative («am nächsten Morgen») und absolute («1943») erfassen
- Kein Cap auf Anzahl Fakten – vollständige, präzise Erfassung wichtiger als Kürze`;

// ── Kontinuitäts-Probleme-Schema (verwendet in Check und SinglePass) ─────────

export const PROBLEME_SCHEMA = `{
  "_reasoning": "Knappe Stichpunkte (max 6 Zeilen) zu deinem Vorgehen: 1) zentrale Fakten/Behauptungen, die du gesammelt hast; 2) paarweise Vergleiche, die du angestellt hast (welche Stellen gegen welche?); 3) Kandidaten, die du verworfen hast (mit Kurz-Begründung – z.B. ‹durch Rückblende erklärbar›, ‹im selben Kapitel auflösbar›); 4) bestätigte Widersprüche, die ins probleme-Array kommen.",
  "probleme": [
    {
      "schwere": "kritisch|mittel|niedrig",
      "typ": "figur|zeitlinie|ort|objekt|verhalten|soziolekt|sonstiges",
      "beschreibung": "Was genau widerspricht sich (1-2 Sätze)",
      "stelle_a": "Kapitel + wörtliches Zitat (5-15 Wörter) der widersprechenden Aussage",
      "stelle_b": "Kapitel + wörtliches Zitat (5-15 Wörter) der Gegen-Aussage",
      "figuren": ["Name der direkt betroffenen Figur"],
      "kapitel": ["Exakter Kapitelname A", "Exakter Kapitelname B"],
      "empfehlung": "Wie könnte das aufgelöst werden (1 Satz)"
    }
  ],
  "zusammenfassung": "Gesamteinschätzung der Konsistenz des Buchs in 2-3 Sätzen"
}`;

export const PROBLEME_RULES = `Beispiel eines korrekten Eintrags:
{
  "schwere": "kritisch",
  "typ": "figur",
  "beschreibung": "Marek stirbt im Bombenangriff, taucht zwei Kapitel später lebend auf.",
  "stelle_a": "Kapitel 3: «Marek lag reglos unter den Trümmern»",
  "stelle_b": "Kapitel 5: «Marek öffnete die Tür und lachte»",
  "figuren": ["Marek"],
  "kapitel": ["Kapitel 3", "Kapitel 5"],
  "empfehlung": "Tod in Kapitel 3 abschwächen oder Rückkehr im Text erklären."
}

Regeln:
- Zitat-Pflicht: «stelle_a» UND «stelle_b» MÜSSEN je die konkrete widersprechende Aussage belegen (5-15 Wörter, in «»). Liegt dir der Buchtext vor, zitiere wörtlich aus dem Text; liegen dir nur extrahierte Fakten vor, zitiere die betreffende Fakt-Aussage. Kannst du für eine der beiden Stellen keinen solchen Beleg angeben, melde den Widerspruch NICHT. Keine erfundenen Stellen.
- Reasoning-First: «_reasoning» MUSS das erste Feld im JSON-Output sein. Denke dort schrittweise nach, BEVOR du «probleme» befüllst. Reihenfolge der Schritte: (1) Fakten, (2) paarweise Vergleiche, (3) verworfene Kandidaten mit Grund, (4) bestätigte Widersprüche. Knapp halten, Stichpunkte reichen.
- «probleme» enthält NUR die im _reasoning unter (4) bestätigten Widersprüche – jeden verworfenen Kandidaten lässt du weg, NIE als Eintrag mit «Eintrag entfernen»-Empfehlung.
- Nur echte Widersprüche – keine stilistischen oder inhaltlichen Anmerkungen
- WICHTIG: Wenn du bei der Analyse zum Schluss kommst, dass KEIN Widerspruch vorliegt (z.B. «konsistent», «passt», «kein echter Widerspruch»), dann das Problem NICHT melden. Nur tatsächliche Widersprüche ins Array aufnehmen.
- Das «probleme»-Array ist AUSSCHLIESSLICH für bestätigte Widersprüche da – nicht für Zwischenüberlegungen, geprüfte-aber-verworfene Kandidaten oder Entwarnungen. Wenn ein Kandidat sich beim Nachdenken als harmlos herausstellt, wird er komplett weggelassen, nicht mit einer Erklärung ins Array geschrieben.
- Selbstcheck vor dem Antworten: Lies jede «beschreibung» UND jede «empfehlung» gegen. Enthält EINES der beiden Felder Formulierungen wie «kein Widerspruch», «kein echter Widerspruch», «konsistent», «passt zusammen», «stimmig», «wird nicht gemeldet», «Entwarnung», «unproblematisch», «das ist korrekt», «kein Problem», «Eintrag entfernen», «lässt sich erklären durch …» (als Entwarnung) – dann den ganzen Eintrag ersatzlos aus dem Array entfernen. «beschreibung» muss den Widerspruch positiv benennen, «empfehlung» muss eine Lösung des Widerspruchs vorschlagen – niemals «Eintrag entfernen» oder ähnliche Selbst-Annullierungen.
- schwere: «kritisch» = klarer Logikfehler der dem Leser sofort auffällt und zwingend korrigiert werden muss; «mittel» = wahrscheinlicher Fehler der den Leser stören könnte; «niedrig» = mögliche Inkonsistenz die eventuell beabsichtigt ist
- Soziolekt-Probleme: nur wenn klar ein Sprachmuster etabliert wurde und dann ohne Begründung bricht – nicht melden wenn Figur wenig Dialoganteil hat
- figuren: PFLICHTFELD – immer angeben, mindestens []; Namen exakt wie in der Figurenliste; [] nur wenn wirklich keine Figur betroffen (rein ortsbezogene Widersprüche)
- kapitel: PFLICHTFELD – immer angeben, mindestens []; exakte Kapitelnamen aus stelle_a/stelle_b; wenn beide Stellen im selben Kapitel nur einmal; [] nur wenn der Text keine Kapitelinformation enthält
- Wenn keine Widersprüche gefunden: «probleme» als leeres Array, «zusammenfassung» = positive Einschätzung
- Konservativ: Im Zweifel weglassen – lieber ein echtes Problem übersehen als ein Nicht-Problem melden`;

// Hilfsfunktion: Extrahiert den Inhalt des äussersten Objekts aus einem Schema-String.
// Ermöglicht das Zusammensetzen von Schemas ohne Duplikation der Felddefinitionen.
export function _schemaBody(schemaStr) {
  return schemaStr.trim().replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '').trim();
}

// Geteilter Lebensereignis-Schema-Block (Pass A lokal + Claude-A1-Stammpass).
export const _ASSIGNMENTS_SCHEMA_BLOCK = `"assignments": [
    {
      "figur_name": "Figurenname exakt wie im Text",
      "lebensereignisse": [
        {
          "datum": "Original-Datum-Notation (JJJJ, JJJJ-MM, JJJJ-MM-TT, «Mai 1850», «Tag 3», «vor der Reise», …)",
          "datum_label": "User-lesbarer Original-String.",
          "datum_year":  1850,         // null wenn unbekannt
          "datum_month": null,
          "datum_day":   null,
          "datum_ende_year":  null,    // Spanne: Ende-Jahr
          "datum_ende_month": null,
          "datum_ende_day":   null,
          "story_tag":   null,         // Relative Story-Zeit
          "subtyp":      "sonstiges",  // geburt|tod|hochzeit|reise|konflikt|wendepunkt|entdeckung|verlust|sieg|extern_politisch|extern_natur|extern_kulturell|sonstiges
          "ereignis": "Was passierte – neutral formuliert. Gleiches Ereignis bei allen beteiligten Figuren identisch.",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für diese Figur (1 Satz, leer wenn nicht klar)",
          "seite": "EXAKT ein ### Seiten-Header aus dem aktuellen ## Kapitel. NIE der Kapitelname. Leer wenn unklar.",
          "kapitel": "EXAKT der ## Kapitel-Header (nicht ###); leer wenn unklar"
        }
      ]
    }
  ]`;

export const _EREIGNIS_RULES = `Ereignis-Regeln:
- typ='persoenlich' / typ='extern' wie oben dokumentiert.
- datum_label = Original-String; datum_year/month/day strukturiert zerlegen (null wenn unbekannt). Events ohne Datums-Information trotzdem aufnehmen (alles null).
- Spannen (Krieg, Reise, Studium): Start in datum_*, Ende in datum_ende_*.
- subtyp aus Whitelist; persoenlich → geburt|tod|hochzeit|reise|konflikt|wendepunkt|entdeckung|verlust|sieg|sonstiges; extern → extern_politisch|extern_natur|extern_kulturell|sonstiges.
- Nur Figuren ausgeben die mindestens ein Ereignis haben.`;
