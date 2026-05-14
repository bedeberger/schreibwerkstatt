// Wiederverwendbare Regel-Blöcke für Lektorat- und Review-Prompts.
// Pure Funktionen – keine Modul-State-Abhängigkeiten.

export function _buildStilBlock() {
  return `
Stil-Regeln (typ: «stil»):
- «stil» ist KEIN Auffang-Eimer. Er greift NUR für stilistische Schwächen, die KEINEM spezifischeren Typ zugeordnet werden können.
- Wenn ein spezifischerer Typ passt (schwaches_verb, fuellwort, wiederholung, passiv, show_vs_tell, grammatik, rechtschreibung) → diesen Typ verwenden, NICHT «stil».
- «stil» deckt ab: holprige Wortstellung / schwerfälliger Satzbau, gestelzte oder umständliche Formulierung, Stilbruch im Register (z.B. Bürokratendeutsch in literarischem Text), unklare Bezüge / Mehrdeutigkeit, falsch gewählte Idiomatik / Kollokation, übermässige Adjektiv-/Adverb-Häufung, Nominalstil statt Verbstil, Pleonasmen / Tautologien.
- «stil» deckt NICHT ab: einzelne schwache Verben (→ schwaches_verb), einzelne Füllwörter (→ fuellwort), Wortwiederholung (→ wiederholung), abstraktes Telling (→ show_vs_tell), Passivkonstruktion (→ passiv), Grammatikfehler (→ grammatik).
- In direkter Rede / Dialog NICHT melden: Figurensprache darf holprig, gestelzt oder unidiomatisch sein – das charakterisiert die Figur. «stil» gilt ausschliesslich für Erzähltext.
- «original»: vollständiger Satz oder eindeutig abgrenzbare Phrase zeichengenau aus dem Text.
- PFLICHT: «korrektur» muss immer eine konkrete Umformulierung enthalten – nicht leer lassen, nicht dasselbe wie «original». Keine Stilanmerkung ohne konkreten Verbesserungsvorschlag.
- Selbsttest: Lässt sich die Schwäche präzise mit einem der spezifischen Typen benennen? Wenn ja → spezifischen Typ verwenden, «stil» weglassen.`;
}

// sw: explizite Stoppwort-Liste; Caller muss sie übergeben (kein globaler Fallback).
export function _buildWiederholungBlock(sw = []) {
  const swNote = sw.length > 0
    ? `\n- Stoppwörter nie melden (auch flektierte Formen): ${sw.join(', ')}`
    : '';
  return `
Wiederholung-Regeln (typ: «wiederholung»):
- Nur Inhaltswörter, die auffällig oft vorkommen: mind. 3× auf der gesamten Seite ODER 2× im selben oder direkt aufeinanderfolgenden Absatz
- LEMMA-/STAMMBASIERT zählen, nicht oberflächlich nach Wortform: «lief / läuft / gelaufen / liefen» zählen alle als Wiederholung des Stamms «laufen». «Sonne / sonnig / sonnenklar» als Stamm «Sonn-». Auch Komposita mit identischem Kern zählen mit («Hauptmann / Mannschaft / Mann»). Wortformen einzelner Lemmas separat aufzulisten ist verboten.
- Keine Pronomen, Hilfsverben, Artikel, Konjunktionen, Präpositionen, Eigennamen${swNote}
- In direkter Rede / Dialog konservativer: Wiederholungen in Figurensprache sind oft bewusste Charakterisierung – nur melden, wenn die Wiederholung den Erzähltext (nicht die Figurenrede) betrifft, oder eine Figur derart auffällig wiederholt, dass es als Sprachfehler statt Charakterisierung wirkt.
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem besten Synonym – exakt gleiche grammatische Form (Kasus, Numerus, Tempus)
- Synonym-Selbsttest vor jedem Eintrag: Klingt der Satz danach natürlich? Bedeutung erhalten? Passt zum Autorenstil?`;
}

