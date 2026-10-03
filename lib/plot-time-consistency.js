'use strict';
// Zeit-Messung der Plot-Werkstatt — PURE, ohne DB und ohne KI.
//
// Sie stellt die erzählte Zeit eines Beats (`plot_beats.zeit`) gegen zwei
// Dinge, die die App bereits weiss: das Geburtsjahr der beteiligten Figuren
// (lib/figure-years.js) und die Lesereihenfolge des Boards.
//
// Warum das hier gehört und nicht in die KI-Konsistenzprüfung: „Beat spielt
// 1987, Figur X ist laut Geburtsjahr dann acht" ist eine Subtraktion, kein
// Urteil. Ein Modell danach zu fragen kostet Geld und liefert eine Aussage, die
// niemand nachrechnen kann; hier ist sie reproduzierbar und gratis. Dieselbe
// Arbeitsteilung wie in lib/motif-consistency.js und lib/figure-arc.js, darum
// tragen die Befunde `quelle: 'messung'`.
//
// Pflicht-Invariante (wie überall in dieser Familie):
// UNDATIERT IST UNGEPRÜFT, NICHT FALSCH. Ein Beat ohne `zeit` erzeugt keinen
// Befund — die Zeit-Angabe ist optional und ihr Fehlen kein Mangel.

const SEVERITY_ORDER = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

function _finding(code, schwere, beat, params = {}) {
  return {
    code,
    quelle: 'messung',
    schwere,
    beat_id: beat.id,
    beat: beat.titel,
    params,
  };
}

// Hauptfunktion.
//
// beats: [{ id, titel, zeit, jahr, verworfen, fig_ids[], draft_fig_ids[], lane, ordnung }]
//        `jahr` ist die vom Aufrufer bereits geparste Jahreszahl (yearFromString),
//        `lane` der Lane-Key und `ordnung` der 0-basierte Rang INNERHALB der Lane —
//        beides aus lib/plot-reading-order.js#beatsInReadingOrder (Lane = Strang
//        bzw. „ohne Strang", Akte der Lane → sort_order). Fehlt `lane`, gelten alle
//        Beats als eine Lane. `fig_ids` enthält bereits die vom Strang geerbte
//        Hauptfigur. Alles kommt vom Aufrufer, damit dieses Modul pur bleibt.
// figures: Map<fig_id(TEXT), { name, geburtsjahr }>
// bookSpan: { minYear, maxYear } | null — die datierte Spanne des Buchs.
function computeTimeFindings({ beats = [], figures = new Map(), bookSpan = null } = {}) {
  // Nur nicht-verworfene, datierte Beats. Ein verworfener Beat soll nicht ins
  // Buch, seine Chronologie ist folglich keine Aussage über das Werk.
  const datiert = beats
    .filter(b => !b.verworfen && Number.isFinite(b.jahr))
    .sort((a, b) => (a.ordnung ?? 0) - (b.ordnung ?? 0));
  if (!datiert.length) return [];

  const findings = [];

  for (const b of datiert) {
    // 1. Der Beat spielt, bevor eine beteiligte Figur geboren ist. Das ist kein
    //    Geschmacksurteil, sondern ein Rechenfehler im Plan.
    for (const figId of (b.fig_ids || [])) {
      const f = figures.get(figId);
      if (!f || !Number.isFinite(f.geburtsjahr)) continue;
      if (b.jahr < f.geburtsjahr) {
        findings.push(_finding('beatVorGeburt', 'kritisch', b, {
          figur: f.name, jahr: b.jahr, geburtsjahr: f.geburtsjahr,
        }));
      } else {
        // Das Alter zur Beat-Zeit ist reine Subtraktion — gemeldet wird es nur
        // als Kind-Alter, weil dort die meisten Planungsfehler sitzen (die Figur
        // tut etwas, das ein Kind nicht tut). Kein Urteil über den Beat selbst:
        // die Meldung nennt die Zahl und überlässt die Bewertung der Autorin.
        const alter = b.jahr - f.geburtsjahr;
        if (alter < 12) {
          findings.push(_finding('figurKindImBeat', 'mittel', b, {
            figur: f.name, alter, jahr: b.jahr,
          }));
        }
      }
    }

    // 2. Der Beat liegt ausserhalb der datierten Spanne des Buchs. Schwach, weil
    //    die Spanne selbst abgeleitet ist (aus dem Zeitstrahl) und ein geplanter
    //    Beat sie berechtigt erweitern darf — es ist ein Hinweis, kein Vorwurf.
    if (bookSpan && Number.isFinite(bookSpan.minYear) && Number.isFinite(bookSpan.maxYear)) {
      if (b.jahr < bookSpan.minYear || b.jahr > bookSpan.maxYear) {
        findings.push(_finding('zeitAusserhalbBuch', 'schwach', b, {
          jahr: b.jahr, von: bookSpan.minYear, bis: bookSpan.maxYear,
        }));
      }
    }
  }

  // 3. Chronologie-Bruch: eine Lane wird von links nach rechts gelesen, die
  //    Jahreszahlen laufen aber rückwärts. Gemeldet wird gegen das bisherige
  //    MAXIMUM, nicht gegen den direkten Vorgänger — sonst erzeugt eine einzelne
  //    Rückblende eine Kette von Folgefehlern, obwohl nur ein Beat aus der Reihe
  //    fällt.
  //
  //    NUR innerhalb einer Lane: parallele Stränge erzählen gleichzeitig, und ein
  //    Strang, der 1950 spielt, ist kein Rückschritt gegenüber einem, der 1987
  //    spielt. Über Lanes hinweg gibt es keine Lesereihenfolge.
  //
  //    Eine Rückblende ist ein legitimes Mittel; darum `mittel` und nicht
  //    `kritisch`, und darum nennt der Befund beide Beats, statt eine Korrektur
  //    zu behaupten.
  const maxByLane = new Map(); // lane → { jahr, beat }
  for (const b of datiert) {
    const lane = b.lane ?? null;
    const max = maxByLane.get(lane);
    if (max && b.jahr < max.jahr) {
      findings.push(_finding('chronologieBruch', 'mittel', b, {
        jahr: b.jahr, vorJahr: max.jahr, vorBeat: max.beat.titel,
      }));
    }
    if (!max || b.jahr > max.jahr) maxByLane.set(lane, { jahr: b.jahr, beat: b });
  }

  findings.sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.schwere) - SEVERITY_ORDER.indexOf(b.schwere);
    return s !== 0 ? s : (a.beat_id - b.beat_id);
  });
  return findings;
}

module.exports = { computeTimeFindings, SEVERITY_ORDER };
