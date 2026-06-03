# Tagebuch: „Heute"-Quick-Entry + Schreibimpuls

- **Status:** Draft
- **Aufwand:** S
- **Severity:** low

## Context

Bücher vom Buchtyp `tagebuch` nutzen statt des Baum-Sidebars ein Monats-Kalender-Grid (`sidebarMode='calendar'`, [public/js/book/diary-calendar.js](../../public/js/book/diary-calendar.js)). Eine Tagebuch-Seite = ein Kalendertag, `page_name`-Format `YYYY-MM-DD`.

Der **Quick-Entry-Teil** dieses Features ist **bereits vollständig implementiert**: Der „Heute eintragen"-Button im Kalender-Header ([public/partials/sidebar-calendar.html](../../public/partials/sidebar-calendar.html):22–28) ruft `createDiaryEntryToday()` → `_createDiaryEntry(localIsoDate())`. Diese Methode legt bei Bedarf Jahr-/Monats-Kapitel an, sortiert in `book_order` ein, dedupliziert gegen bestehende Tages-Seiten und öffnet den Notebook-Editor. Der Button ist sichtbar nur bei `canEdit() && !diaryHasTodayEntry()` und nur in der Kalender-Sidebar (also implizit nur bei `isTagebuch()`).

Der **offene Teil** ist der optionale **Schreibimpuls**: ein wechselnder statischer Anstoß (z. B. „Was hat dich heute überrascht?"), der beim Anlegen eines leeren Tages-Eintrags als Starthilfe sichtbar wird. KEIN KI-generierter Text — reiner Impuls aus einem statischen i18n-Pool, gemäß App-Philosophie (KI schreibt nie generativ in den Buchtext).

Dieser Plan dokumentiert daher (a) den IST-Stand des Quick-Entry zur Referenz und (b) die Neu-Arbeit am Schreibimpuls.

## Scope MVP

- IST (Referenz, keine Neu-Arbeit): „Heute eintragen"-Button → öffnet/erzeugt Tages-Eintrag, dedupliziert, legt Jahr/Monat-Kapitel on-the-fly an, springt auf den Monat, öffnet Notebook-Editor.
- NEU: Schreibimpuls als **statischer i18n-Pool** (`diary.impulse.*`, de + en), z. B. 10–15 Anstöße.
- NEU: Auswahl eines Impulses **deterministisch pro Tag** (Funktion des ISO-Datums, nicht random) — derselbe Tag zeigt denselben Impuls bei jedem Öffnen, verschiedene Tage rotieren.
- NEU: Anzeige des Impulses ausschließlich im **Notebook-Editor**, nur wenn der Eintrag **leer** ist (Body == `<p></p>`), als unaufdringlicher Placeholder/Hinweis-Banner über dem Editor-Body — verschwindet, sobald der User tippt.
- NEU: Impuls wird **nie in den Buchtext geschrieben** (kein Voreinfügen in die Page-HTML), nur visuelle Starthilfe.

## Out-of-Scope

- KI-generierte oder kontextabhängige Impulse (verstößt gegen App-Philosophie „KI nie generativ in den Buchtext"). Dauerhaft ausgeschlossen.
- Impuls im Focus-Editor oder Bucheditor — nur Notebook-Editor (Tagebuch-Workflow läuft über die Kalender-Sidebar + Notebook-Edit).
- User-pflegbarer/eigener Impuls-Pool, Impuls-Kategorien, Häufigkeits-Steuerung → ggf. Phase 2.
- Stimmungs-Tags ([tagebuch-stimmung-tags.md](tagebuch-stimmung-tags.md)), Rückblick-Features ([tagebuch-rueckblick.md](tagebuch-rueckblick.md), [tagebuch-jahresrueckblick-ki.md](tagebuch-jahresrueckblick-ki.md), [tagebuch-erinnerung.md](tagebuch-erinnerung.md)), Fotos ([tagebuch-fotos.md](tagebuch-fotos.md)).

## Done when

- Klick auf „Heute eintragen" öffnet bei vorhandenem Tages-Eintrag denselben (kein Duplikat), legt sonst genau eine Seite `YYYY-MM-DD` im korrekten Jahr/Monat-Kapitel an (IST — bereits erfüllt, hier als Regressionsbasis).
- Bei einem **leeren** Tages-Eintrag im Notebook-Editor erscheint ein deterministischer Schreibimpuls (gleicher Tag → gleicher Impuls); ist der Eintrag nicht leer, erscheint kein Impuls.
- Der Impuls-Text steht nie in der gespeicherten Page-HTML (Speichern eines unangetasteten Eintrags persistiert weiterhin `<p></p>`/leer, nicht den Impuls).
- DE + EN Pool vorhanden; UI-Sprache steuert die Impuls-Sprache.
- `npm test` grün; SHELL_CACHE gebumpt.

## Hard-Rule-Audit

- **Editor-Spezifikation:** Betroffen — ausschließlich **Notebook-Editor** ([public/js/editor/notebook/](../../public/js/editor/notebook/)). Focus-Editor und Bucheditor unberührt. Impuls-Anzeige hängt an der Notebook-Edit-View bzw. an einem Wrapper um `.page-content-view`.
- **i18n:** Betroffen — Impuls-Pool als Keys `diary.impulse.1..N` in beiden Locale-Dateien. Keine hartcodierten Strings.
- **CSS:** Betroffen — Impuls-Banner-Style in `public/css/editor/notebook/` (kein Inline-Style). Badge/Hinweis eckig (`--radius-sm`).
- **Content-Store-Facade:** Betroffen nur durch IST-Code (`contentRepo.createPage`/`createChapter` → Facade). Neu-Arbeit (Schreibimpuls) ist rein Frontend-Anzeige, kein zusätzlicher Storage-Pfad.
- **Job-Queue / KI-Calls:** Nicht betroffen — Schreibimpuls ist statisch, kein KI-Call, kein Job.
- **x-html-Escape:** Impuls-Text via `x-text` rendern (kein `x-html`) → kein Escape-Risiko.
- **Combobox/numInput/LanguageTool:** Nicht betroffen (keine neuen Form-Felder; der Impuls-Banner ist read-only Text, kein Prosa-Eingabefeld).
- **DB-Timestamps / Snapshot-Spalten / FK:** Keine DB-Änderung (siehe DB).
- **SHELL_CACHE:** Betroffen — bei JS/CSS-Touch Konstante in [public/sw.js](../../public/sw.js) hochzählen.
- **Lucide-Icons / data-tip:** Falls Icon nötig, via `/icons.svg` + `.icon`; Tooltips via `data-tip`.

## Abhängigkeiten

- Bestehende Kalender-Sidebar + `_createDiaryEntry`-Pipeline ([public/js/book/diary-calendar.js](../../public/js/book/diary-calendar.js)) — IST, Voraussetzung.
- `localIsoDate()` (TZ-aware, [public/js/utils.js](../../public/js/utils.js):152) für „heute" + deterministische Impuls-Auswahl pro Datum.
- Notebook-Editor-Edit-View ([public/js/editor/notebook/edit.js](../../public/js/editor/notebook/edit.js)) — Andock-Punkt für die Anzeige.
- Keine harte Abhängigkeit zu den Geschwister-Plänen ([tagebuch-stimmung-tags.md](tagebuch-stimmung-tags.md), [tagebuch-rueckblick.md](tagebuch-rueckblick.md), [tagebuch-erinnerung.md](tagebuch-erinnerung.md), [tagebuch-jahresrueckblick-ki.md](tagebuch-jahresrueckblick-ki.md), [tagebuch-fotos.md](tagebuch-fotos.md)); Stimmungs-Tags könnten denselben „leerer-Eintrag"-Hook nutzen — bei paralleler Umsetzung Banner-Layout koordinieren.

## Backend

n/a — Quick-Entry läuft über bestehende Content-Store-Facade-Pfade (`POST /content` Page/Chapter-Create via `contentRepo`); Schreibimpuls ist rein Frontend-statisch. Kein neuer Endpoint, kein Job.

## Frontend

**Quick-Entry (IST, Referenz):**
- `diaryCalendarMethods` in [public/js/book/diary-calendar.js](../../public/js/book/diary-calendar.js): `createDiaryEntryToday`, `diaryHasTodayEntry`, `_createDiaryEntry`, `_ensureDiaryYearChapter`, `_resolveDiaryEntryChapter`, `_getDiaryBookLanguage`. State `diaryCalendarYearMonth`, `sidebarMode` in [public/js/app/app-state.js](../../public/js/app/app-state.js):141–142. Button in [public/partials/sidebar-calendar.html](../../public/partials/sidebar-calendar.html).
- Kein neuer Card-Recipe-Schritt nötig: keine eigene Karte, kein Hash-Router-Branch, kein `EXCLUSIVE_CARDS`/`FEATURES`/`ALLOWED_KEYS`-Eintrag — die Funktionalität lebt im Kalender-Sidebar-Scope (Root-Spread via tree.js).

**Schreibimpuls (NEU):**
- Helper in [public/js/book/diary-calendar.js](../../public/js/book/diary-calendar.js): `diaryImpulseForToday()` bzw. `diaryImpulseForDate(dateIso)` — wählt deterministisch via `hash(dateIso) % POOL_SIZE` einen i18n-Key `diary.impulse.<n>` und gibt `t(key)` zurück. Pool-Größe als Konstante.
- Anzeige-Gate: nur wenn (a) Buchtyp `tagebuch`, (b) Notebook-Editor offen, (c) aktuelle Page ist ein Diary-Tag (`page_name` matcht `YYYY-MM-DD`) und (d) Body leer (`<p></p>` oder kein Textinhalt). Gate als Getter (z. B. `diaryShowImpulse()`), `x-show` im Notebook-Edit-Partial.
- Banner via `x-text` (kein `x-html`), oberhalb/innerhalb der Notebook-Edit-View; verschwindet reaktiv, sobald Text vorhanden ist (an bestehenden „leer"-Zustand des Editors koppeln, vgl. `edit.emptyTextAbort`/Caret-Slot-Logik in edit.js:321).
- Kein Voreinfügen in die Page-HTML — der Impuls ist nur DOM-Overlay/Placeholder.

## CSS

- Neue Regel(n) für `.diary-impulse` (Banner/Placeholder) in `public/css/editor/notebook/` (passende bestehende Datei oder neue `diary-impulse.css`). Bei neuer Datei: `<link>` in [public/index.html](../../public/index.html) + Eintrag in DESIGN.md „CSS-File-Inventar" + SHELL_CACHE-Bump.
- Eckiges, gedämpftes Hinweis-Styling (`--radius-sm`, gedämpfte Vordergrundfarbe), nicht als Eingabefeld erscheinend. Mobile-Breakpoint im selben File.

## i18n

Neue Keys (de + en):
- `diary.impulse.1` … `diary.impulse.N` — statischer Impuls-Pool (z. B. N = 12). Beispiele DE: „Was hat dich heute überrascht?", „Wofür bist du heute dankbar?". EN-Pendants.
- Optional `diary.impulseLabel` — kleines Vorlauf-Label/Tooltip am Banner („Schreibimpuls" / „Writing prompt"), falls UI ein Label braucht.

## DB

n/a — keine Migration. Datum lebt weiterhin im `page_name` (`pages` hat kein `created_at`). Jahr/Monat-Kapitel werden über die Content-Store-Facade angelegt (IST). Kein neues Feld, keine neue Tabelle, kein ERD-Update.

## Security

n/a — kein neuer Endpoint, keine neue PII, keine User-Eingabe in den Impuls-Pfad. Page-/Chapter-Create läuft über die bestehende ACL-geschützte Facade (`canEdit()`-Gate am Button). Impuls-Text ist statisch und via `x-text` escaped.

## Telemetrie

n/a für MVP. Optional Phase 2: Counter „Diary-Eintrag via Heute-Button angelegt" — nicht im Scope.

## Reversibilität

- Schreibimpuls: rein additiv. Ausbau = `diaryShowImpulse`-Gate/Banner aus dem Notebook-Edit-Partial entfernen + `diary.impulse.*`-Keys löschen. Keine Datenrückbauten (nichts persistiert).
- Quick-Entry (IST): bereits live; ein Feature-Flag existiert nicht und ist für den Impuls nicht nötig (Gate ist self-contained). Falls gewünscht, Impuls hinter eine Konstante (`FEATURE_DIARY_IMPULSE`) hängen.

## Tests

- **Unit (`tests/unit/`):** `diaryImpulseForDate(dateIso)` — Determinismus (gleiches Datum → gleicher Key), Rotation über mehrere Daten, Index immer im Pool-Bereich. Pool-Vollständigkeit DE == EN (Key-Set-Gleichheit) im i18n-Konsistenztest mitprüfen.
- **Unit:** `diaryShowImpulse()`-Gate — true nur bei tagebuch + Notebook-offen + Diary-Tag + leerer Body; false bei nicht-leerem Body / Nicht-Tagebuch.
- **E2E (`tests/e2e/`, optional):** Diary-Kalender-Harness — „Heute eintragen" klicken, prüfen dass Notebook-Editor öffnet und Impuls-Banner bei leerem Eintrag sichtbar ist und nach Texteingabe verschwindet; Impuls landet nicht im gespeicherten HTML.
- **Regression:** bestehende `_createDiaryEntry`-Dedup/Kapitel-Anlage nicht brechen.

## Edge-Cases

- **Doppelklick auf „Heute":** durch `_diaryCreatingDate`-Re-Entry-Guard abgedeckt (IST).
- **Tageswechsel um Mitternacht / TZ:** „heute" via `localIsoDate()` (app.timezone), nicht Browser-TZ — konsistent mit Server `lib/local-date.js`.
- **Jahr/Monat-Kapitel fehlen / User-eigenes Kapitel-Schema:** `_resolveDiaryEntryChapter`-Heuristik (IST) — kein month-style-Sub → Jahr-Kapitel; sonst passendes/neues Monats-Sub.
- **Eintrag schon vorhanden, aber leer:** Impuls erscheint (Gate prüft Body-Leere, nicht Existenz). Korrekt — User soll Starthilfe auch beim Wieder-Öffnen eines leeren Tages sehen.
- **User tippt, löscht alles wieder:** Impuls erscheint wieder (reaktives Gate). Akzeptabel.
- **Mehrere leere Tage hintereinander:** verschiedene Impulse (deterministische Rotation pro Datum).
- **Pool-Größe ändert sich später:** deterministische Auswahl verschiebt sich pro Tag — kosmetisch unkritisch (kein persistierter Zustand).
- **Sehr alte/zukünftige Datums-Seite manuell geöffnet:** Impuls-Auswahl funktioniert für jedes `YYYY-MM-DD` (Hash über Datumsstring).

## Kritische Dateien

- **Modify:**
  - [public/js/book/diary-calendar.js](../../public/js/book/diary-calendar.js) — `diaryImpulseForDate`/`diaryShowImpulse`-Helper ergänzen.
  - [public/js/editor/notebook/edit.js](../../public/js/editor/notebook/edit.js) bzw. das Notebook-Edit-Partial — Impuls-Banner einhängen (Gate + `x-text`).
  - [public/js/i18n/de.json](../../public/js/i18n/de.json), [public/js/i18n/en.json](../../public/js/i18n/en.json) — `diary.impulse.*` (+ optional `diary.impulseLabel`).
  - `public/css/editor/notebook/` (bestehende Datei oder neue `diary-impulse.css`) — Banner-Style + Mobile-Breakpoint.
  - [public/sw.js](../../public/sw.js) — SHELL_CACHE bumpen.
  - [public/index.html](../../public/index.html) + DESIGN.md — nur falls neue CSS-Datei.
- **Create:**
  - ggf. `public/css/editor/notebook/diary-impulse.css` (sonst keine neuen Dateien).

## Offene Fragen

- **Anzeige-Ort des Impuls-Banners:** als Placeholder *innerhalb* der leeren `.page-content-view` (CSS `:empty`-artig, verschwindet bei Text) oder als separates Banner *über* dem Editor-Body? Ersteres ist näher am „Starthilfe im leeren Eintrag", braucht aber saubere Leer-Erkennung (`<p></p>` mit data-bid).
- **Pool-Größe und konkrete Impuls-Texte:** Anzahl (12? 20?) und Wortlaut der Anstöße müssen vom Product/User festgelegt werden (Ton: reflexiv vs. konkret, du-Form bestätigt?).
- **Sichtbarkeit bei wieder-geöffnetem leerem Eintrag:** Impuls immer zeigen (aktuelle Annahme) oder nur beim allerersten Öffnen am Anlege-Tag? Ohne persistierten Zustand ist „immer bei Leere" die einfache Variante — bestätigen.
- **Soll der „Heute eintragen"-Button zusätzlich an einem zweiten, prominenteren Ort erscheinen** (z. B. Buch-Overview-Hero für Tagebuch-Bücher), oder reicht die Kalender-Sidebar? Aktuell nur Sidebar.
- **Feature-Flag nötig?** Impuls-Gate self-contained — Flag (`FEATURE_DIARY_IMPULSE`) nur falls graduelles Rollout gewünscht.