export function _buildSchwacheVerbenBlock() {
  return `
Schwache-Verben-Regeln (typ: «schwaches_verb»):
- Schwache, blasse oder nichtssagende Verben identifizieren
- Typische schwache Verben: machen, tun, sein, haben, geben, gehen, kommen, bringen, stehen, liegen, sagen, meinen, finden u.ä.
- Nur melden, wenn ein ausdrucksstärkeres Verb den Satz spürbar verbessert — keine Pedanterie bei idiomatischen Wendungen oder Hilfsverb-Konstruktionen
- In direkter Rede / Dialog konservativer: blasse Verben in Figurensprache sind oft authentisch (Alltagston). Nur melden, wenn das Verb im Erzähltext steht oder die Figurenrede auffällig flach klingt und durch ein präziseres Verb messbar gewinnt.
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem stärkeren Verb — exakt gleiche grammatische Form und Tempus
- Selbsttest vor jedem Eintrag: Ist das Ersatzverb wirklich präziser und bildstärker? Passt es zum Stil und Ton des Textes?`;
}

export function _buildFuellwortBlock() {
  return `
Füllwort-Regeln (typ: «fuellwort»):
- Überflüssige Füllwörter identifizieren, die den Text verwässern
- Typische Füllwörter: eigentlich, irgendwie, quasi, halt, eben, wohl, ja, doch, mal, nun, also, natürlich, gewissermassen, sozusagen, durchaus, ziemlich, etwas, ein wenig, ein bisschen u.ä.
- Nur melden, wenn das Streichen oder Ersetzen den Satz strafft, ohne Bedeutung oder Stimme zu verlieren — in Dialogen können Füllwörter bewusst eingesetzt sein
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz ohne das Füllwort (oder mit knapperer Formulierung)
- Selbsttest: Verliert der Satz durch die Streichung an Rhythmus, Stimme oder Bedeutungsnuance? Dann weglassen.`;
}

export function _buildShowVsTellBlock() {
  return `
Show-vs-Tell-Regeln (typ: «show_vs_tell»):
- Stellen identifizieren, an denen Emotionen, Eigenschaften oder Zustände abstrakt benannt statt szenisch gezeigt werden
- Typische Muster:
  · «sein»/«fühlen»/«wirken» + Adjektiv für Innenleben: «Er war wütend», «Sie fühlte sich traurig», «Er wirkte nervös», «Sie schien erschöpft»
  · Zustandsverben mit Eigenschafts-Etikett: «Das Haus war alt», «Die Stimmung war gedrückt», «Es herrschte Stille»
  · Abstrakte Substantive als Subjekt oder Prädikatsnomen: «Die Schönheit der Landschaft überwältigte ihn», «Es war pure Trauer in ihren Augen», «Ein Gefühl der Einsamkeit erfasste sie»
  · Erklärende Adverbien statt Handlung: «sagte er wütend», «antwortete sie traurig»
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz umformuliert mit konkreten Sinneseindrücken, Handlungen, Körpersprache oder Details, die das Gleiche zeigen (NICHT der ganze Absatz – nur den einen Satz ersetzen)
- In direkter Rede / Dialog NICHT melden: Figuren dürfen abstrakt über ihre Gefühle sprechen («Ich bin müde»). Show-vs-Tell gilt ausschliesslich für Erzähltext.
- Nur melden, wenn eine szenische Darstellung den Text spürbar lebendiger macht — nicht jede abstrakte Aussage muss umgeschrieben werden (z.B. in Zusammenfassungen, Rückblenden oder schnellen Übergängen ist Telling erlaubt und stilistisch korrekt)
- Selbsttest: Passt die szenische Variante zum Erzähltempo und zur Szene? Nicht aufblähen. Würde die szenische Variante den Lesefluss bremsen, obwohl die Stelle gerade Tempo braucht? Dann weglassen.`;
}

export function _buildFilterwortBlock() {
  return `
Filterwort-Regeln (typ: «filterwort»):
- Wahrnehmungs-/Kognitions-Verben identifizieren, die die POV-Figur zwischen Leser und Erfahrung schieben («sah», «hörte», «fühlte», «bemerkte», «erkannte», «dachte», «beobachtete», «spürte», «schaute», «blickte», «entdeckte»). Beispiel: «Sie sah, wie er die Tür öffnete» → distanziert; «Er öffnete die Tür» → unmittelbar.
- Nur im Erzähltext aus personaler / Ich-Perspektive melden. In auktorialer Erzählweise sind Wahrnehmungsverben legitim. In direkter Rede / Dialog NICHT melden.
- Nicht melden, wenn die Wahrnehmung selbst der Punkt ist («Erst jetzt sah sie, dass …» – Erkenntnis ist Plot-Beat).
- «original»: vollständiger Satz zeichengenau aus dem Text.
- «korrektur»: derselbe Satz ohne Filter-Verb, mit der Wahrnehmungssache direkt geschildert.
- Selbsttest: Wird das Filterverb gestrichen und das Wahrgenommene direkt erzählt, gewinnt der Satz an Unmittelbarkeit? Wenn nein → weglassen.`;
}

