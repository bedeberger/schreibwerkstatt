# Komplettanalyse

Kern-Pipeline, die ein ganzes Buch in einem Hintergrund-Job in den strukturierten Katalog überführt: **Figuren** (inkl. Soziogramm + Beziehungen), **Orte/Schauplätze**, **Songs**, **Welt-Fakten**, **Szenen**, **Lebensereignisse/Zeitstrahl** und **Kontinuitäts-Befunde**. Code: [routes/jobs/komplett/](../routes/jobs/komplett/) — `index.js` (Router), `job.js` (Orchestrierung beider Jobs + Cron), `phases.js` (P1–P6), `figuren-merge.js` + `remap.js` + `utils.js` + `checkpoint.js` (pure Helper). Prompts/Schemas: [public/js/prompts/komplett.js](../public/js/prompts/komplett.js). Provider-Vertrag: [docs/ai-providers.md](ai-providers.md). Job-Lifecycle: [docs/jobs.md](jobs.md).

## Einstiegspunkte

| Route | Methode | ACL | Zweck |
|---|---|---|---|
| `/jobs/komplett-analyse` | POST | editor | Volle Pipeline `runKomplettAnalyseJob` |
| `/jobs/kontinuitaet` | POST | editor | Nur Phase 8 `runKontinuitaetJob` (eigenständig) |
| `/jobs/kontinuitaet/:book_id` | GET | viewer | Letztes gespeichertes Check-Ergebnis |
| `/jobs/kontinuitaet/issue/:issue_id/resolved` | POST | editor | Issue als erledigt/offen markieren |
| `/jobs/chapter-cache/:book_id` | DELETE | editor | Delta-Cache des Buchs leeren (Force-Reanalyse) |

Dedup pro POST über `findActiveJobId(type, bookId, userEmail)` — ein bereits laufender Job wird mit `{ existing: true }` zurückgegeben statt doppelt eingereiht.

**Nacht-Cron `runKomplettAnalyseAll`** ([job.js](../routes/jobs/komplett/job.js)): **derzeit deaktiviert** — die `cron.schedule`-Registrierung in [server.js](../server.js) ist auskommentiert; die Funktion existiert, wird aber ausserhalb von Tests nicht aufgerufen. Bei Reaktivierung reiht sie pro Buch × pro berechtigtem aktiven User (`book_access`, Privacy-Boundary) einen `komplett-analyse`-Job ein. Provider aus `ai.provider` (Default `claude`; gültige Werte `claude`/`ollama`/`openai-compat`); bei `ollama`/`openai-compat` übersprungen, wenn der jeweilige Host nicht konfiguriert ist (bei `claude` läuft er immer). Läuft bereits aktive (Buch, User)-Kombinationen nicht doppelt.

## Single-Pass vs. Multi-Pass

`chunkLimitsFor(provider)` leitet `singlePassLimit`/`perChunkLimit` aus dem Provider-Kontextfenster ab (`INPUT_BUDGET_CHARS` × 70 % / 35 %, siehe [lib/ai.js](../lib/ai.js)). Bei Claude (200K-Kontext) ≈ 420K Zeichen Single-Pass — deckt fast alle Bücher ab.

- **`totalChars <= singlePassLimit` → Single-Pass:** ein „Kapitel" namens `Gesamtbuch`. Das Modell sieht den vollen Text → Phase 2/3/3b/Soziogramm-Refine werden übersprungen (die Extraktion ist bereits holistisch). `passMode: 'single'` ans Job-Schema → die Frontend-Phasenanzeige blendet Phase 3b aus.
- **sonst → Multi-Pass:** Kapitel werden zu Chunks gruppiert und einzeln extrahiert; Phase 2/3 konsolidieren über alle Chunks.

## Pipeline

