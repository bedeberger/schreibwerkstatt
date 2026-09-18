# Figuren-Werkstatt

Vorwärts-Entwicklung von Romanfiguren als jsMind-Mindmap, isoliert vom Komplettanalyse-Katalog (`figures`). Eigene Tabelle `draft_figures`, kein Promotion-Pfad zurück nach `figures`. Code: [routes/draft-figures.js](../routes/draft-figures.js), [routes/draft-figures-acl.js](../routes/draft-figures-acl.js), [routes/jobs/figur-werkstatt.js](../routes/jobs/figur-werkstatt.js), [public/js/cards/figur-werkstatt-card.js](../public/js/cards/figur-werkstatt-card.js), [public/js/figur-werkstatt.js](../public/js/figur-werkstatt.js), [public/partials/figur-werkstatt.html](../public/partials/figur-werkstatt.html), [public/css/entities/figur-werkstatt.css](../public/css/entities/figur-werkstatt.css), [public/js/prompts/figur-werkstatt.js](../public/js/prompts/figur-werkstatt.js), [lib/draft-mindmap-builder.js](../lib/draft-mindmap-builder.js).

Trigger: `tile.werkstatt` (Quick-Pill / Palette-Alias `workshop|mindmap|brainstorm|figur|vorwaerts`). Hash-Permalink `#book/:bookId/werkstatt[/:draftId]`.

## Datenmodell

```
draft_figures (id, book_id→books, user_email, name, archetype, mindmap_json, notes,
               source_figure_id→figures SET NULL, created_at, updated_at)
   └── 1:N werkstatt_runs (id, draft_id CASCADE, book_id CASCADE, user_email,
                           kind ∈ {brainstorm, consistency}, created_at,
                           knoten_id, knoten_pfad, result_json, model)
```

- `mindmap_json` hält jsMind-Baum (`{ meta, format:'node_tree', data:{ id, topic, children } }`) — keine separate Knoten-Tabelle.
- `source_figure_id` (FK ON DELETE SET NULL): Referenz auf Quell-Figur bei Import. Werkstatt überlebt das Verschwinden der Quelle. Den Anzeige-Namen liefert der Lesepfad als `source_figure_name` per LEFT JOIN mit — das Frontend-Badge (`importedFromName()`) liest ihn von dort und schlaegt ihn **nicht** im catalog-Store nach, dessen Ladezustand das Badge sonst verschwinden liesse.
- `werkstatt_runs.kind` CHECK gegen `brainstorm`/`consistency`. Reset via `/history/reset` (DELETE WHERE book_id+user_email).
- Migrationen: 90 (`draft_figures`), 97 (`source_figure_id` FK Recreate), 98 (`werkstatt_runs`). ERD-Block in [erd.md](erd.md).

## Default-Mindmap

`defaultMindmap(name)` ([routes/draft-figures.js](../routes/draft-figures.js)) — Wurzel = Figurname, vier feste Branches:

- `steckbrief` (expanded): aussehen, persoenlichkeit, hintergrund, beziehungen, konflikt, bogen, musikgeschmack
- `stimme` (expanded): sprechweise, phrasen, verben
- `subtext` (expanded): want, need, wound, lie
- `custom` (collapsed, leer)

Branch-Topics persistiert als `__i18n:werkstatt.tree.<key>__`-Marker (CLAUDE.md-Pattern für persistierte User-Nachrichten). Frontend resolved via `t()` zur Render-Zeit; Locale-Wechsel ändert Default-Labels live. User-Umbenennung überschreibt Marker. `_exportMindmap` restauriert Marker für Knoten, deren Topic noch dem resolved-Default entspricht — sonst ginge Marker beim Save verloren.

## Routen (CRUD)