export function _buildKlischeeBlock() {
  return `
Klischee-Regeln (typ: «klischee»):
- Abgenutzte Bildsprache, abgegriffene Metaphern, Phrasen, die in deutschsprachiger Romanprosa als Klischee gelten. Beispiele: «das Herz raste», «ein kalter Schauer lief ihm den Rücken hinunter», «Augen wie Smaragde», «die Welt blieb stehen», «Schmetterlinge im Bauch», «Gänsehaut überzog ihre Arme», «sein Blut gefror», «Tränen kullerten».
- Auch melden: schiefe Bilder / gemischte Metaphern (zwei unvereinbare Bildebenen in einem Satz), tote Vergleiche («wie ein Blitz», «schwarz wie die Nacht»), reflexartige Genre-Phrasen.
- In direkter Rede / Dialog NICHT melden: Figuren dürfen klischeehaft sprechen.
- «original»: Phrase ODER vollständiger Satz zeichengenau aus dem Text (denselben Span-Typ in «korrektur» beibehalten).
- «korrektur»: konkretes, frisches Bild oder schlichte Beschreibung – nicht das nächste Klischee.
- Selbsttest: Würde ein professioneller Lektor die Stelle als «zu abgegriffen» markieren? Bei Zweifel weglassen.`;
}

export function _buildPleonasmusBlock() {
  return `
Pleonasmus-Regeln (typ: «pleonasmus»):
- Redundanz / doppelte Bedeutung in einer Phrase. Beispiele: «weisser Schimmel», «tote Leiche», «nickte zustimmend mit dem Kopf», «zuckte mit den Schultern hoch», «zurückkehren wieder», «kleines Detail», «ganz und gar», «runde Kugel», «schwarze Dunkelheit», «hörbares Geräusch».
- Auch melden: Body-Part-Autonomy mit redundantem Bezug («seine Augen blickten ihn an»), tautologische Adjektiv-Substantiv-Paare.
- Nicht melden, wenn die Doppelung als bewusste Verstärkung lesbar ist (Lyrik, ironisches Register, Figurenrede mit Charakterisierung).
- «original»: die redundante Phrase zeichengenau aus dem Text (Span = Phrase).
- «korrektur»: dieselbe Phrase ohne Redundanz – nur die nicht-überflüssige Komponente bleibt stehen.
- Selbsttest: Geht Information verloren, wenn der redundante Teil gestrichen wird? Wenn nein → melden.`;
}