```
Seiten laden (Content-Store) → Buchtext-Preprocessing (claude-only: Entities/ZWS/Whitespace)
   ↓
P1  Vollextraktion  → Figuren · Orte · Songs · Fakten · Szenen · Lebensereignisse
   ↓                  Checkpoint 'p1_full_done'  +  Welt-Fakten persistiert
P2  Figuren konsolidieren  (+ regelbasierter Dedup/Merge, + Soziogramm)   ┐ Claude-Multi-Pass:
P3  Orte konsolidieren                                                     ┘ P2 ∥ P3 parallel
P3-Songs  Musikbibliothek konsolidieren
P3b Kapitelübergreifende Beziehungen   (nur Multi-Pass, non-critical)
   ↓
P5  Szenen + Assignments remappen (Klarnamen → IDs), Szenen/Events speichern
P6  Zeitstrahl konsolidieren        ┐ Claude: P6 (silent) ∥ P8 (ownt Progress 82..97)
P8  Kontinuitätsprüfung             ┘ lokal: sequentiell (Mutex)
   ↓
Checkpoint löschen → completeJob({ figCount, orteCount, songsCount, szenenCount, warnings, … })
```

### Phase 1 – Vollextraktion

Schema + Regeln liegen im **System-Prompt** (`SYSTEM_KOMPLETT_*_BLOCKS`) → über alle Kapitel-Calls gecacht. Szenen/Assignments verwenden **Klarnamen** statt IDs (ID-Remap erst nach P2/P3).

