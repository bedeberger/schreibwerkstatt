# <Feature-Name>

- **Status:** Draft <!-- Draft → Ready erst wenn „Offene Fragen" leer -->
- **Aufwand:** S | M | L | XL
- **Severity:** low | medium | high <!-- wie kritisch für Produkt-Strategie -->

## Context

Warum dieses Feature? Welches User-Problem, welche Lücke. Bezug zur Produkt-Linie.

## Scope MVP

Minimaler erster Wurf. Bullet-Liste konkreter, abnehmbarer Punkte.

## Out-of-Scope

Was bewusst NICHT Teil des MVP ist (Phase 2, oder dauerhaft ausgeschlossen). Konflikte mit Produkt-Prinzipien hier benennen.

## Done when

Abnahme-Kriterien. Beobachtbar, testbar.

## Hard-Rule-Audit

Durchgang durch die „Harte Regeln" aus CLAUDE.md, die das Feature berührt — pro Regel: betroffen ja/nein + wie eingehalten. (Editor-Spezifikation, i18n, CSS, Content-Store-Facade, DB-Integrität, Job-Queue, x-html-Escape, Combobox/numInput/LanguageTool, SHELL_CACHE …)

## Abhängigkeiten

Andere Features/Module, die vorausgesetzt oder berührt werden.

## Backend

Routen, Jobs, Libs. Pro Endpoint: Methode + Pfad + Kurzvertrag.

## Frontend

Karten/Sub-Komponenten, State, Events. Card-Recipe-Schritte (Registry, Hash-Router, Exklusivität).

## CSS

Neue Dateien/Subfolder, Tokens, Akzentfarbe. `n/a` wenn keine.

## i18n

Neue Key-Bereiche (de + en). `n/a` wenn keine.

## DB

Migration(en), neue Tabellen/Spalten/Indexe, FK + ON-DELETE, ERD-Update. `n/a` wenn keine.

## Security

Auth-Scope, ACL, Escape, Rate-Limit, PII. `n/a` wenn keine.

## Telemetrie

Counter/Metriken. `n/a` wenn keine.

## Reversibilität

Wie wird das Feature wieder ausgebaut/abgeschaltet? Feature-Flag? Daten-Rückbau?

## Tests

Unit/Integration/E2E — was deckt was ab.

## Edge-Cases

Bekannte Grenzfälle + geplanter Umgang.

## Kritische Dateien

- **Modify:** Liste bestehender Dateien.
- **Create:** Liste neuer Dateien.

## Offene Fragen

Muss vor Status `Ready` leer sein. Bis dahin offene Entscheidungen hier.