export function _buildFigurenkonsistenzBlock() {
  return `
Figurenkonsistenz-Regeln (typ: «namenskonsistenz», «figurenmerkmal», «anrede»):
- Diese Typen werden AUSSCHLIESSLICH gegen den oben gelieferten Figuren-Block + Beziehungs-Block geprüft. KEINE externe Welt-Annahme, kein Schluss aus Eigennamen-Klang, kein Raten. Wenn der Stamm zur Stelle schweigt (keine entsprechende Eigenschaft / Beziehung dokumentiert) → Eintrag verwerfen.
- typ «namenskonsistenz»:
  · Eine Figur wird mit einer Schreibvariante genannt, die weder ihrem «name» noch ihrem «kurzname» im Figuren-Block entspricht (z.B. «Hannah» wo der Stamm «Hanna» sagt; «Mayer» wo der Stamm «Meier» sagt).
  · Span: einzelnes Wort (der falsch geschriebene Name).
  · «korrektur»: kanonische Schreibweise aus dem Stamm.
  · «erklaerung»: MUSS die kanonische Form aus dem Figuren-Block zitieren («laut Figurenkartei: Hanna»).
- typ «figurenmerkmal»:
  · Eine Aussage im Text widerspricht einer im Figuren-Block dokumentierten Eigenschaft: Geschlecht/Pronomen (Stamm «weiblich» → Text «er»), Beruf, etablierte Beschreibung (Aussehen / Alter / Herkunft) sofern explizit im Stamm hinterlegt.
  · Span: Phrase (das widersprüchliche Wort / die widersprüchliche Phrase).
  · «korrektur»: Phrase im selben Span-Typ, korrigiert gegen den Stamm.
  · «erklaerung»: MUSS Quelle nennen («laut Figurenkartei: weiblich, Pronomen «sie»» bzw. «laut Figurenkartei: Lehrerin»).
- typ «anrede»:
  · Du/Sie + Anrede­form widerspricht der etablierten Beziehung im Beziehungs-Block (z.B. «Sie» an einen Bruder, «du» an einen Vorgesetzten).
  · Span: die Anrede-Phrase.
  · «korrektur»: Anrede passend zur Beziehung.
  · «erklaerung»: MUSS Beziehungs-Typ aus dem Beziehungs-Block zitieren («laut Beziehungen: Geschwister – duzen üblich»).
- Nicht melden in direkter Rede, wenn die Abweichung als Charakterisierung lesbar ist (Figur lügt, irrt, beleidigt absichtlich, sieztgesteltt) – das ist Subtext, kein Fehler.
- Severity-Schwelle: nur melden, wenn der Widerspruch deutlich ist und ein Lektor ihn anstreichen würde. Bei Unklarheit / Stamm-Schweigen / mehrdeutiger Stelle: weglassen.`;
}

export function _buildSchauplatzkonsistenzBlock() {
  return `
Schauplatzkonsistenz-Regeln (typ: «schauplatzmerkmal»):
- Wird AUSSCHLIESSLICH gegen den oben gelieferten Schauplätze-Block geprüft. KEINE externe Welt-Annahme. Wenn der Stamm zur Stelle schweigt → verwerfen.
- Aussage im Text widerspricht einer im Orts-Block dokumentierten Eigenschaft: Typ (Stadt/Dorf/Wald/…), Stimmung, etablierte Beschreibung (Grösse, Lage, Merkmale) sofern explizit hinterlegt.
- «original»: Phrase zeichengenau aus dem Text.
- «korrektur»: Phrase, korrigiert gegen den Stamm.
- «erklaerung»: MUSS Quelle nennen («laut Orts-Kartei: kleines Dorf, nicht Stadt»).
- Nicht melden bei nachvollziehbarer dramaturgischer Veränderung im Plot (Ort wurde im Verlauf zerstört, umgebaut, anders geworden) – nur Widersprüche zur etablierten Welt, nicht zur Welt-Entwicklung.
- Severity-Schwelle: nur deutliche Widersprüche. Stamm-Schweigen → kein Eintrag.`;
}