- **Claude Single-Pass — 5 Calls:** A1 Figuren-Stammdaten (NUR Stammdaten – ohne Beziehungen, ohne Lebensereignisse) + B Orte/Songs/Szenen + C Fakten laufen parallel (mit Warmup: A1 seriell zuerst, schreibt den 1h-`bookSystemBlock`-Cache; B/C lesen ihn). Danach **E Lebensereignisse** (eigener Call gegen den gecachten Buchblock mit der finalen Figurenliste) und A2 Beziehungen aus den stabilen A1-IDs (via `mergeBeziehungenIntoFiguren` zurück in `figuren[].beziehungen` gefaltet). Kleinere Schemas pro Call senken das Truncation-Risiko; **Fakten (C) und Lebensereignisse (E) als eigene Calls = volle Modell-Aufmerksamkeit** statt im A1/B-Output ums Attention-Budget zu konkurrieren (kritisch für Event-Recall bei grossen Büchern). E läuft NACH den Completeness-Pässen, damit auch ergänzte Long-Tail-Figuren Events bekommen; `figur_name` referenziert die kanonische Figurenliste (Remap in P5). **non-fatal** (gescheitertes E → leere Events + `job.warn.eventsFailed` + Cache-Skip, wie C).
- **Completeness-/Gap-Pässe (`ai.komplett.completeness_passes`, Default 2; 0 = aus, nur Claude Single-Pass):** Ein einzelner Extraktions-Call erfasst Haupt-Entitäten zuverlässig, lässt aber den Long-Tail (Nebenfiguren, Einmal-Schauplätze) oft aus. Nach A1/B prompten `runCompletenessGap` (in [phases.js](../routes/jobs/komplett/phases.js)) bis zu N-mal erneut gegen denselben gecachten Buchtext-Block + dasselbe System-Schema (`buildFigurenStammGapPrompt`/`buildOrteGapPrompt`), mit der Liste der bereits gefundenen Namen, und ziehen FEHLENDE Entitäten nach. **Additiv** (nie droppen), dedupliziert per normalisiertem Namen, **loop-until-dry** (Stop sobald eine Runde nichts Neues liefert), **non-fatal** (gescheiterter Gap-Call verwirft die Haupt-Extraktion nicht). Gap-Figuren/-Orte bekommen frische, kollisionsfreie IDs (Gap-Output beginnt wieder bei `fig_1`/`ort_1`). Läuft VOR A2, damit der Beziehungs-Pass die ergänzten Figuren abdeckt. Wird in den `__singlepass__`-Cache eingefroren; `completeness_passes` fliesst (geclampt) in die `cacheVersion` ein → eine Änderung des Settings invalidiert Single-/Multi-Pass-Cache **und** Checkpoint automatisch (kein manuelles `DELETE /jobs/chapter-cache/:book_id` mehr nötig).
- **Per-Job-Claude-Overrides (nur `ai.provider = claude`):** Die Komplettanalyse-Familie (P1–P8 + `runKontinuitaetJob`) kann eigenständig vom globalen `ai.claude.*` abweichen — `ai.claude.model.komplett` (leer = folgt global), `ai.claude.context_window.komplett`, `ai.claude.max_tokens_out.komplett` und `ai.claude.timeout_ms.komplett` (0 = folgt global). Typisch: Opus 4.8 mit 128K Output + längerem Hard-Timeout für die gründlichere Extraktion, während global Sonnet 4.6 / 64K / 10min fürs Lektorat läuft. `runKomplettAnalyseJob`/`runKontinuitaetJob` reichen die Overrides via ALS-Context (`setContext({ claudeModel, claudeContextWindow, claudeMaxTokensOut, claudeTimeoutMs })`) an [lib/ai.js](../lib/ai.js) (`_resolveClaudeModel`/`_resolveClaudeContextWindow`/`_resolveClaudeMaxOut`/`_claudeTimeoutMs`) durch — `getContextConfigFor('claude')`, der Output-Cap in `_callClaude`, der Hard-Timeout pro Call und der 1M-Beta-Header lesen daraus, ohne globale (z.B. Sonnet-)Calls zu beeinflussen. Das Modell fliesst in die `cacheVersion` ein (Modellwechsel invalidiert die Caches; Kontext/Output/Timeout ändern nur Limits, nicht den Inhalt). `temperature` wird für Opus 4.7+ automatisch weggelassen (sonst HTTP 400; `_claudeAcceptsTemperature`). **`max_tokens_out.komplett` muss zum Komplett-Modell passen** (Sonnet 4.6 ≤ 64000, Opus 4.8 ≤ 128000) — ein zu hoch gesetzter Wert wird in [lib/ai.js](../lib/ai.js) (`_claudeModelMaxOut`) hart aufs Modell-Ceiling geklemmt, statt mit HTTP 400 (non-retryable) den Job zu killen. **`timeout_ms.komplett`:** Der Hard-Timeout greift **pro Call** (nicht pro Job); Opus ist langsamer und der Single-Pass macht mehrere grosse Calls (A1∥B∥C, Completeness, A2), darum reicht der globale 10-Min-Default oft nicht. 40 Min (`2400000`) sind ein guter Startwert, Max 60 Min (`3600000`).
- **Lokale Provider / Multi-Pass:** kombinierter Call (`SCHEMA_KOMPLETT_EXTRAKTION`) bzw. zweigeteilt Pass A (Figuren+Assignments) + Pass B (Orte/Songs/Fakten/Szenen) — kein 1h-Cache, daher kein 3-Call-Split.
- **Output-Cap:** Claude deckelt direkt aufs Provider-Ceiling (reserviertes `max_tokens` ist gratis, keine Retry-Ladder nötig). **Caveat (Opus 4.7+ adaptive thinking):** Reasoning-Tokens zählen gegen dasselbe `max_tokens`-Budget wie das sichtbare JSON; bei sehr dichten Büchern ist Truncation des JSON daher nicht *strukturell* ausgeschlossen (in der Praxis liegt Extraktions-JSON weit unter dem 128K-Opus-Cap). Lokal knapper auf `ai.komplett.extract_max_tokens`, mit einmaliger Eskalation aufs Ceiling bei `job.error.aiTruncated`.
- **Multi-Pass TPM-Schutz (Claude):** Warmup-Chunk seriell (kleinster zuerst), dann Concurrency-Cap `ai.claude.phase1_concurrency` (Default 4). Progress wird pro abgeschlossenem Chunk monoton gebumpt.
- Ein gescheiterter Chunk im Multi-Pass → `job.error.phase1Incomplete` (hart). Single-Pass: A1/B hart, **C (Fakten), E (Lebensereignisse) und A2 (Beziehungen) non-fatal** (siehe Cache-Skip unten).

