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
