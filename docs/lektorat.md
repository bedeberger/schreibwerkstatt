# Lektorat

KI-Prüfung einer Seite (Seiten-Lektorat, Job `check`) oder aller Seiten eines Buchs (Buch-Lektorat, Job `batch-check`). Ergebnis: eine Liste von Befunden (`fehler`) mit zeichengenauem `original`, Vorschlag `korrektur` und `erklaerung`, dazu `szenen`, `stilanalyse`, `fazit`. Befunde landen in `page_checks` (History) und werden in der Notebook-Leseansicht markiert, ausgewählt und übernommen.

## Pipeline (Server)

| Schritt | Ort |
|---|---|
| Routen + die beiden Jobs (Seite, Buch) | [routes/jobs/lektorat.js](../routes/jobs/lektorat.js) |
| Prüfung **einer** Seite — gemeinsamer Kern beider Jobs: Kontext, Cache-Signatur, KI oder Cache, Nachbearbeitung, History-Eintrag | [routes/jobs/lektorat-page.js](../routes/jobs/lektorat-page.js)#`checkOnePage` |
| KI-Pässe: Kombi-Call oder Split (Objektiv K× + Stil 1×) | [routes/jobs/lektorat-split.js](../routes/jobs/lektorat-split.js)#`lektoratAnalyze` |
| Konsens-Voting + Cross-Pass-Merge (Span-Overlap-Clustering) | [lib/lektorat-consolidate.js](../lib/lektorat-consolidate.js) |
| Nachbearbeitung: Typ-Validierung, Selbst-Widerruf-Filter, de-CH ß→ss, Dedup, Stil-Cap | [routes/jobs/lektorat-filter.js](../routes/jobs/lektorat-filter.js)#`finalizeFehler` |
| Nachbarseiten-Auszüge + Backstop gegen Befunde aus dem Lesekontext | [routes/jobs/lektorat-context.js](../routes/jobs/lektorat-context.js) |
| Benutzer-Wörterbuch (Prompt-Liste + Rechtschreib-Backstop) | [routes/jobs/lektorat-dictionary.js](../routes/jobs/lektorat-dictionary.js) |
| Fehlertyp-Profile je Buchtyp (SSoT für Enum, Priorität, Stil-Cap-Set) | [public/js/prompts/lektorat-typen.js](../public/js/prompts/lektorat-typen.js) |
| Prompt-Aufbau | [public/js/prompts/lektorat.js](../public/js/prompts/lektorat.js), [lektorat-objektiv.js](../public/js/prompts/lektorat-objektiv.js), [public/js/prompts/CLAUDE.md](../public/js/prompts/CLAUDE.md) |

### Pflicht-Invarianten

- **Ein Kern für beide Jobs.** Seiten- und Buch-Lektorat prüfen jede Seite über `checkOnePage` — gleicher Prompt, gleiche Cache-Signatur, gleiche Nachbearbeitung. Eine Seite, die das Buch-Lektorat geprüft hat, ist für das Seiten-Lektorat ein Cache-Treffer und umgekehrt (gegated: [tests/integration/cache-extras.test.js](../tests/integration/cache-extras.test.js)). Ein Kontext-Input, der nur in einem der Jobs geladen wird, gehört nicht in den Job, sondern in `checkOnePage`.
- **Cache-Signatur deckt jeden Input ab**, der den Output formt: Seitentext + `updated_at`, Kapitelkontext (Figuren, Beziehungen, Schauplätze, Motive), `narrativeLabels` (Perspektive, Tempus, **Buchtyp** — wählt das Typ-Profil), Textsorte, Stil-/Regel-Strings, Nachbarauszüge, Modell + `PROMPTS_VERSION` + Effort, Lauf-Parameter aus `_runSig` (Stil-Cap, Split/K/Schwelle). Neuer Input ⇒ in die Signatur.
- **Nachbearbeitung läuft auch auf dem Cache-Pfad** (`finalizeFehler`), damit eine Profil- oder Filter-Änderung alte Cache-Zeilen nicht durchlässt.
- **Selbst-Widerruf-Filter nur auf eindeutige Widerrufsformen** (`NON_ERROR_RE`: «kein Fehler», «Korrektur entfällt», «ist vertretbar», «is in fact correct» …). Blosse Abschwächer wie «möglicherweise» stehen auch in echten Befunden und dürfen keinen Eintrag kippen (gegated: [tests/unit/lektorat-dedup.test.js](../tests/unit/lektorat-dedup.test.js)).
- **Stil-Cap zweimal, gleicher Wert:** `ai.lektorat_stylistic_cap` steht als Obergrenze im Prompt (Modell priorisiert nach Schwere) und als Backstop im Handler (schneidet nach Textposition). Nie gekappt werden objektive, Konsistenz-, Form- und Beleg-Befunde.
- **Nachbarseiten sind Lesekontext, nie Prüfgegenstand.** Prompt verbietet es, `dropNeighbourFindings` verwirft Befunde, deren `original` nur im Auszug steht. Lokale Provider bekommen keinen Nachbarkontext.
- **Fehlertyp-Spiegel** (CJS-Kopien, Heatmap-Cluster, `SOFT_TYPEN`/`EDITORIAL_TYPEN`, i18n) sind durch [tests/unit/lektorat-typen-drift.test.mjs](../tests/unit/lektorat-typen-drift.test.mjs) gegated.