### Phase 2 – Figuren konsolidieren

Single-Pass: P1-Figuren direkt übernommen (IDs normalisiert), kein KI-Call. Multi-Pass: regelbasierter `preMergeChapterFiguren` (rollierender Dedup vor dem KI-Call) → KI-Konsolidierung → `mergeDuplicateFiguren`. Danach immer (alle Provider): `validateBeziehungenDescriptions` (Beschreibungs-Rescue). Lokal zusätzlich `applySozialschichtModeVote`. `backfillFiguren` legt Figuren an, die in ≥2 Szenen/Events vorkommen aber fehlen (Phase-1-Recall-Lücke). Persistenz via `saveFigurenToDb` + `recomputeBookFigureMentions`.

**Soziogramm** (≥4 Figuren): preliminary `sozialschicht`/`machtverhaltnis` aus dem P2-Ergebnis; bei Claude-Multi-Pass zusätzlich ein holistischer Refine-Call (`SCHEMA_SOZIOGRAMM_KONSOL`, non-critical → `job.warn.soziogrammDegraded`).

### Phase 3 / 3-Songs / 3b

- **P3 Orte:** Single-Pass direkt übernommen; Multi-Pass KI-Konsolidierung. `figuren`-Refs werden gegen `idRemap` (aus `mergeDuplicateFiguren`) + `validFigIds` umgebogen/gefiltert. Bei Claude-Multi-Pass läuft der Orte-Call **parallel zu P2** mit prelim-figurenKompakt, Remap post-hoc.
- **P3-Songs:** analog Orten; KI-Call nur wenn überhaupt Songs extrahiert wurden.
- **P3b Kapitelübergreifende Beziehungen** (nur Multi-Pass, non-critical → `job.warn.crossChapterFailed`): statt `fullBookText` zu trunkieren, **Co-Occurrence-Auswahl** — gezielt Seiten, auf denen ≥2 Figuren aus verschiedenen Heimat-Kapiteln gemeinsam vorkommen und noch keine Beziehung existiert (via `computeFigureMentions`). Fallback: Trunkierung.

### Phase 5 – Remap & Speichern

`remapSzenen` / `remapAssignments` ([remap.js](../routes/jobs/komplett/remap.js)) mappen Phase-1-Klarnamen auf konsolidierte IDs (`figNameToId` + lowercase + Token-Fallback aus `buildFigNameLookup`). Nicht auflösbare Namen werden gedroppt (aggregiert geloggt). KI-Halluzinationen geglättet: Markdown-`##`-Präfix gestrippt, Kapitelname-als-Seitentitel und `Sonstige Seiten` → `null`. Events pro Figur dedupliziert (`datum_year/month/day` + Ereignis-Text). `saveSzenenAndEvents` schreibt `figure_scenes`/`scene_figures`/`scene_locations`, Events via `updateFigurenEvents`, und reindexiert FTS (scene/figure/location).

### Phase 6 – Zeitstrahl

Aus den gespeicherten `figure_events` gruppiert (Datum + Ereignis-Text), strukturiert sortiert (Events ohne Jahr ans Ende). <5 Events → direkt speichern (KI-Call gespart); sonst Konsolidierungs-Call (`SCHEMA_ZEITSTRAHL`).

### Phase 8 – Kontinuitätsprüfung

