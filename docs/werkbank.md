# Werkbank (Figuren × Akte + gemessene Befunde)

Die Ansicht, die Figuren-, Plot- und Motiv-Werkstatt **zusammen** liest. Karte `werkbank` ([public/js/cards/werkbank-card.js](../public/js/cards/werkbank-card.js), Methods [public/js/book/werkbank.js](../public/js/book/werkbank.js), Partial [werkbank.html](../public/partials/werkbank.html), CSS [book/werkbank.css](../public/css/book/werkbank.css)), Routen [routes/werkbank.js](../routes/werkbank.js). Pro Buch + User, ab Rolle `editor` wie die drei Werkstätten selbst. Hash-Permalink `#book/:bookId/werkbank`.

**Why:** die drei Werkstätten beantworten je ihre eigene Frage. Die Frage einer Autorin lautet aber nicht „wie steht mein Plot", sondern *„Figur X will A und braucht B — wo im Plot wird das herausgefordert, und welches Motiv trägt es"*. Diese Frage kreuzt alle drei, und bisher liess sie sich nur im Kopf beantworten.

## Kein eigener Index

Read-time, kein Job, kein `callAI`. `plot_beats`, die `motif_*`-Brücken und `draft_figure_occurrences` **sind** bereits die abgeleiteten Stände — ein vierter wäre eine vierte Wahrheit, die nach jedem Lauf invalidiert werden müsste. Gleiches Muster wie das Autorenprofil und der Buch-Befund in [db/narrative-report.js](../db/narrative-report.js).

## Zwei Sichten, ein Bestand

| Sicht | Route | Zeigt |
|---|---|---|
| **Figuren × Akte** | `GET /werkbank` | Welche Figur trägt welchen Akt — mit ihren Motiven und ihrem Bogen-Ist |
| **Befunde** | `GET /werkbank/befunde` | Die gemessenen Aussagen aller drei Werkstätten an einer Stelle |

Beide lesen dieselben Quellen; ein zweiter Lesepfad zeigte zwei Bestände (gleiche Regel wie die zwei Ansichten des Recherche-Boards). Die Befunde werden **lazy** geholt — wer nur die Matrix ansieht, soll die drei Messungen nicht bezahlen.

## Matrix: Pflicht-Invarianten

- **Eine verknüpfte Figur ist EINE Zeile.** Trägt ein Draft `source_figure_id`, verschmelzen Werkstatt- und Katalog-Eintrag zu einer Zeile — sonst stünde dieselbe Figur zweimal im Raster, einmal mit Plan und einmal mit Text. Genau dafür gibt es den Zeiger ([docs/figur-werkstatt.md](figur-werkstatt.md) → „Nachträgliche Verknüpfung"). Beats werden über **beide** Brücken verteilt, damit die zusammengeführte Zeile die Beats beider Seiten trägt.
- **Die leere Zelle IST die Auskunft** („diese Figur kommt in diesem Akt nicht vor") und wird darum gezeichnet, nicht weggelassen — schraffiert aus **derselben Deklaration** wie die leere Heatmap-Zelle (`--hatch-empty` in [public/css/tokens/colors.css](../public/css/tokens/colors.css), dazu `opacity: var(--opacity-disabled)`), damit „nichts da" überall gleich aussieht.
- **Die Statusfarbe der Beat-Karte ist die des Beat-Boards** — `geplant` = `--color-muted`, `im_buch` = `--color-ok-border`, wie `.plot-beat--*` in [public/css/book/plot/board.css](../public/css/book/plot/board.css). Eine eigene Farbskala hier wäre eine zweite Bedeutung für denselben Status.
- **Archivierte Akte fallen aus den Spalten**, wie auf dem Beat-Board. Ihre Beats zählen dort weiter in jeder Kennzahl; hier geht es um die **Arbeitsfläche**, und ein abgeschlossener Akt ist keine.
- **Verworfene Beats erscheinen nicht** — sie sollen nicht ins Buch, also tragen sie auch keinen Akt.
- **Motive kommen aus EINEM buchweiten Griff** (`bridgeRows`), nicht aus einem Aufruf pro Zeile. `figureMotifUsage` taugt dort nicht: es erwartet die INTEGER-`figures.id`, und eine reine Katalog-Zeile hat nur ihre TEXT-`fig_id` — mit `null` käme sie still ohne Motive zurück, ein Fehler, den man erst am leeren Raster sähe.
- **Die Raster-Geometrie ist gegated** — [tests/e2e-app/werkbank-matrix.spec.js](../tests/e2e-app/werkbank-matrix.spec.js) prueft gegen die gebootete App, dass die Kopfzeile klebt (sie braucht dafuer den `max-height`-Deckel am Scroll-Container — ohne ihn scrollt der Container nie vertikal und `top: 0` haengt an nichts), dass die Ecke per Hit-Test ueber den durchscrollenden Akt-Koepfen liegt, und dass die Zeilenkopf-Spalte auch bei einem Namen ohne Fuge schmal bleibt. Kein Fixture-Harness: alle drei Aussagen haengen an der echten CSS-Hoehenkette und der Malreihenfolge.
- **Rein lesend.** Bearbeitet wird in der jeweiligen Werkstatt; von hier führt nur der Sprung zurück (`openWerkstattDraftById` / `openFigurById` / `openPlotBeatById` / `openMotifById`).

## Befunde: nur Messungen

Gesammelt werden die drei **puren** Engines — jeder Befund trägt `quelle: 'messung'` (aus der Engine) plus `werkstatt` (`figur`|`plot`|`motiv`):

| Werkstatt | Engine | Misst |
|---|---|---|
| `figur` | [lib/figure-arc.js](../lib/figure-arc.js) | Mindmap-Kerne gegen den Ist-Index (Bogen) |
| `plot` | [lib/plot-time-consistency.js](../lib/plot-time-consistency.js) | Erzählte Zeit gegen Geburtsjahre + Board-Reihenfolge |
| `motiv` | [lib/motif-consistency.js](../lib/motif-consistency.js) | Motiv-Kanten gegen den Fund-Index |

**Die KI-Urteile bleiben, wo sie hingehören.** Sie kosten Geld und gehören zu ihrem Gegenstand; hier stünden sie ohne den Kontext, der sie lesbar macht. Die Werkbank sammelt ausschliesslich das, was gratis und reproduzierbar ist.

**Befundtexte kommen aus den Locales, nicht aus der Antwort** — der Betrachter bestimmt die Sprache. Jede Werkstatt hat ihren eigenen Key-Raum (`werkstatt.arc.check.*` / `plot.check.*` / `motiv.check.*`), weil ihre Codes eigene sind.

**Pflicht: UNGEMESSEN IST UNGEPRÜFT, NICHT IN ORDNUNG.** Die Antwort trägt `scanned: { figur, plot, motiv }`, und die Karte weist aus, welche Werkstatt gar nicht gemessen hat — ohne diesen Hinweis liest sich eine leere Liste als Unbedenklichkeitsbescheinigung.

## Geburtsjahr-Quelle

Die Zeit-Messung liest das Geburtsjahr über `listFigurenWithDetails`, das intern dieselbe SSoT [lib/figure-years.js](../lib/figure-years.js) ruft wie Alters-Analyse und Lebenslauf. Eine zweite Auflösung hier wäre eine zweite Rechnung über dieselbe Frage. Ohne echte Zeitlinie (`book_settings.zeitlinie_real`) ist `geburtsjahr` null — dann entsteht nur der Chronologie-Teil der Messung, kein Alters-Befund.