### Buch-Lektorat

Seiten laufen in einem Worker-Pool; `ai.lektorat_batch_concurrency` deckelt die gleichzeitigen **Calls**, der Seiten-Pool ist der Quotient durch die Calls pro Seite (Split: `objective_runs + 1`). Das Ergebnis trennt `done` (geprüft), `skippedEmpty` (leere Seiten, zählen für den Fortschritt als erledigt) und `failed` (`[{ id, name }]`, Prüfung gescheitert) — das Frontend nennt gescheiterte Seiten beim Namen. Abbruch (`AbortError`) beendet den ganzen Lauf, jeder andere Seitenfehler nur diese Seite.

### Admin-Regler

`ai.lektorat_split`, `ai.lektorat_objective_runs`, `ai.lektorat_consensus_threshold`, `ai.lektorat_stylistic_cap`, `ai.lektorat_batch_concurrency`, `ai.claude.model.lektorat`, `ai.claude.effort.lektorat` — Definition und Defaults in [lib/app-settings/keys/ai.js](../lib/app-settings/keys/ai.js), Modell/Effort-Bag in [docs/ai-providers.md](ai-providers.md).

## Frontend (Notebook-Leseansicht)

Code: [public/js/editor/lektorat.js](../public/js/editor/lektorat.js) (Workflow), [public/js/cards/lektorat-findings-card.js](../public/js/cards/lektorat-findings-card.js) + [public/partials/editor-findings.html](../public/partials/editor-findings.html) (Befundliste), [public/js/book/page-view.js](../public/js/book/page-view.js) (Markierung, Befund-Klassen), [public/js/book/history.js](../public/js/book/history.js) (History-Eintrag laden).

### Befund-Klassen

`findingKind(typ)` in `page-view.js` ist die einzige Quelle für Vorauswahl und Farbe:

| Klasse | Typen | Vorausgewählt | Farbe |
|---|---|---|---|
| hart | Mechanik + Konsistenz/Form (rechtschreibung, grammatik, dialogformat, namens-/figuren-/schauplatzmerkmal, anrede, begriffsinkonsistenz, autorenform, konjunktiv) | ja | rot |
| weich | `stil` + `SOFT_TYPEN` (Stil, Handwerk, hedging, Tempus-/Perspektivbruch) | nein | orange |
| redaktionell | `EDITORIAL_TYPEN`: unbelegt, zuschreibung, wertung | **nie** | wertfrei (Akzent-Kante, `badge-neutral`) |

**Why redaktionell:** die Korrektur dieser Typen schreibt die *Aussage* um (abschwächen, Zuschreibung streichen, Wertung neutralisieren). Oft ist ein Beleg die richtige Antwort (Belegvorschlag am Befund), nicht die Umformulierung. Ein Sammel-„Übernehmen" darf solche Änderungen nicht mitnehmen.

### Pflicht-Invarianten

- **Kein Lektorat auf ungespeicherten Edits** (`editDirty`/`saveOffline` → blockiert).
- **Staleness im `onDone`:** frischen Seitenstempel selbst holen und bei Fremd-Write über `sortByPosition(base, fehler)` refiltern statt pauschal verwerfen — Regel in [routes/jobs/CLAUDE.md](../routes/jobs/CLAUDE.md), gegated durch [tests/unit/job-result-staleness.test.mjs](../tests/unit/job-result-staleness.test.mjs).
- **Übernehmen:** Seite frisch laden → `_applyCorrections` (sequenziell, No-Ops mit Grund `notFound`/`spansLink`/`spansMarker`/`boundary`) → Quote-Normalisierung → Grössen-Check → `savePage(..., expectedUpdatedAt)` (409 bei Fremd-Write). Seite ist ab Start gepinnt; ein Seitenwechsel verschiebt Ziel und Namen des PUT nicht.
- **`x-html`-Sinks** (`analysisOut`, `batchStatus`, `checkStatus`) nur mit `escHtml`-geschleusten KI-/Seiten-Feldern.