- **Single-Pass (Claude, voller Text im Prompt):** `buildKontinuitaetSinglePassPrompt` mit demselben 1h-`bookSystemBlock` wie P1 → Cache-Treffer. Anschliessend Beleg-Prüfung in `saveKontinuitaetResult` (`requireQuoteEvidence`): liefert ein Befund ein wörtliches Zitat, das im Buchtext nicht auffindbar ist → verworfen.
- **Multi-Pass (lokal, oder grosses Buch):** Fakten pro Kapitel extrahieren → `buildKontinuitaetCheckPrompt`. Bei Claude folgt die **Verify-Stufe** `verifyKontinuitaetProbleme`: pro Befund werden die Original-Textstellen (±1500 Zeichen ums Zitat) nachgeladen und das Modell bestätigt/verwirft den Widerspruch mit echtem Kontext (`SCHEMA_KONTINUITAET_VERIFY`). Konservativ: nur explizit als unecht (`bestaetigt=false`) eingestufte werden verworfen.
- `saveKontinuitaetResult` filtert zusätzlich Selbst-Entwarnungen (`SELF_CANCEL_PATTERN`, synchron mit `PROBLEME_RULES` im Prompt).
- **P8 ist die letzte, read-only Phase:** ein Fehler hier verwirft den bereits gespeicherten Katalog **nicht** — Kontinuität wird übersprungen, `job.warn.continuityFailed` gesammelt, Job bleibt `done`.

## Caching & Resume

Drei unabhängige Mechanismen:

1. **Anthropic-Prompt-Cache (1h):** byte-identischer `bookSystemBlock` (`buildBookSystemBlockText`) über P1-Calls + P8 → cache_read statt cache_creation. Multi-Pass-Chunks teilen den System-Prompt mit Schema.
2. **Delta-Cache (DB, persistent):** `chapter_extract_cache` (Multi-Pass, pro Chunk) bzw. `book_extract_cache` (Single-Pass, `chapter_key='__singlepass__'`). Key = `pages_sig` = sortierte `page_id:updated_at` + Settings-Anteil (`bookSettingsSigPart`) + **Kapitelname** (Multi-Pass-Chunk-Sig: `ch:<name>`) + **`cacheVersion`** (`modelName:PROMPTS_VERSION:cp<completeness_passes>`). Ändert sich eine Seite, der Buchtyp/Kontext, der Kapitelname, das Modell, die Prompt-Schema-Version oder `completeness_passes` → Cache-Miss. Provider ist Teil des Primary Key (kein Cross-Provider-Bleeding). **Umbenannte Kapitel** invalidieren ihren Multi-Pass-Eintrag automatisch über den Kapitelnamen im Chunk-`pages_sig` (keine separate Invalidierungs-Funktion mehr).
3. **Checkpoint (DB):** Phase 1 speichert `p1_full_done` mit allen sechs Arrays + `bookPagesSig` — **nur bei vollständiger Phase 1** (`partialFailure`-Gate, symmetrisch zum Delta-Cache-Skip: bei A2/C/E-Fehler bzw. truncierten Chunks wird der Checkpoint übersprungen, sonst friert ein Crash nach Phase 1 den degradierten Stand ein und der Resume überspringt Phase 1 ohne Nachholen). Beim Resume nur verwendet, wenn `cp.bookPagesSig === bookPagesSig` (sonst stale nach Edit/Crash/Version-Bump → verworfen, Phase 1 neu).

**Cache-Skip bei Teilfehler (Phantom-Erfolg-Schutz, Single-Pass Claude):** scheitert A2 (`relationsFailed`), C (`faktenFailed`) oder E (`eventsFailed`), darf der beziehungs-/fakten-/eventlose Teilstand **nicht** unter `__singlepass__` eingefroren werden — sonst läge er bei jedem Folgelauf als HIT vor (Phantom-Erfolg), bis eine Seitenedition die Signatur ändert. Stattdessen Cache-Skip + `job.warn.relationsFailed`/`job.warn.faktenFailed`/`job.warn.eventsFailed`. **Derselbe Teilfehler gated auch den Checkpoint** (`partialFailure` in `runPhase1`) — sonst kehrte der Phantom-Erfolg über den Resume-Pfad zurück (Crash nach P1 → Resume lädt den degradierten Stand). Im Multi-Pass gilt das analog für truncierte Chunks (`job.warn.chunksTruncated`).

## Berührte DB-Tabellen