export function _buildDialogformatBlock() {
  return `
Dialogformat-Regeln (typ: «dialogformat»):
- Typografische Korrektheit der direkten Rede. Sprache des Textes bestimmen, dann gegen die passende Norm prüfen. Innerhalb eines Buchs muss die Wahl konsistent sein – etablierte Variante des Buchs ist die Norm, Abweichungen davon sind Findings.
- Deutsch:
  · Anführungszeichen: «„…"» (U+201E unten, U+201C oben) ODER «…» (Guillemets, Spitzen nach aussen). Konsistent innerhalb des Buchs. Gerade ASCII-Quotes ("…", '…') sind in Romanprosa falsch.
  · Zitat im Zitat: ‚…' (halbe Gänsefüsschen).
  · Inquit-Komma nach Schlusszeichen: «„Komm her", sagte sie.» – Komma steht nach dem schliessenden Anführungszeichen; Inquit-Verb kleingeschrieben.
  · Inquit nach !/?: «„Komm her!" rief sie.» – Satzzeichen bleibt drin, KEIN zusätzliches Komma, Inquit-Verb klein.
  · Eigenständiger Folgesatz statt Inquit: «„Komm her." Sie lächelte.» – Punkt am Ende der Rede, Grossbuchstabe folgt.
  · Eingeschobenes Inquit: «„Komm her", sagte sie, „aber leise."» – Fortsetzung der Rede klein.
- Englisch:
  · Anführungszeichen: "…" (double quotes, typografisch). Zitat im Zitat: '…' (single).
  · Satzzeichen IMMER innerhalb der Quotes: «"Come here," she said.» – Komma vor schliessendem «"», Tag lowercase.
  · Inquit nach !/?: «"Come here!" she shouted.» – Punkt/Komma durch !/? ersetzt, Tag lowercase.
  · Eigenständiger Folgesatz: «"Come here." She smiled.» – Punkt INNERHALB der Quotes, Grossbuchstabe folgt.
  · Unterbrochene Rede: «"Wait—"» (em-dash). Verlöschende Rede: «"I don't…"» (Ellipsis).
- Sprecherwechsel: neuer Absatz. Mehrere Sätze desselben Sprechers bleiben im selben Absatz.
- «original»: Phrase zeichengenau aus dem Text – exakt der typografisch falsche Bereich (Schlussklammer + Inquit-Übergang, einzelnes falsches Anführungszeichen, falsche Komma-Position, falsch grossgeschriebenes Tag-Verb).
- «korrektur»: dieselbe Phrase typografisch korrekt; gleicher Span-Typ.
- «erklaerung»: EIN Satz, benennt die verletzte Regel («Komma gehört vor das schliessende Anführungszeichen», «Inquit-Verb nach Komma kleinschreiben», «gerade ASCII-Quotes statt typografischer Gänsefüsschen», …).
- NICHT melden: Anführungszeichen-Stil, der im Buch durchgehend konsistent gewählt ist (das ist die Norm des Buchs, nicht ein Fehler). Brief-/SMS-/Tagebuch-Einschübe mit eigener Konvention. Einzelne hervorgehobene Wörter in Quotes (keine echte Rede).
- Selbsttest: Würde ein Lektor diese Stelle als typografisch falsch oder uneinheitlich anstreichen? Wenn die Wahl bewusst und konsequent durchgehalten ist → weglassen.`;
}

export function _buildPassivBlock() {
  return `
Passivkonstruktionen-Regeln (typ: «passiv»):
- Vermeidbare Passivkonstruktionen identifizieren, die den Text schwerfällig oder unpersönlich machen
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz in aktiver Formulierung — das handelnde Subjekt klar benennen
- In direkter Rede / Dialog konservativer: Passiv in Figurensprache spiegelt oft Sprechgewohnheit oder Distanz – nur melden, wenn die Konstruktion auch im Dialog spürbar holprig wirkt.
- Nicht melden, wenn das Passiv bewusst eingesetzt wird (Täter unbekannt/unwichtig, wissenschaftlicher Stil, Betonung auf dem Objekt) oder die aktive Variante gezwungen klingt
- Selbsttest: Ist die aktive Formulierung wirklich klarer und lebendiger? Klingt sie natürlich im Kontext?`;
}

export function _buildPerspektivbruchBlock() {
  return `
Perspektivbruch-Regeln (typ: «perspektivbruch»):
- WENN oben ein Block «Etablierte Erzählform des Buchs» angegeben ist, ist DAS die verbindliche Referenz – primär gegen diese Vorgabe prüfen, nicht gegen Default-Annahmen über den Text. Eine Stelle, die der vorgegebenen Erzählperspektive widerspricht, ist ein Bruch (sofern nicht durch eine der Ausnahmen unten gedeckt).
- WENN kein Erzählform-Block vorliegt: die in den ersten Absätzen der Seite etablierte Perspektive aus dem Text ableiten und gegen Abweichungen prüfen.
- Stellen identifizieren, an denen die Erzählperspektive innerhalb einer Szene unbeabsichtigt wechselt
- Typische Brüche: Wissen oder Gedanken einer Figur beschreiben, die nicht die aktuelle Perspektivfigur ist; plötzlicher Wechsel zwischen Ich-Erzähler und auktorialem Erzähler; Informationen, die der Perspektivfigur nicht zugänglich sind
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz so umformuliert, dass er zur etablierten Perspektive der Szene passt
- «erklaerung»: benennen, welche Perspektive etabliert ist (mit Verweis auf den Erzählform-Block, falls vorhanden) und worin der Bruch besteht
- Nicht melden bei bewusst auktorialer Erzählweise oder bei expliziten Perspektivwechseln (z.B. nach Szenenumbruch); nicht in direkter Rede / Dialog (Figuren reden aus ihrer eigenen Perspektive); nicht in zitierten Briefen / Tagebucheinträgen.`;
}