Alle unter `/draft-figures` ([server.js:245](../server.js#L245)).

**Zugriff laeuft ueber genau einen Vorspann** ([routes/draft-figures-acl.js](../routes/draft-figures-acl.js), geteilt mit dem Job-Router): `scopedDraft(req, res, id, { minBookRole })` und `scopedRun(req, res, id)` antworten selbst und liefern sonst `null` (Muster `scopedItem` in [research-acl.js](../routes/research-acl.js)). Die Besitz-Achse (`draft_figures.user_email`) traegt; die Buch-ACL kommt nur dort dazu, wo der Draft Kosten auf dem Buch verursacht — beim Start eines KI-Laufs, `minBookRole: 'editor'`.

`router.param('book_id', aclParamGuard('viewer'))` prueft Login **und** Buch-Id fuer jede `:book_id`-Route und setzt `req.bookId`; in diesen Handlern steht deshalb kein zweites `sessionEmail()`+401 und kein eigenes `toIntId(req.params.book_id)`. Ein error_code pro Lage: `LOGIN_REQ` / `INVALID_ID` / `NOT_FOUND` / `FORBIDDEN` — auch auf den Job-Routen, die dafuer zweite Namen hatten. Die Body-Validierung davor (`DRAFT_ID_REQUIRED`, `KNOTEN_ID_REQUIRED`) ist eine andere Frage und bleibt bei den Job-Routen.

| Methode | Pfad | Zweck |
|---------|------|-------|
| `GET`    | `/:book_id`             | Drafts pro Buch (per User), `ORDER BY updated_at DESC` |
| `GET`    | `/by-id/:id`            | Einzel-Draft inkl. resolved `source_figure_name` (LEFT JOIN figures) |
| `GET`    | `/:book_id/importable`  | figures, für die der User noch keinen Draft hat |
| `POST`   | `/:book_id`             | `{ name, archetype?, notes?, mindmap? }` — fehlt mindmap → `defaultMindmap(name)` |
| `POST`   | `/:book_id/import`      | `{ figureId }` → `buildMindmapFromFigure` + `mapArchetype`. **409 ALREADY_IMPORTED + existingDraftId** bei doppelter Quelle (idempotent gegen Doppelklick) |
| `PUT`    | `/:id`                  | Partial-Update name/archetype/notes/mindmap |
| `DELETE` | `/:id`                  | Cascade auf werkstatt_runs |
| `GET`    | `/by-id/:id/runs`       | Run-Liste (ohne result_json — Spaltensparsamkeit) |
| `GET`    | `/runs/:run_id`         | Run-Detail mit result_json |
| `DELETE` | `/runs/:run_id`         | Einzel-Run löschen |

**Limits:** Name 200, Notes 8000, mindmap_json 256 KB. `_validateMindmap` prüft Struktur + Bytecap.

**Run-Routen vor `/:book_id`** in der Datei — sonst frisst der numerische Param-Match das Wort `runs`.

## Import aus figures-Katalog

Die Kandidatenliste (`GET /:book_id/importable`) liegt als `listImportableFigures` in [db/draft-figures.js](../db/draft-figures.js) — sie joint `chapters` fuer die Kontext-Zweitzeile des Pickers und gehoert damit ins `db/`-Modul, nicht in den Route-Handler. Sie dedupliziert pro Name (Merge-Kollisionen der Komplettanalyse, `fig_id`-Suffix `__2`) und stellt danach die Katalog-Reihenfolge wieder her; **`sort_order` muss dafuer in der SELECT-Liste stehen**, sonst rechnet der Vergleich mit `undefined` → NaN → falsy und die Reihenfolge faellt still auf die id zurueck.

`POST /draft-figures/:book_id/import { figureId }` → `buildMindmapFromFigure(fig)` ([lib/draft-mindmap-builder.js](../lib/draft-mindmap-builder.js)):

- Wiederverwendet `defaultMindmap` als Skelett, füllt Felder als Sub-Knoten der passenden Container.
- `aussehen` ← `beschreibung` (auf 280 chars gekürzt)
- `hintergrund` ← Stammdaten (kurzname, geschlecht, geburtstag, beruf, wohnadresse, sozialschicht, rolle, praesenz) als `Label: Wert`-Knoten
- `beziehungen` ← `figure_relations` (out + in, dedupe per `dir|typ|partner_name`), Topic `Typ → Partner: Beschreibung`
- `konflikt` ← `figures.konflikt`, `bogen` ← `entwicklung`, `persoenlichkeit` ← `tags[]`, `subtext > want` ← `motivation`
- `mapArchetype(typ)`: Whitelist `protagonist|antagonist|mentor|nemesis|nebenfigur` (substring-match auf `figures.typ`-Freitext); sonst `null`

Owner-Check zwingt `figures.user_email === userEmail` — Pre-Migration-Figuren mit `user_email IS NULL` sind verboten, sonst entstünden Drafts ohne reverse-Owner-Pfad bei figure-Mutation.

## KI-Jobs

Beide via Job-Queue ([routes/jobs/figur-werkstatt.js](../routes/jobs/figur-werkstatt.js)), Schemas in [public/js/prompts/figur-werkstatt.js](../public/js/prompts/figur-werkstatt.js).

| Job-Typ | Endpunkt | dedupId | Eingabe | Output |
|---------|----------|---------|---------|--------|
| `werkstatt-brainstorm`  | `POST /jobs/werkstatt-brainstorm`  | `${draftId}|${knotenId}` | `{ draftId, knotenId }` | `{ vorschlaege:[{label, begruendung}], knotenId, knotenPfad, runId }` |
| `werkstatt-consistency` | `POST /jobs/werkstatt-consistency` | `draftId`                | `{ draftId }`           | `{ konflikte:[{feld, schwere, problem, vorschlag}], fazit, runId }` |

Beide Jobs:

1. Laden draft + locale (User-Setting) + Buch-Kontext via `getBookPrompts(book_id, userEmail)` (Buchtyp + Freitext).
2. Bauen i18n-resolved Snapshot der Mindmap (`resolveI18nTree`) — KI sieht Default-Marker als Klartext in User-Locale.
3. Laden bestehende `figures` + `locations` des Buchs (LIMIT 50, sortiert nach `sort_order, name`).
4. **Quell-Figur ausschliessen** aus Buch-Kontext: `_loadBookFiguren(draft, userEmail)` filtert beides in EINEM Loader — per `source_figure_id` und per Namensvergleich (getrimmt, case-insensitiv) für Drafts ohne Import-Referenz bzw. nach einer Umbenennung. Sonst lehnt KI eigene Eigenschaften als „Doppelung mit Buchfigur" ab oder Consistency-Check markiert jeden importierten Aspekt als Namenskonflikt. Beide Jobs brauchen beide Filter — darum im Loader, nicht je Job-Runner.
5. `aiCall` mit `SYSTEM_FIGUREN` + Job-Prompt, Schema-Validierung.
6. `insertWerkstattRun({...})` historisiert das Resultat → `runId` im completeJob-Payload. `model` kommt aus `_modelName(resolveProvider({ userEmail }))`: der Name muss vom **effektiven** Provider stammen (KI-Profil des Users vor `ai.provider`) — ohne Argument faellt `_modelName` auf den Claude-Zweig zurueck und schriebe bei jedem lokalen Modell einen falschen Namen in die Historie.

**Brainstorm-Spezifika:** Findet Mindmap-Knoten via `_findKnoten(data, knotenId)` — liefert Knoten + Pfad-String `Wurzel > … > Knoten`. Prompt enthält bestehende Children des Ziel-Knotens als „NICHT wiederholen"-Liste. Output: 3–7 Vorschläge mit 2–8 Wörter Label + 1-Satz-Begründung.

**Consistency-Spezifika:** Severity-Skala `kritisch|stark|mittel|schwach|niedrig` (kompatibel zu `.severity-tag--*` aus DESIGN.md). Leeres `konflikte`-Array + bestätigendes `fazit` bei Stimmigkeit. Schema enforced enum. Die Skala steht an drei Orten: `SEVERITY_ENUM` im Prompt-Modul (Prompt-Text + JSON-Schema), eine **bewusste CJS-KOPIE** gleichen Namens im Job-Router (der kann das ESM-Modul nicht importieren; sie entscheidet, was die Server-Validierung passiert) und `.severity-tag--<wert>` im CSS. Gegated durch [tests/unit/figur-werkstatt-severity-drift.test.mjs](../tests/unit/figur-werkstatt-severity-drift.test.mjs) — driftet die Kopie, faellt ein schema-konformer Wert serverseitig still auf `mittel` zurueck. Ein Wert ist zugleich Persistenz-Konstante (`werkstatt_runs.result_json`): ergaenzen ja, umbenennen nein.

**Text-Abgleich (semantische Erdung).** `_loadFigurTextbelege(draft, userEmail, logger)` zieht per `semanticQuery` (kinds page/scene, [lib/semantic-retrieval.js](../lib/semantic-retrieval.js)) die tatsächliche **Prosa**, wie die Figur im Manuskript geschrieben ist — anders als `_loadFigurAuftritte` (Szenen-Titel/Ereignis-Labels = strukturierte Extrakte). Query = **Name + Archetyp** (identifizierend, bewusst NICHT die zu prüfenden Eigenschaften — sonst zöge man nur bestätigende Stellen an; die Hybrid-Fusion trägt den Namen wörtlich, die Semantik findet auch namenlose Erwähnungen). Nur bei aktivem Embedding-Backend (`embed.isEnabled()`); ohne Treffer (Figur evtl. noch nicht geschrieben) leer, best-effort (Fehler failt den Job nicht). Scene→page via Direkt-SQL auf `figure_scenes` (keine pages/chapters/books-Tabelle), Dedup pro Seite. Der Prompt-Block `SO IST DIE FIGUR IM MANUSKRIPT GESCHRIEBEN` + der Prüfpunkt *Mindmap-Plan vs. geschriebene Figur* ([public/js/prompts/figur-werkstatt.js](../public/js/prompts/figur-werkstatt.js)#`_textbelegeSeg`) lassen die KI geplante Eigenschaften (Persönlichkeit/Stimme/Want/Need/Wound/Lie/Bogen) gegen den Wortlaut prüfen — Ähnlichkeit, kein Beweis; fehlt zu einer geplanten Eigenschaft Text, ist das **kein** Fehler (noch nicht geschrieben). Das Resultat trägt `textbelege: [{page_id, snippet}]` (mit-persistiert im `werkstatt_runs.result_json`); die Consistency-Detailansicht zeigt sie als klappbare **Belegstellen**-Liste mit anspringbarem Seiten-Link (`belegPageLabel`/`gotoBeleg` in [runs.js](../public/js/figur-werkstatt/runs.js), Seitenname client-seitig aus dem nav-Store aufgelöst). Alt-Läufe ohne Feld: Liste ausgeblendet.

**Job-Labels:** `job.label.werkstattBrainstormFigur` / `job.label.werkstattConsistencyFigur` mit `{ figur }`-Param (die figurlosen Varianten `job.label.werkstatt{Brainstorm,Consistency}` sind die Zeilen der Job-Statistik, `JOB_TYPE_LABELS` in [routes/jobs/shared/jobs.js](../routes/jobs/shared/jobs.js)).

## Frontend-Card

Sub-Komponente `figurWerkstattCard` ([public/js/cards/figur-werkstatt-card.js](../public/js/cards/figur-werkstatt-card.js)). State + jsMind-Editor + Brainstorm/Consistency-Polling + Run-Historie + Vollbild + Rechtsklick-Menü.

**Lifecycle:** `setupCardLifecycle({ name:'figurWerkstatt', showFlag:'showFigurWerkstattCard', timerKeys:['_brainstormPollTimer','_consistencyPollTimer'], load: loadDrafts, onCardRefresh: dirty-confirm + reload })`. **Kein `resetState`-Literal:** `book:changed` und `view:reset` laufen ueber `onBookChanged`/`onViewReset` in `resetDrafts()` ([crud.js](../public/js/figur-werkstatt/crud.js)), weil der Reset dieser Karte die jsMind-Instanz abraeumen, die Poll-Timer stoppen und ein offenes Vollbild verlassen muss — nichts davon kann ein `Object.assign`. `onBookChanged` uebernimmt darum auch das Nachladen, das der Default-Pfad sonst anhaengt. Wer ein Feld ergaenzt, ergaenzt es in `resetDrafts()`; zwei Fassungen desselben Resets driften. Extra-Listener: `Cmd/Ctrl+S` → saveDraft, `beforeunload` mit `isDirty()`-Schutz, `figur-werkstatt:select { draftId }` für Hash-Deep-Link.

**Hash-Router:** `werkstattDraftId` lebt am Root als SSoT (`figurWerkstattState`, [public/js/app/app-state.js](../public/js/app/app-state.js)). Sub spiegelt via `$watch('selectedDraftId', id => __app.werkstattDraftId = id)`. Permalink-Resolve bei kalt-geladener Sub via `_pendingDraftId`-Park bis `loadDrafts` fertig.

**jsMind-Editor:**

- Lazy-Load via `loadJsMind()` ([lazy-libs.js](../public/js/lazy-libs.js)) — kein init-Script.
- `_mountMindmap(container)` rAF-Defer bis `container.offsetParent` (Card-Show-Race), Cap 60 Frames.
- Tastatur-Mapping: `Tab` addchild (Mac-Insert-Ersatz), `Enter` addbrother, `F2` editnode, `Delete` delnode, `Space` toggle, Pfeile navigieren. Auto-Fokus auf `.jsmind-inner` nach Mount.
- Linienfarbe aus `--color-border` Token in jsMind-Canvas-Config injiziert (jsMind zeichnet auf `<canvas>`, kein CSS-Targeting).
- Selection-Listener (`type === 4`) zentriert Knoten via `scroll_node_to_center` (Fallback: manueller Scroll). `_suppressCenter`-Flag unterdrückt Auto-Jump bei programmatic select aus Context-Menu/Apply.
- `_mindmapDirty` via `type === 3` (Edit-Events) — `add_node`/`insert_node_after` feuern type=3 nicht zuverlässig, dort explizit setzen.
- `_jmDraftId` schützt Save: `_exportMindmap` nur, wenn jsMind zur aktuell selektierten Draft-ID gehört.
- Vollbild via Browser-Fullscreen-API auf `.werkstatt-mindmap-section`, `fullscreenchange`-Listener synct `mindmapFullscreen`-Flag (Esc/F11 funktionieren).
- Rechtsklick-Menü: rename/addChild/addSibling/delete/brainstorm; `_clampMenuPos` zieht `.card`-bounding-rect ab (cardFadeIn-Transform erzeugt Containing-Block für `position:fixed`).

**Brainstorm-Apply:** `applyBrainstormVorschlag(idx)` → `_jm.add_node(parentId, _newNodeId(), label)` + `_mindmapDirty=true`. Vorschlag wird aus `brainstormResult.vorschlaege` entfernt.

**Save-Vor-Job:** `runBrainstorm`/`runConsistency` rufen zuerst `saveDraft()`, sonst sieht KI alte Mindmap.

## Weltgesetze als Prüfstein (Consistency)

Neben den Textbelegen bekommt die Consistency-Prüfung die **Weltgesetze** des Buchs: `world_facts` der Kategorien `regel` + `technik` ([routes/jobs/figur-werkstatt.js](../routes/jobs/figur-werkstatt.js)#`_loadWeltgesetze` → [prompts/figur-werkstatt.js](../public/js/prompts/figur-werkstatt.js)#`_weltgesetzeSeg`).

**Why:** die beiden bisherigen Erdungen decken das nicht ab. Der Buch-Kontext ist Freitext der Autorin, die Textbelege zeigen die Prosa **dieser** Figur — ob eine geplante Fähigkeit in dieser Welt überhaupt möglich ist (magische Gabe gegen die Magie-Regel, Beruf gegen den Technik-Stand), stand nirgends im Prompt.

Gleiche drei Regeln wie im Plot-Check (siehe [docs/plot.md](plot.md)): nur `regel`+`technik`, ohne erhobenen Index **kein** Block und **kein** Prüfpunkt (nie analysiert heisst nicht regelfrei), und eine von der Mindmap ausgewiesene Ausnahme ist kein Fehler.

## Cross-Feature: Plot-Werkstatt

Beide Jobs grundieren zusätzlich mit der **geplanten Handlung der Figur** aus der [Plot-Werkstatt](plot.md): `_loadFigurPlotBeats(draft, userEmail)` → `plotDb.figurePlotUsage(book_id, userEmail, { draftFigureId, sourceFigureId })` liefert die Beats, an denen die Figur beteiligt ist — direkt verlinkt (`plot_beat_draft_figures` bzw. via `source_figure_id` über `plot_beat_figures`) **oder** implizit als Strang-Hauptfigur (Live-Vererbung). **Best-effort:** Plot ist eine optionale Nebenquelle, ein Fehler hier failt den Werkstatt-Job (Kern = Mindmap) nicht, sondern liefert `[]`. Prompt-Block `GEPLANTE HANDLUNG DIESER FIGUR` (in [public/js/prompts/figur-werkstatt.js](../public/js/prompts/figur-werkstatt.js)#`_plotBeatsLines`):

- **Consistency** bekommt zwei zusätzliche Prüfpunkte (nur wenn Beats existieren): *Figurenbogen vs. geplante Handlung* (deckt sich der Mindmap-Bogen bzw. Want/Need/Wound/Lie mit den Beats? Wird der innere Wandel eingelöst?) und *zentral aber flach / tief aber unverankert* (viele Beats ohne Tiefe ↔ ausgearbeitet ohne jeden Beat).
- **Brainstorm** richtet besonders Bogen-/Konflikt-/Subtext-Knoten an der geplanten Handlung aus (Zusatz-Bullet).

**Navigation Werkstatt → Plot (Badge):** `loadPlotUsage()` (in [crud.js](../public/js/figur-werkstatt/crud.js), nach `selectDraft`) holt `GET /plot/figure-usage?book_id=&draft_id=` → `{ beatCount, activeBeatCount, threads }`. Das klickbare Badge `.badge--plot` im Detail-Header (`plotUsageVisible/Label/Tip`) öffnet via `$app.openPlotForDraftFigure(draftId)` das Beat-Board, gefiltert auf diese Figur (`plot:filter-draft-figure`-Event). State `plotUsage` wird bei Draft-Wechsel/Reset/Delete genullt.

## Bogen im Buch (Ist-Index + Messung)

Das Pendant zum Kapitel-Verlaufsband der Motiv-Werkstatt und zum Drift-Badge der Plot-Werkstatt — und der Schritt, den die Figuren-Werkstatt als letzte der drei gegangen ist: **ein Plan ist erst dann etwas wert, wenn ihm eine Messung gegen den geschriebenen Text gegenübersteht.**

**Was gemessen wird:** die sechs psychologischen Kerne der Mindmap (`want`/`need`/`wound`/`lie`/`bogen`/`konflikt`, SSoT `PSYCHE_KERNE` in [lib/draft-mindmap-extract.js](../lib/draft-mindmap-extract.js)) gegen den Buchtext. Nicht „kommt die Figur vor" — das beantwortet `figure_appearances` längst —, sondern **wo über den Buchbogen ihre Wunde trägt und wo ihre Lüge bricht**. Ein Bogen ist eine Verteilung, keine Zahl; darum eine Zeile pro Kern und Fundstelle.

- **Ist-Index `draft_figure_occurrences`** (Migration 285, DB-Modul [db/draft-figure-occurrences.js](../db/draft-figure-occurrences.js)): `draft_id` CASCADE, `book_id` CASCADE, `kern` als CHECK-gated Diskriminator, `kind` page/scene sentinel-frei. Full-Replace **pro (Draft, Kern)** je Anchor-Lauf; abgeleitet, nie handgepflegt. Kapitel-Auflösung wortgleich mit [db/motifs/occurrences.js](../db/motifs/occurrences.js) — Zellzahl und ihre Auflösung müssen dieselbe Frage stellen.
- **Job `figur-anchor`** ([routes/jobs/figur-anchor.js](../routes/jobs/figur-anchor.js)) — **kein `callAI`/Prompt**, Klon des `motif-scan`/`beat-anchor`-Musters. Query je Kern = Figurenname + die vom Autor formulierten Kern-Zeilen (der Name trägt die Hybrid-Fusion wörtlich, damit die Semantik nicht in fremde Wunden läuft; allein stünde er für „kommt vor"). Buchweit, nicht pro Figur — ein Lauf pro Draft wäre eine Job-Flut. Nacht-Cron `anchorAllDraftFigures` hinter `beat-anchor`. Score-Floor `werkstatt.anchor.min_score` (Default 0.35, höher als `embed.min_score`: ein Kern ist eine Bedeutung, und schwache Treffer sind dort systematisch Zufall).
- **Ohne Embedding-Backend läuft NICHTS** — bewusster Unterschied zu `motif-scan` (hat wörtliche `trigger_terms`) und `beat-anchor` (dessen Titel wenigstens Eigennamen trägt). Der Job endet mit `semantic: false` statt einen leeren Index zu schreiben, der als „nichts im Buch" lesbar wäre.
- **Messung `lib/figure-arc.js`** — pure Rechnung, `quelle: 'messung'` wie [lib/motif-consistency.js](../lib/motif-consistency.js). Vier Codes: `kernOhneText` (geplant, im Text nirgends — nur wenn die Figur sonst im Buch steht), `kernNurPunktuell` (ein einziges Kapitel), `wandelOhneEinloesung` (Lüge/Wunde im Schlussdrittel so dicht wie im Kopfdrittel — der häufigste stille Fehler) und `bogenOhneBeleg`. Die Verteilung wiegt **Fundstellen, nicht Kapitel**; `bogenOhneBeleg` verdrängt den allgemeinen Befund für `bogen` (keine doppelte Buchführung). Gegated: [tests/unit/figure-arc.test.mjs](../tests/unit/figure-arc.test.mjs).
- **Pflicht-Invariante: UNGESCANNT IST UNGEPRÜFT, NICHT ABWESEND.** Leerer Index ⇒ `scanned: false` und **keine** Befunde; das Band zeigt seinen „noch nicht verankert"-Hinweis statt einer Tabelle aus Nullen, die wie ein Befund aussähe. Gleiches Muster wie `motif_occurrences` und `anchorMap === null` im Plot-Check.
- **Route** `GET /draft-figures/:book_id/arc` liefert Ist-Zahlen, Kapitel-Aufschlüsselung **und** Befunde in EINER Antwort — dieselbe Liste, die die [Werkbank](werkbank.md) liest; ein zweiter Lesepfad zeigte zwei Bestände. Dazu `GET /draft-figures/by-id/:id/occurrences[?kern=]` fürs Zell-Detail.
- **Frontend** [public/js/figur-werkstatt/bogen.js](../public/js/figur-werkstatt/bogen.js) + [werkstatt-bogen.html](../public/partials/werkstatt-bogen.html): Kern × Kapitel als Heatmap über das geteilte `.heatmap-*`-Vokabular, √-gedämpft mit Boden 14 % — **wortgleich mit dem Motiv-Band, damit dieselbe Färbung in beiden Karten dasselbe heisst**. Zeilen sind nur die GEPLANTEN Kerne (ein nicht ausgearbeiteter Kern ist keine leere Zeile, sondern keine Zeile). Zell-Klick löst die Fundstellen auf, Klick darin springt an die Textstelle.

## Cross-Feature: Motiv-Werkstatt

Beide Jobs bekommen zusätzlich die **Motive dieser Figur** (`_loadFigurMotive` → `motifsDb.figureMotifUsage`, Prompt-Block `MOTIVE DIESER FIGUR` in [prompts/figur-werkstatt.js](../public/js/prompts/figur-werkstatt.js)#`_motiveLines`). Die Gegenrichtung zum Figuren-Layer der Konstellation: `motif_draft_figures` existiert seit je, aber nur die Motiv-Werkstatt las sie.

- Quelle sind **zwei Brücken**: `motif_draft_figures` (Werkstatt) und `motif_figures` über die Quell-Figur — ein importierter Draft erbt damit die Motive des Katalog-Eintrags, sonst hinge dieselbe Figur je nach Herkunft an zwei Motiv-Mengen.
- Die **Ist-Zahl geht nur mit, wenn der Motiv-Scan gelaufen ist** (`hasOccurrences`): „0 Fundstellen" wäre sonst eine Falschaussage über einen nie erhobenen Index.
- **Consistency** bekommt den Prüfpunkt *Figur vs. ihre Motive* (widerspricht ein Motiv dem Subtext? fehlt dem zentralen Motiv die Verankerung in der Innenwelt?); **Brainstorm** eine Regel-Bullet (Ideen sollen die Motive bedienen oder brechen, nicht an ihnen vorbeigehen).
- **Badge** `.badge--motiv` im Detail-Header (`GET /motifs/figure-usage`), Klick öffnet die Konstellation beim ersten Motiv. Der Tooltip nennt **geplant UND belegt** — „geplant" ist nicht „trägt", und ein Badge nur mit der Planzahl verschwiege genau den Unterschied.

## Nachträgliche Verknüpfung mit dem Figuren-Katalog

`POST /draft-figures/by-id/:id/link-figure { figureId }` setzt `source_figure_id` nachträglich (`figureId: null` löst wieder); `GET /draft-figures/:book_id/link-candidates` liefert die Katalog-Figuren des Buchs, die an keinem Draft hängen.

**Why:** die Werkstatt entwickelt eine Figur **vorwärts**, die Komplettanalyse extrahiert sie **rückwärts** aus dem geschriebenen Text. Wer erst plant und dann schreibt, hat sie danach zwangsläufig zweimal — und jede Brücke im Haus führt seither zwei Spalten (`plot_beat_figures` + `plot_beat_draft_figures`, `motif_figures` + `motif_draft_figures`), jede Combobox zwei Gruppen. Der Zeiger löst das **zur Lesezeit** auf, ohne eine der beiden Zeilen zu töten.

**Bewusst kein Promotion-Pfad** (ein Draft wird nie zur Katalog-Figur): `figures` ist der abgeleitete Index der Komplettanalyse und überschriebe eine hineingeschriebene Zeile beim nächsten Lauf. Gesetzt wird nur ein Zeiger — dieselbe Haltung wie [db/entity-merge.js](../db/entity-merge.js) beim Verschmelzen zweier Katalog-Zeilen: Referenzen umhängen, nichts erfinden.

Pflicht: **bestätigt wird von Hand** (Namensgleichheit ist bloss vorausgewählt — ein automatisch gesetzter Zeiger wäre eine Behauptung über zwei Figuren, die nur der Autor treffen kann), eine Katalog-Figur hängt an **höchstens einem** Draft (`409 ALREADY_IMPORTED` sonst, wie beim Import), und der Owner-Check verbietet Pre-Migration-Figuren mit `user_email IS NULL` (kein Zeiger ohne reverse-Owner-Pfad). Der Lesepfad liefert zusätzlich `source_fig_id` (die TEXT-`fig_id` der Quelle) — das ist die Identität, mit der Frontend und Werkbank Katalog-Figuren adressieren.

## Run-Historie

`werkstatt_runs` listet alle KI-Läufe pro Draft. Frontend rendert zwei klappbare Sektionen (brainstorm + consistency) mit `created_at DESC`. Re-Open lädt `result_json`; bei Brainstorm prüft Apply client-seitig, ob `knoten_id` noch existiert (Mindmap kann sich seit dem Lauf geändert haben).

## Locking & Konfliktverhalten

- **Job-Dedup:** `findActiveJobId('werkstatt-brainstorm', `${draftId}|${knotenId}`, userEmail)` — Brainstorm pro (Draft, Knoten) eindeutig; Consistency pro Draft eindeutig.
- **Dirty-Reload:** `card:refresh` ruft `appConfirm` mit `werkstatt.confirmReload` bei `isDirty()`.
- **Tab-Close:** `beforeunload` zeigt native Browser-Prompt bei dirty-State (Custom-Modal in beforeunload nicht möglich).
- **Draft-Wechsel:** `selectDraft(id)` ruft `saveDraft()` vor Wechsel — kein Edit-Loss.

## i18n

Server-Status-Keys: `job.werkstatt.brainstorm.aiReply`, `job.werkstatt.consistency.aiReply`. Fehler: `job.error.werkstatt.draftMissing|knotenMissing|vorschlaegeMissing|konflikteMissing|fazitMissing`. Default-Mindmap-Marker: `werkstatt.tree.{steckbrief|aussehen|persoenlichkeit|hintergrund|beziehungen|konflikt|bogen|stimme|sprechweise|phrasen|verben|subtext|want|need|wound|lie|custom}`. Vollständige Keys siehe `werkstatt.*` in [public/js/i18n/de.json](../public/js/i18n/de.json) / [en.json](../public/js/i18n/en.json).

## Buch-Chat-Tools (read-only)

Der Agentic Buch-Chat kann die Werkstatt-Drafts des aktuellen Users lesen. Implementiert in [routes/jobs/book-chat-tools.js](../routes/jobs/book-chat-tools.js), Schemas in [public/js/prompts/chat.js](../public/js/prompts/chat.js#BOOK_CHAT_TOOLS).

| Tool | Eingabe | Output |
|------|---------|--------|
| `list_werkstatt_drafts` | — | `drafts[{draft_id,name,archetype,source_figure_name,notes,updated_at,runs:{brainstorm,consistency},last_run}]` |
| `get_werkstatt_draft` | `draft_id` ODER `figur_name` (+ optional `include_runs`, `run_limit`) | Volle Draft-Metadaten + `mindmap_text` (eingerückte Bullet-Liste in User-Locale) + `runs` (gekürzt) |

User-Scope wie überall in der Werkstatt: `WHERE book_id=? AND user_email=?`. Cross-User-/Cross-Book-Zugriff liefert `error: 'Werkstatt-Draft nicht gefunden'`. `mindmap_json`-i18n-Marker werden via `resolveI18nTree(locale)` aus [lib/i18n-server.js](../lib/i18n-server.js) aufgelöst. Run-Snippets sind hart geclampt (Begründung 160, Problem 240, Fazit 400 Zeichen).

## Tests

- [tests/unit/draft-figures-db.test.js](../tests/unit/draft-figures-db.test.js) — CRUD + Run-Insert/List/Get/Delete + Cascade + `listImportableFigures` (Katalog-Reihenfolge, Namens-Dedupe, Ausschluss bereits importierter Figuren).
- [tests/integration/figur-werkstatt.test.js](../tests/integration/figur-werkstatt.test.js) — Brainstorm + Consistency mit Mock-AI, Pfad-Resolve, Severity-Fallback, **Quell-Figur-Ausschluss** (beide Filter, gegen den gebauten Prompt geprueft) und **Modell-Provenienz** des Laufs (effektiver Provider statt Claude-Fallback).
- [tests/unit/figur-werkstatt-severity-drift.test.mjs](../tests/unit/figur-werkstatt-severity-drift.test.mjs) — haelt die drei Fassungen der Schwere-Skala deckungsgleich (Prompt-Enum, CJS-Kopie im Job-Router, `.severity-tag--*` im CSS).
- [tests/integration/book-chat-werkstatt-tools.test.js](../tests/integration/book-chat-werkstatt-tools.test.js) — Buch-Chat-Tools: User-Scope, Cross-Book-Isolation, Mindmap-i18n-Resolve, Run-Snippets.
