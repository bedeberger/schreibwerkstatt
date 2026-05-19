<!--
Template für Feature-Pläne unter docs/ideen/.

Kopieren nach `docs/ideen/<slug>.md`, dann Sektionen ausfüllen.
Reihenfolge ist verbindlich — nicht umsortieren. Optionale Sektionen
explizit als "n/a" markieren statt entfernen, damit Drift sichtbar wird.

Caveman-Hinweis: hier KEIN Caveman-Stil. Pläne sind dokumentarisch,
müssen auch in 6 Monaten lesbar sein.
-->

# <Feature-Name>

> **Status:** Draft <!-- Draft | Ready | In-Progress | Done | Cancelled -->
> **Autor:** <name>
> **Letztes Update:** YYYY-MM-DD
> **Aufwand:** <X> Tage (Confidence: low|med|high)
> **Severity bei Bug:** low|med|high <!-- Daten- oder Auth-relevant = high -->

## Context

Ein Absatz: was, warum jetzt, welcher User-Pain. Verlinkung auf Issue/Ticket falls vorhanden.

## Scope MVP

Was im ersten Wurf rein muss. Bullet-Liste, jedes Item testbar.

## Out-of-Scope (Phase 2)

Was bewusst weggelassen wird — verhindert Scope-Creep im Review. Jedes Item kurz begründet ("erst messen", "kein User-Bedarf belegt", "blockiert MVP-Ship").

## Done when (Akzeptanzkriterien)

Konkrete Demo-Szenarien, an denen ein Reviewer ohne Plan-Wissen das Feature abnehmen kann. Imperative Sätze, prüfbar.

Beispiel:
- User mit Rolle X öffnet Tab Y → sieht Z innerhalb von N Sekunden.
- Bei deaktiviertem Feature: Endpoint liefert 404, kein Frontend-Crash.

## Hard-Rule-Audit

Welche CLAUDE.md-Regeln berührt das Feature? Pflicht-Mapping — verhindert, dass im Review gefragt wird "habt ihr an X gedacht?".

| CLAUDE.md-Regel | Anwendbar? | Notiz |
|---|---|---|
| KI-Calls nur via Job-Queue | ja/nein/n/a | … |
| Content-Store-Facade einziger Eintrittspunkt | ja/nein/n/a | … |
| Prompts nur unter `public/js/prompts/` | ja/nein/n/a | … |
| UI-Strings nur in i18n-Files | ja/nein/n/a | … |
| Styles nur in `public/css/` | ja/nein/n/a | … |
| Combobox statt `<select>` | ja/nein/n/a | … |
| numInput statt `<input type=number>` | ja/nein/n/a | … |
| `SHELL_CACHE` bump | ja/nein/n/a | … |
| DESIGN.md-Eintrag (neues UI-Pattern) | ja/nein/n/a | … |
| FK-Integration bei neuer Tabelle | ja/nein/n/a | … |
| ISO+Z-Timestamps (NOW_ISO_SQL) | ja/nein/n/a | … |
| Logging-Context book-slot | ja/nein/n/a | … |
| Job-Ergebnisse mit updatedAt-Staleness-Check | ja/nein/n/a | … |
| x-html nur escaped | ja/nein/n/a | … |
| EXCLUSIVE_CARDS + FEATURES + ALLOWED_KEYS | ja/nein/n/a | … |

## Abhängigkeiten

- **Andere Pläne:** Links zu blockierenden/ergänzenden `docs/ideen/*.md`.
- **Externe Services:** Container, APIs, Cron-Jobs, ENV-Vars.
- **DB-Schema-Version:** Min-Version oder neue Migration N erforderlich.

## Backend

### Routen

Liste der HTTP-Endpoints mit Auth-Anforderung, Request-/Response-Schema-Kurzform.

### Module / Libs

Neue Dateien unter `lib/`, `db/`, `routes/`. Pro Datei Einzweck-Beschreibung.

### Jobs (falls KI)

Job-Typ, Phasen, Schema-Validierung, Cache-Strategie, Checkpoint-Logik. `PROMPTS_VERSION`-Bump nötig?

## Frontend

### State / Karte

- Alpine.data-Sub-Name + Datei.
- State-Felder (Initial-Werte).
- Methoden-Liste mit Kurz-Beschreibung.
- `EXCLUSIVE_CARDS`/`FEATURES`/`ALLOWED_KEYS`-Einträge.

### Partials

Datei + welche Komponenten (Combobox, numInput, etc.) sie nutzt.

### Lifecycle / Events

`book:changed`/`view:reset`/`card:refresh`/`job:reconnect` — welche werden gehört/dispatched.

## CSS

- Neue Datei(en) unter `public/css/<subfolder>/`.
- Neue Tokens unter `public/css/tokens/`.
- Neue Card-Akzente in `card-accents.css`.
- `<link>` in `public/index.html` + `SHELL_CACHE` bump + `DESIGN.md`-Eintrag.

## i18n

Tabelle: Key → DE-Wert → EN-Wert. Beide Locales gleichzeitig — keine "mache ich später"-Items.

## DB

- Neue Tabellen + FK-Strategie (CASCADE/SET NULL/RESTRICT).
- Neue Spalten (Migration N) — Recreate-Pattern bei FK-Anreicherung.
- Indexe.
- Squashed-Schema-Regen-Pflicht: `npm run squash:regen`.
- ERD-Update: `docs/erd.md` im selben Commit.

n/a falls keine Schema-Änderung.

## Security / Auth

- Wer darf den Endpoint aufrufen (`requireAdmin` / Session-Guard / `requireBookRole`)?
- Sensible Daten im Response? Masking nötig?
- Audit-Log-Events.
- Rate-Limiting nötig?
- XSS-Vektoren bei neuen `x-html`-Sinks.

## Telemetrie / Observability

- Welche Logs (Level + Scope-Tag).
- Welche Audit-Events.
- Welche Metriken/Counter (falls vorhanden).
- Frontend-Tracking (Plausible-Event? Usage-Track?).

## Reversibilität / Rollback

- Feature-Flag (App-Setting) oder ENV-Var?
- Schema-Migration rückwärtsfähig? Falls nein: explizit erwähnen.
- Daten-Cleanup-Skript falls Tabelle gedroppt werden müsste.

## Tests

| Stufe | Datei | Was wird abgedeckt |
|---|---|---|
| Unit | `tests/unit/<name>.test.mjs` | … |
| Integration | `tests/integration/<name>.test.js` | … |
| E2E | `tests/e2e/<name>.spec.js` | … |
| Manuell | — | Was sich nicht automatisieren lässt (Container-Start, Print-Output, Mobile-Resize) |

## Edge-Cases / Risiken

Pro Item: Symptom + Mitigation + Schwere (low/med/high).

## Kritische Dateien (Modify)

| Datei | Änderung |
|---|---|
| … | … |

## Kritische Dateien (Create)

| Datei | Zweck |
|---|---|
| … | … |

## Offene Fragen

Bullet-Liste — entscheidet sich vor Implementierung. Plan ist erst `Ready`, wenn diese Sektion leer/aufgelöst ist.