export function _buildTempuswechselBlock() {
  return `
Tempuswechsel-Regeln (typ: «tempuswechsel»):
- WENN oben ein Block «Etablierte Erzählform des Buchs» angegeben ist, ist DAS die verbindliche Referenz – primär gegen diese Vorgabe prüfen, nicht gegen Default-Annahmen. Ein Satz im Präsens innerhalb eines per Buch-Konfiguration auf Präteritum festgelegten Erzähltextes ist ein Bruch (sofern nicht durch eine der Ausnahmen unten gedeckt).
- WENN kein Erzählform-Block vorliegt: das in den ersten Absätzen der Seite dominante Tempus aus dem Text ableiten und gegen Abweichungen prüfen.
- Unbeabsichtigte Wechsel der Erzählzeit innerhalb einer Szene oder eines Abschnitts identifizieren
- Typisch: Erzählung im Präteritum mit plötzlichem Wechsel ins Präsens (oder umgekehrt), ohne dass ein Stilmittel erkennbar ist
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz im korrekten Tempus der umgebenden Passage
- «erklaerung»: benennen, welches Tempus in der Passage etabliert ist (mit Verweis auf den Erzählform-Block, falls vorhanden) und welches im Satz verwendet wird
- Nicht melden bei: Plusquamperfekt für Rückblenden, historischem Präsens als bewusstem Stilmittel, Tempuswechsel in direkter Rede / Dialog (Figuren sprechen in ihrer eigenen Zeit), zitierten Briefen / Tagebucheinträgen / Nachrichten, Wechsel an Szenen-/Kapitelgrenzen`;
}

/**
 * Erzeugt den Erzählform-Kontextblock für Bewertungs-/Lektorat-Prompts.
 * Bei buchtyp='kurzgeschichten' wird die Angabe als Richtwert deklariert, da
 * einzelne Kurzgeschichten legitim eine andere Perspektive oder Erzählzeit
 * verwenden können. Gibt '' zurück, wenn weder perspektive noch zeit gesetzt
 * sind (kein Block im Prompt).
 *
 * @param {string|null} perspektive  lesbares Label (z.B. '3. Person personal')
 * @param {string|null} zeit         lesbares Label (z.B. 'Präteritum')
 * @param {string|null} buchtyp      Buchtyp-Key (z.B. 'kurzgeschichten')
 * @param {'lektorat'|'review'} mode 'lektorat' verweist auf perspektivbruch/tempuswechsel;
 *                                   'review' bleibt neutraler ("Konsistenzprüfung")
 */
export function _buildErzaehlformBlock(perspektive, zeit, buchtyp, mode = 'lektorat') {
  if (!perspektive && !zeit) return '';
  const isShortStories = buchtyp === 'kurzgeschichten';
  const header = isShortStories
    ? 'Erzählform der Sammlung (Richtwert – einzelne Kurzgeschichten dürfen legitim abweichen; Abweichungen NICHT als Fehler melden, wenn sie in sich konsistent bleiben):'
    : (mode === 'review'
      ? 'Etablierte Erzählform des Buchs (Referenz für Konsistenz- und Stilprüfung – abweichende Passagen sind Bruchstellen, sofern nicht dramaturgisch begründet):'
      : 'Etablierte Erzählform des Buchs (verbindliche Referenz für «perspektivbruch» und «tempuswechsel» – abweichende Stellen gegen diese Vorgabe prüfen, nicht gegen Default-Annahmen):');
  const lines = [
    perspektive ? `- Erzählperspektive: ${perspektive}` : null,
    zeit        ? `- Erzählzeit: ${zeit}`              : null,
  ].filter(Boolean);
  const scopeNote = `- Gilt NUR für den narrativen Erzähltext. KEIN Bruch ist in folgenden Fällen: direkte Rede / Dialog (Figuren sprechen in ihrer eigenen Zeit), innere Monologe in direkter Form, zitierte Briefe / Tagebuch­einträge / Nachrichten / Dokumente im Roman, erlebte Rede, historisches Präsens als bewusstes Stilmittel, Rückblenden (Plusquamperfekt) und Antizipationen (Futur), sowie Wechsel an Szenen-/Kapitelgrenzen.`;
  return `\n${header}\n${lines.join('\n')}\n${scopeNote}\n`;
}