`figures` · `figure_relations` · `figure_scenes` + `scene_figures` + `scene_locations` · `figure_events` · `locations` + `location_chapters` · `songs` · `world_facts` + `world_fact_chapters` · `continuity_issues` + Bridges · `page_figure_mentions` · `chapter_extract_cache` / `book_extract_cache` · `job_checkpoints` · FTS-Index. Schema/FKs: [docs/erd.md](erd.md). Schreibzugriff auf Buchinhalte ausschliesslich über die Content-Store-Facade; Katalog-Tabellen direkt via [db/schema.js](../db/schema.js)/[db/figures.js](../db/figures.js).

## Pflicht-Invarianten

- **`truncated`/Schema-Pflichtfeld nach jedem `callAI` prüfen** (CLAUDE.md-Regel `callAI gibt nur JSON zurück`). Phase-1-Truncation eskaliert einmal den Output-Cap statt den Chunk zu verwerfen.
- **Single-Pass-Cache UND Checkpoint nie bei Teilfehler einfrieren** (`relationsFailed`/`faktenFailed`/`eventsFailed` bzw. truncierte Multi-Pass-Chunks → Skip beider via `partialFailure`). Test: [komplett.test.js](../tests/integration/komplett.test.js).
- **`bookSystemBlock` byte-identisch** in P1 und P8 halten — sonst bricht der 1h-Cache-Prefix-Match (`buildBookSystemBlockText` ist SSoT).
- **`pages_sig` synchron** zwischen Single-Pass-Key (`buildBookPagesSig`) und Multi-Pass-Chunk-Keys (gleicher `settingsSig` + `cacheVersion`; Multi-Pass zusätzlich `ch:<Kapitelname>` für Rename-Invalidation).
- **Checkpoint-Resume nur bei `bookPagesSig`-Match** — verhindert stale Extraktion nach Edit/Version-Bump.
- **P8-Fehler darf den Katalog nicht verwerfen** (read-only Endphase → Warnung, Job `done`).
- **non-critical-Degradierungen als `warnings` ins Job-Result** (`{ key }`), nicht nur ins Log — User unterscheidet „Teilphase übersprungen" von „alles ok".

## Tests

| Bereich | Datei |
|---|---|
| Pipeline (Single/Multi-Pass, Delta-Cache, Checkpoint, P2/P3/P6, faktenFailed-Cache-**und**-Checkpoint-Skip, Rename-Invalidation des Chunk-Caches) | [tests/integration/komplett.test.js](../tests/integration/komplett.test.js) |
| Event-Struktur (Datumsfelder, Subtyp-Whitelist, Sortierung) | [tests/integration/komplett-events-schema.test.js](../tests/integration/komplett-events-schema.test.js) |
| Kontinuität (Single-Pass, Verify-Stufe, Fehlerfälle) | [tests/integration/kontinuitaet.test.js](../tests/integration/kontinuitaet.test.js) |
| Cross-Job-Regressionen (Truncation, AbortError) | [tests/integration/regression.test.js](../tests/integration/regression.test.js) |
| Pure-Helper Figuren-Dedup/Merge (preMerge, mergeDuplicate, modeVote, Beschreibungs-Rescue) | [tests/unit/figuren-merge.test.js](../tests/unit/figuren-merge.test.js) |
| Pure-Helper Remap (Szenen/Assignments → IDs, Drop, Dedup, Präfix-Glättung) | [tests/unit/komplett-remap.test.js](../tests/unit/komplett-remap.test.js) |
| `mergeBeziehungenIntoFiguren` | [tests/unit/figuren-beziehungen-merge.test.js](../tests/unit/figuren-beziehungen-merge.test.js) |
| `backfillFiguren` | [tests/unit/figuren-backfill.test.js](../tests/unit/figuren-backfill.test.js) |

**Offene Lücken:** `runKomplettAnalyseAll` (Cron, ACL-Boundary — derzeit deaktiviert, daher dormant) und die P3b Co-Occurrence-Auswahl sind nur indirekt bzw. nicht getestet. `_isSelfCancelled` (inkl. Rang-7-Negativfall: Lösungs-Empfehlung wird NICHT verworfen) ist in [komplett-remap.test.js](../tests/unit/komplett-remap.test.js) abgedeckt.
