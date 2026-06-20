// Stilprofil-Extraktion: destilliert aus einer Leseprobe den Autorenstil zu
// einem kompakten, editierbaren Profiltext. Persona lebt in core.js
// (SYSTEM_STILPROFIL), hier nur User-Prompt-Builder + Schema.
//
// Das Ergebnis wird pro Buch in book_settings.stilprofil gespeichert und in
// text-erzeugende Prompts (Lektorat/Synonym/Chat) als Imitations-Referenz sowie
// in Buch-/Kapitel-Review als Massstab fuer Stimmen-Treue injiziert. Es ist
// rein deskriptiv – kein Werturteil, keine Textfortschreibung.

import { _obj, _str } from './schema-utils.js';

export function buildStilprofilPrompt(text) {
  return `Destilliere aus der folgenden Leseprobe ein kompaktes, präzises STILPROFIL des Autors. Es soll später Korrektur- und Textvorschläge so steuern, dass sie nach diesem Autor klingen – beschreibe daher den Stil so konkret, dass eine andere Instanz ihn nachahmen könnte.

Vorgehen:
- Beschreibe NUR, was die Leseprobe belegt. Nicht werten («gut»/«schwach»), nicht den Text fortschreiben, keine Verbesserungsvorschläge.
- Konkret statt allgemein: «kurze, parataktische Hauptsätze, selten länger als 12 Wörter» statt «klarer Stil». Wo möglich mit knappem Beispiel-Beleg (1-3 Wörter) aus dem Text.
- Wenn ein Aspekt uneinheitlich ist, benenne die Bandbreite statt einen Durchschnitt zu erfinden.

Decke diese Dimensionen ab (als Fliesstext mit kurzen Stichwort-Überschriften, KEINE Markdown-Tabellen):
- Satzbau & Satzlänge (Parataxe/Hypotaxe, typische Länge, Verbstellung, Fragmente)
- Rhythmus & Tempo (Stakkato vs. Fluss, Absatzlänge, Umgang mit Pausen)
- Wortwahl & Register (konkret/abstrakt, Adjektivdichte, Fremdwörter, Dialekt/Umgangssprache, Schweizer Eigenheiten)
- Bildsprache (Häufigkeit, Art der Metaphern/Vergleiche, eher nüchtern oder bildreich)
- Erzählhaltung (Distanz/Nähe, Ironie, Humor, Pathos, Direktheit zum Leser)
- Dialoggestaltung (Anteil, Inquit-Stil, Knappheit, Figurensprache)
- Interpunktions-Eigenheiten (Gedankenstriche, Auslassungspunkte, Doppelpunkte, Kommasetzung als Stilmittel)
- Wiederkehrende Wendungen, Tics, Lieblingswörter

Halte das Profil kompakt (Richtwert 150-300 Wörter). Lieber dicht und konkret als lang und vage.

Antworte mit diesem JSON-Schema:
{
  "stilprofil": "Der zusammenhängende Profiltext mit den oben genannten Dimensionen, kurze Stichwort-Überschriften erlaubt"
}

Leseprobe:
"""
${text}
"""`;
}

export const SCHEMA_STILPROFIL = _obj({
  stilprofil: _str,
});
