# DESIGN.md — UI-Pattern-Katalog

**Verbindlich.** Vor dem Hinzufügen neuer UI-Komponenten zuerst hier nachschlagen, ob das Pattern bereits existiert. Wiederverwenden statt neu erfinden. Neue Patterns werden in dieser Datei dokumentiert; ohne Eintrag hier kein neues UI-Element-Vokabular.

Token-Referenz (Farben, Radien, Spacing, Schriftgrössen): [public/css/tokens.css](public/css/tokens.css).

## Inhalt

**Grundlagen**
- [Doku-Template](#doku-template-pflicht-für-neue-sections) — Pflicht-Aufbau pro Section
- [Token-Pflicht](#token-pflicht-keine-ad-hoc-werte) — Schatten, Padding, Spacing, Transition, Opacity, Z-Index
- [Mikro-Typografie](#mikro-typografie-memory-regeln) — Doppelpunkt, Zahlen, Icons, Konsistenz
- [Mobile-Breakpoints](#mobile-breakpoints) — 480/600/768/1024
- [Container-Queries vs. Media-Queries](#container-queries-vs-media-queries)
- [Print-Styles](#print-styles) — nicht supported

**Komponenten**
- [Karten](#karten-card) — `.card` + Akzentfarben
- [Buttons](#buttons) — Hierarchie, Counter
- [Icon-System](#icon-system-lucide-sprite) — `<svg class="icon"><use href="/icons.svg#name"/></svg>` (Lucide-Sprite)
- [Icon-Toolbar](#icon-toolbar-graph-tool-btn) — Zoom/Reset/Fullscreen-Cluster über Canvas-Viewports
- [Toolbar-Action-Group](#toolbar-action-group-segmentierter-icon-cluster-neben-form-feldern) — segmentierte Icon-Reihe bündig mit Search/Combobox
- [Badges & Tags](#badges--tags) — eckig, Severity, Hue-Palette
- [Combobox](#combobox-auswahlfeld) — ersetzt `<select>`
- [Tabs / Modus-Toggle](#tabs--modus-toggle) — `.tabs` + `.tabs-btn`
- [Form-Patterns](#form-patterns-settings--und-export-karten) — `.card-form-grid` + Wertspalten
- [Progress-Bar](#progress-bar) — `--progress` Custom-Prop
- [Entity-List](#entity-list-listendarstellung) — Listen mit Detail-Drawer
- [Filter-Bar](#filter-bar-listenfilter) — Such-/Sort-Eingaben
- [Heatmap-Visualisierung](#heatmap-visualisierung) — Daten-Intensität
- [History-Item-List](#history-item-list-versionierung-job-verlauf) — Versionen + Job-Verlauf
- [Tree](#tree-sidebar-navigation) — Buch/Kapitel/Seiten-Navigation
- [Skeleton-Loader](#skeleton-loader) — Shimmer beim Laden
- [Klappbarer Section-Toggle](#klappbarer-section-toggle-accordion) — Accordion via `.collapsible-toggle`
- [Card-Status](#card-status--loading--empty--error) — Loading/Empty/Error
- [Chevron-Konventionen](#chevron-konventionen) — `›` 90°, `▾` 180°

**Layout & Navigation**
- [Layout](#layout) — Sidebar + Main, Row-Utility
- [Layout-Pattern: List-Header](#layout-pattern-list-header-list-header)
- [Heading-Hierarchie](#heading-hierarchie-in-karten) — `.card-title`/`.section-heading*`
- [Save-Indicator](#save-indicator)
- [Header-Actions](#header-actions)
- [Avatar-Menu](#avatar-menu)
- [Command-Palette](#command-palette) — Cmd/Ctrl+K
- [Routing / Deep-Links](#routing--deep-links-url-pflicht) — Hash-URL pro Feature Pflicht
- [Book-Overview-Tiles](#book-overview-tiles) — Default-Home-Grid

**Editor**
- [Editor](#editor) — Findings, Page-View, Focus, Edit-Bubble, Find-Replace, Lookup

**Overlays**
- [Confirm-Dialog](#confirm-dialog-modal)
- [Modal-Wrapper](#modal-wrapper-generisches-pattern) — Status: noch nicht konsolidiert
- [Sofort-Tooltip (`data-tip`)](#sofort-tooltip-data-tip--default-variante)
- [Keyboard-Shortcut (`<kbd>`)](#keyboard-shortcut-anzeige-kbd)
- [Loading-Overlay](#loading-overlay) — Status: kein generisches Pattern
- [Empty-State mit CTA](#empty-state-mit-cta) — Status: kein generisches Pattern
- [Inline-Action-Group](#inline-action-group) — Status: kein Standard
- [Drawer / Side-Panel](#drawer--side-panel) — noch kein generisches Pattern
- [Toast/Snackbar](#toastsnackbar) — noch kein generisches Pattern

**Querschnitt**
- [Z-Index-Stack](#z-index-stack)
- [Relative z-index](#relative-z-index-lokal-stack-werte) — lokal-stack-Werte
- [Reduced-Motion (Pflicht)](#reduced-motion-pflicht)
- [Severity-Vokabular](#severity-vokabular-mapping)
- [Accessibility (A11y)](#accessibility-a11y)
- [Naming-Konventionen](#naming-konventionen)
- [CSS-File-Inventar](#css-file-inventar)
- [Pattern-Matrix](#pattern-matrix-karte--pattern)
- [Tooling: stylelint-Skizze](#tooling-stylelint-skizze)
- [Wartung](#wartung) — Checkliste für neue Patterns

---

## Doku-Template (Pflicht für neue Sections)

Jede Pattern-Section folgt diesem Aufbau. Sub-Items sind optional, aber Reihenfolge ist fix — sonst sind ähnliche Sections nicht querlesbar.

```markdown
## <Pattern-Name>

**Use:** Ein Satz, was es ist und wann es greift.

**Markup:** (optional, wenn nicht-trivial)
\`\`\`html
<div class="…">…</div>
\`\`\`

**Klassen** [link/zur/css.css](path):
- `.foo` — Zweck
- `.foo--variant` — Modifier-Zweck

**Regeln:** (optional, wenn Anti-Patterns oder harte Constraints)
- …

**Beispiele:** [partial.html](path), [andere-partial.html](path)
```

Pflicht-Reihenfolge: **Use → Markup → Klassen → Regeln → Beispiele**. Wer eine Section anlegt ohne `**Use:**`-Zeile, lässt einen Pattern-Eintrag ohne Daseinsberechtigung im Katalog.

## Token-Pflicht (keine ad-hoc-Werte)

Wiederkehrende Werte gehen über Tokens. Ad-hoc-Werte (`box-shadow: 0 4px 12px ...`, `padding: 7px 10px`, `opacity: 0.5`) nur, wenn keine Token-Variante passt.

| Bereich | Tokens | Verwendung |
|---------|--------|------------|
| **Schatten** | `--shadow-sm` (Card-Lift), `--shadow-md` (Popover/Dropdown), `--shadow-lg` (Modal), `--shadow-inset-top` (Job-Queue-Footer) | Drei Erhebungs-Stufen + Inset. Dark-Theme erbt automatisch dunklere Schatten. |
| **Padding** | `--pad-btn-compact` (7px 10px), `--pad-badge` (4px 8px), `--pad-detail` (0.5rem 0.75rem) | Compact-Buttons, Badges/Tags, Detail-Boxen / Drawer-Inhalt. |
| **Spacing** | `--space-xs` (4px), `--space-sm` (8px), `--space-md` (12px), `--space-lg` (16px), `--space-xl` (24px), `--space-2xl` (32px) | Margins, Gaps, Row-Gaps. 4-Pixel-Raster. Ad-hoc Pixel nur bei wirklich nicht-passendem Token. |
| **Transition** | `--transition-fast` (0.1s), `--transition-base` (0.12s), `--transition-slow` (0.15s), `--transition-emphasized` (0.3s) | Standard-Cadence. Emphasized für Modal/Drawer-Slides, Card-Eingang, längere Fades. **NIE als `--x: var(--x)` definieren** — zirkuläre Custom-Property ist invalid → ganze `transition`/`animation`-Property kippt auf Default `0s` → Chevron-Rotationen, `cardFadeIn`, Hover-Tints sind tot, Erweiterungen „wackeln" weil Section snappt ohne Chevron-Maskierung. Definitionen müssen Literalwerte tragen, [public/css/tokens/motion.css](public/css/tokens/motion.css). `prefers-reduced-motion: reduce` flippt alle Transition-Tokens auf `0s` (globaler Override in derselben Datei). |
| **Opacity** | `--opacity-disabled` (0.6), `--opacity-muted` (0.5), `--opacity-hint` (0.4), `--opacity-faint` (0.35), `--opacity-strong` (0.75) | Semantische Stufen. `:disabled` immer `--opacity-disabled`. |
| **Focus-Ring** | — | Kein wildcard-`:focus-visible`-Token. Browser-Default-Outline aktiv; per-Element-Fokus-Styles für Tab-Navigation in [base.css](public/css/layout/base.css) (Skip-Link, `.page-item`, `.tree-chapter-header`, `.lektorat-split-findings .finding`). Komponenten mit eigenem Fokus-Signal setzen `outline: none` ohne `!important`. |
| **Font-Size** | `--font-size-xs` (11px), `--font-size-sm` (13px), `--font-size-base` (14px), `--font-size-md` (15px), `--font-size-lg` (18px), `--font-size-xl` (22px), `--font-size-2xl` (26px) | xs/sm/base/md = UI-Stufen. lg = Sub-Heading. xl = Card-Title-Standard. 2xl = Hero/H1. |
| **Font-Family** | `--font-sans` (Inter), `--font-serif` (Source Serif 4) | UI immer `--font-sans`, Reading-Frame + Headings `--font-serif`. |
| **Font-Weight** | `--fw-regular` (400), `--fw-medium` (500), `--fw-semibold` (600), `--fw-bold` (700) | `font-weight: 600` → `var(--fw-semibold)`. |
| **Line-Height** | `--lh-tight` (1.2), `--lh-base` (1.45), `--lh-relaxed` (1.6) | Headings/UI tight, Standard base, Reading-Frame relaxed. |
| **Border-Width** | `--border-thin` (0.5px), `--border` (1px), `--border-thick` (2px) | Trenner / Standard-Rand / Akzentband. |
| **Radius** | `--radius-sm` (0, hart — Badges/Tags/Pills), `--radius-md` (2px — Cards, Inputs, Buttons), `--radius-lg` (4px — Modal, Drawer, Tooltip, Confirm-Dialog) | Editorial-Eckig bleibt Leitmotiv (Listen-Elemente hart auf 0), grössere Flächen leicht weichgespült. Nicht zu ad-hoc Pixel-Radius greifen. |
| **Text-Farben** | `--color-text`, `--color-muted`, `--color-subtle`, `--color-faint` | Vier Stufen vom prägnantesten zum dezentesten — Body / sekundär / tertiär / fast unsichtbar. Inverse für dauerhaft dunkle Flächen: `--color-text-inverse`, `--color-text-inverse-muted`. |
| **Z-Index** | `--z-base` (1), `--z-sticky` (100), `--z-header` (200), `--z-popover` (1000), `--z-toolbar` (1100), `--z-overlay` (2000), `--z-banner` (10000), `--z-modal` (9500), `--z-modal-front` (11000), `--z-toast` (12000) | Stapel-Reihenfolge — siehe Section „Z-Index-Stack" unten. |

---

## Klappbarer Section-Toggle (Accordion)

**Use:** Sekundärer Inhalt in einer Karte, der per Default zu sein soll (Legenden, Zusammenfassungen, Details).

**Markup:**
```html
<div class="collapsible-wrap">
  <button type="button"
          class="collapsible-toggle"
          @click="xxxOpen = !xxxOpen"
          :aria-expanded="xxxOpen">
    <span class="history-chevron" :class="{ open: xxxOpen }">›</span>
    <span x-text="$app.t('bereich.toggle')"></span>
  </button>
  <div x-show="xxxOpen" x-cloak class="collapsible-section">…Inhalt…</div>
</div>
```

`.collapsible-wrap` (block-Container, Spacing pro Section) + `.collapsible-section` (border-left, padding, Inhaltsabstand) leben beide in [public/css/entities/entity-list.css](public/css/entities/entity-list.css).

**Regeln:**
- Chevron `›` rotiert via `.history-chevron.open` (90°). CSS in [public/css/page/tree-history.css](public/css/page/tree-history.css).
- Button-Stil `.collapsible-toggle` (uppercase, kleinere Schrift, `inline-flex`). CSS in [public/css/entities/entity-list.css](public/css/entities/entity-list.css).
- State (`xxxOpen`) lebt in der Sub-Komponente, nicht im Root.
- Kein `<details>`/`<summary>` — nicht stylebar genug, andere optische Sprache.
- **Toggle-Button NICHT lokal auf `display: flex; width: 100%` umstellen.** Hat in der Vergangenheit horizontalen Wackel-Shift beim Öffnen verursacht (PDF-Export-Karte). Block-Stapelung kommt vom `.collapsible-wrap`-Container, nicht vom Button selbst.
- **„Wackelt beim Öffnen"-Symptom** = Chevron-Rotation läuft nicht ODER Toggle ist auf full-width gestreckt. Beides geprüft? Section snappt instant auf, ohne dass die `transform: rotate(90deg)`-Transition den Snap visuell trägt → der Sprung wirkt grob. Ursache 1 (vertikal): `--transition-slow` ist invalid (z.B. zirkuläre Definition) → in DevTools auf `0.15s ease` prüfen, Token reparieren reicht für die ganze Karte. Ursache 2 (horizontal nach rechts): Toggle ist `display: flex; width: 100%` und ändert beim Klick die Layout-Box → Default `inline-flex` zurücksetzen, in `.collapsible-wrap` einwickeln.

**Beispiele:** Kontinuitäts-Zusammenfassung [public/partials/kontinuitaet.html:38](public/partials/kontinuitaet.html#L38), Figuren-Legende [public/partials/figuren.html:37](public/partials/figuren.html#L37).

---

## Karten (`.card`)

**Use:** Hauptansicht im Buchscope (Figuren, Orte, Szenen, …).

**Regeln:**
- Wurzel `<div class="card card--<key>" x-data="xxxCard" x-show="$app.showXxxCard" x-cloak>`. **`card--<key>` Pflicht** — auch wenn die Karte den Akzent (noch) nicht visuell nutzt, hängt die `--card-accent`-Custom-Property dran und steht für künftige Anchor-Bar/Title-Underline/Severity-Marker bereit.
- **Animation: nur CSS (`cardFadeIn` aus [public/css/components/card-form.css](public/css/components/card-form.css)).** Kein `x-transition` auf `.card` — translateY × scale konkurriert sichtbar bei grossen Karten (Szenen, Figuren), wirkt wabbelig. Neues Karten-Element nur `x-show="…" x-cloak`.
- Header: `.card-header` mit `.card-header--subline` für Buchtitel + Timestamp.
- Status-Hinweis: `.card-status` (Loading/Empty), `.card-status--error` für Fehler.
- Empty-State: `<div x-show="…" class="card-status" x-text="$app.t('common.noDataYet')"></div>`.

**Akzentfarbe pro Karte (Single-Source-of-Truth):**
- Hue-Tokens in [tokens/colors.css](public/css/tokens/colors.css) als `--card-accent-<key>` für alle Karten definiert (Light + Dark spiegelt).
- Mapping `.card--<key> { --card-accent: var(--card-accent-<key>); }` zentral in [public/css/card-accents.css](public/css/card-accents.css).
- Neue Karte: Hue in `tokens/colors.css` ergänzen (Light + Dark), Mapping in `card-accents.css`, Klasse `card--<key>` am Wurzel-Div setzen. Pro-Karten-CSS-Datei nur noch konsumieren (`background: var(--card-accent)`), nicht selbst deklarieren.

---

## Combobox (Auswahlfeld)

**Use:** Jedes Auswahlfeld. Ersetzt natives `<select>`.

**Markup + Pflicht-Attribute** stehen in [CLAUDE.md](CLAUDE.md) (harte Regel „Combobox statt `<select>`"), weil Architektur (`x-data="combobox(...)"`, `x-modelable`, `x-effect`-Datenfluss) primär Alpine-Verhalten ist.

**Hier (visuelles):**

**Grösse muss mit umliegenden Form-Elementen matchen** — Combobox in Zeile mit `<input>`/`<button>` MUSS dieselbe Geometrie haben. Helper ist per Default **compact**; neben default-Input/Button → Object-Form `combobox({ placeholder, compact: false })`. Details + Compact-/Default-Sets siehe [Regel: Gleiche Höhe pro Form-Zeile](#regel-gleiche-höhe-pro-form-zeile).

**Klassen** ([public/css/components/card-form.css](public/css/components/card-form.css)):
- `.combobox-wrap` — Wrapper, vom Helper auto-gesetzt (mit `--compact` per Default).
- `.combobox-trigger` — Button-Look (gleiche Höhe wie `<input>` über `--size-default-padding-y`).
- `.combobox-chevron` — Disclosure-Marker `▾`, rotiert via `.combobox-chevron--open` 0°→180°.
- `.combobox-dropdown` — Popover-Liste (mit `--up`-Modifier wenn nach oben aufklappt).
- `.combobox-search` — Input innerhalb Dropdown.
- `.combobox-option` / `.combobox-option--active` / `.combobox-empty`.

**Regel:** Wrapper-Div leer lassen (Helper überschreibt `innerHTML`). Pflicht-Pattern: `x-data="combobox(placeholder, emptyLabel?)" x-modelable="value" x-model="ref" x-effect="options = …"`.

### Dropdown darf nicht geclippt werden

`.combobox-dropdown` ist `position: absolute` innerhalb `.combobox-wrap`. Jeder Vorfahr mit `overflow: hidden`/`clip`/`auto`/`scroll` clipt das geöffnete Dropdown — Liste unsichtbar, Bug unauffällig (Trigger reagiert normal, nur Optionen weg).

**Regel:** Container, die eine Combobox umschliessen, dürfen **kein** `overflow: hidden`/`clip`/`auto`/`scroll` haben. Wenn runde Ecken einen Hintergrund clippen müssen (klassischer Use-Case für `overflow: hidden` am Card-/Section-Wrapper), stattdessen den **inneren** Hintergrund-Container (Header, Liste) mit passendem `border-radius` versehen — nicht den Aussen-Container clippen.

Checkliste bei neuer Combobox-Platzierung:
- Vorfahren bis zur nächsten Card/Modal auf `overflow:` prüfen (DevTools: Computed → Filter „overflow").
- Falls Clipping zwingend (z. B. virtualisierte Liste), Combobox **ausserhalb** des clippenden Containers platzieren. `_decideOpenDirection` schaltet zwar bei wenig Platz unten auf `--up`, das hilft aber nicht, wenn der clippende Vorfahr beide Richtungen abschneidet.
- `transform`/`filter`/`will-change`/`contain` auf Vorfahren erzeugen einen Containing-Block — heute irrelevant (Dropdown ist absolute), wird relevant falls auf `position: fixed` umgestellt wird.

Bekannte Stolperstellen, die diese Regel verletzten und gefixt wurden: `.organizer-chapter` (Buchorganizer-Kapitel-Karten mit Move-Combobox pro Page).

### Mobile + lange Labels (Viewport-Overflow)

`.combobox-wrap--compact .combobox-dropdown` setzt `right: auto; min-width: 180px;` (Desktop-Default, damit kleine Trigger trotzdem brauchbares Popover bekommen) und `.combobox-option { white-space: nowrap }`. Auf Mobile mit langen Option-Labels (Kapitel-/Figur-/Ort-/Szenen-Namen) bläst die Liste sich auf Content-Breite auf und schiebt den Dropdown über den rechten Viewport-Rand → Horizontal-Scroll.

**Global gelöst** in [public/css/components/card-form.css](public/css/components/card-form.css) (Combobox-Block, `@media (max-width: 600px)`):

- `.combobox-dropdown { max-width: calc(100vw - 16px) }` — Hard Cap gegen Viewport.
- `.combobox-wrap--compact .combobox-dropdown { left:0; right:0; min-width:0; max-width:100% }` — Dropdown bindet an Wrap-Breite, kein 180px-Minimum mehr.
- `.combobox-option { white-space: normal; overflow-wrap: anywhere }` — lange Labels wrappen statt zu überlaufen.

**Regel:** Keine per-Karte Mobile-Override mehr für Dropdown-Breite / Option-Wrap. Wer eine compact-Combobox in einer schmalen Mobile-Spalte nutzt, bekommt das Verhalten geschenkt. Falls eine Karte _absichtlich_ ein anderes Layout will (z. B. fixe Breite), das pro-Karte begründen und im Karten-CSS überschreiben — nicht im Combobox-Default.

### Reaktivität bei Datenquelle aus Karten-Scope (häufiger „Liste leer"-Bug)

`<div x-data="combobox(...)">` ist eine **nested x-data** innerhalb der Karten-x-data. Methods am Karten-Scope, die in `x-effect` der Combobox aufgerufen werden und **reaktive Karten-Daten via `this.xxx` lesen**, werden nicht zuverlässig getrackt — Combobox bleibt leer, auch nachdem die Daten nachgeladen wurden. Bestätigt durch Werkstattkommentar bei [`ideenMovePickerOptions` in public/js/app.js](public/js/app.js) („x-effect der Combobox-Sub-x-data nur `$app`/Magics, nicht Karten-Methoden sieht").

**Symptom-Beispiel (PDF-Export, vor Fix):**
- Schriftart-Combobox leer (`fontFamilyOptions()` liest `this.fontList`)
- Schriftstärke-Combobox leer (`fontWeightOptions(role)` liest `this.activeProfile`/`this.fontList`)
- Clone-From-Combobox leer (`cloneOptions()` liest `this.profiles`)
- Statische Listen (Seitengröße, Spalten, Kapitelumbruch) funktionieren — keine reaktive Datenquelle.

**Etablierter Workaround in der Codebase:** [`figurenKapitelListe`](public/js/cards/figuren-card.js#L116), [`ereignisseKapitelListe`](public/js/cards/ereignisse-card.js), [`kontinuitaetKapitelListe`](public/js/kontinuitaet.js) — Datenzugriff explizit über `window.__app.xxx`, nie über `this.xxx`.

**Fix-Optionen für neuen Combobox mit reaktiver Karten-Datenquelle:**

1. **Inline-Expression in `x-effect`** (minimal-invasiv) — keine Method-Indirektion, Alpine trackt die Reads direkt im Effect-Body:
   ```html
   x-effect="options = fontList.map(f => ({ value: f.family, label: f.family }))"
   ```
   `fontList` resolved über merged-Scope an die Karte; reaktiver Read im Effect-Body wird getrackt.

2. **State an Root verschieben** — Daten + Option-Builder in einen State-Slice/Method-Spread am Root, Karte liest via `$app.xxx` / `window.__app.xxx`. Konsistent zum bestehenden Pattern (figuren, orte, ereignisse), aber invasiver.

3. **Method auf Karte, Datenzugriff via `window.__app`** — funktioniert nur, wenn die Daten am Root liegen. Nicht anwendbar, wenn der State karten-lokal sein muss.

**Default-Empfehlung:** Variante 1 für karten-lokalen State, Variante 2 wenn die Daten ohnehin global geteilt werden.

**Anti-Pattern (vermeiden):**
```html
<!-- Combobox ist nested x-data; this.xxx aus Card-Method wird nicht zuverlässig reaktiv -->
<div x-data="combobox(...)" x-effect="options = myCardOptions()"></div>
```
mit `myCardOptions() { return this.cardData.map(...); }` am Karten-Scope.

**Status PDF-Export:** Alle 12 Comboboxes in [public/partials/pdf-export.html](public/partials/pdf-export.html) verwenden Variante 1 (Inline-Expression im `x-effect`). Karten-lokaler State (`fontList`, `profiles`, `activeProfile`) wird direkt im Effect-Body gelesen; die früher vorhandenen Option-Builder-Methods sind ersatzlos entfernt.

---

## Tabs / Modus-Toggle

**Use:** Tab-Reihen mit Panels (PDF-Export) **und** Modus-Toggles mit 2-3 Optionen (Fehler-Heatmap: offen / angewendet / alle). Ein Pattern, beide Use-Cases.

**Pattern: `.tabs` / `.tabs-btn` / `.tabs-btn--active`** ([public/css/components/tabs.css](public/css/components/tabs.css)). Polished segmented: dezenter Tint statt Vollfarben-Active, 2px Akzentband am Unterkante, weiche Übergänge. Eckig.

**Markup:**
```html
<div class="tabs">
  <button class="tabs-btn" :class="{ 'tabs-btn--active': mode === 'a' }">A</button>
  <button class="tabs-btn" :class="{ 'tabs-btn--active': mode === 'b' }">B</button>
</div>
```

**Count-Badge** (optional, z.B. für Filter-Tabs): `.tabs-btn-count` als zweites Span-Kind im Button. Aktiver Tab tönt das Badge primary-getintet, disabled-Tabs dimmen es.
```html
<button class="tabs-btn" :disabled="count === 0">
  <span x-text="label"></span>
  <span class="tabs-btn-count" x-text="count"></span>
</button>
```

**Disabled-Tabs:** native `:disabled` (oder `aria-disabled="true"`) → ausgegraut, kein Hover, `cursor: not-allowed`. Pflicht-Pattern für Filter-Tabs mit leerem Bucket (kein Click ins Nichts). Beispiele: [public/partials/kontinuitaet.html](public/partials/kontinuitaet.html), [public/partials/szenen.html](public/partials/szenen.html).

**Modifier `.tabs--scrollable`** für viele Tabs in schmaler Karte (horizontaler Scroll, Mobile). Beispiel: PDF-Export-Tabs ([public/partials/pdf-export.html](public/partials/pdf-export.html)).

**Modifier `.tabs--fullwidth`** für Modus-Toggles, bei denen Buttons gleichberechtigt die volle Container-Breite teilen sollen (statt inline-flex zu Content-Breite). Beispiel: Figuren-Graph-Modus ([public/partials/figuren.html](public/partials/figuren.html)).

---

## Badges & Tags

**Eckig** (`border-radius: var(--radius-sm)` oder `0`), nie pill-förmig oder rund.

**Generische Badges** [public/css/components/buttons-badges.css](public/css/components/buttons-badges.css):
- `.badge-ok` — grün, positive Info
- `.badge-warn` — amber, Warnung
- `.badge-err` — rot, Fehler
- `.btn-count` — Counter-Badge in Buttons

**Severity-Tags** [public/css/entities/entity-list.css:143](public/css/entities/entity-list.css#L143):
- `.severity-tag--kritisch` / `--stark` / `--mittel` / `--schwach` / `--niedrig`
- Verwendet für Lektorats-/Kontinuitäts-Schweregrade.

**Hue-getriebener Badge** (`.palette-badge` in [public/css/layout/utilities.css](public/css/layout/utilities.css)):
- Basis-Pattern für alle farb-codierten Badges (Sozialschicht, Präsenz, Figurentyp).
- Konsumenten setzen lokal `--badge-hue: var(--palette-xxx);` — Hintergrund und Text werden via `color-mix()` aus Hue + Surface/Text abgeleitet (Theme-aware).
- Beispiel: `<span class="palette-badge" style="--badge-hue: var(--palette-green)">Mittelschicht</span>` oder eigene Modifier-Klassen wie `.figur-schicht-mittelschicht { --badge-hue: var(--palette-green); }`.

---

## Buttons

**Hierarchie:**
- `<button class="primary">` — Haupt-CTA pro Karte (max. einer)
- `<button class="success">` — Bestätigungsaktion
- `<button>` (default) — sekundär, transparent
- `:disabled` — Opacity 0.4, cursor not-allowed

**Counter in Button:** `<span class="btn-count">N</span>` rechts vom Label.

---

## Icon-System (Lucide-Sprite)

**Use:** Single Source of Truth für alle UI-Icons. Lucide-Icon-Set (ISC, [lucide.dev](https://lucide.dev)) als statischer SVG-Sprite. Keine Unicode-Glyphen als Icons mehr.

**Sprite:** [public/icons.svg](public/icons.svg) — `<symbol id="…" viewBox="0 0 24 24">` pro Icon. Stroke/Fill werden NICHT auf den Pfaden gesetzt; sie erben über die `.icon`-CSS-Klasse (Shadow-DOM-Cascade).

**CSS:** [public/css/components/icons.css](public/css/components/icons.css). Klasse `.icon` setzt `width/height: 1em`, `fill: none`, `stroke: currentColor`, `stroke-width: 2`, `stroke-linecap/linejoin: round`, `vertical-align: -0.125em`, `pointer-events: none`. Skaliert automatisch über `font-size` des Parents.

**Markup (statisches Icon):**
```html
<svg class="icon" aria-hidden="true">
  <use href="/icons.svg#chevron-right"/>
</svg>
```

**Markup (reaktives Icon mit Alpine):**
```html
<svg class="icon" aria-hidden="true">
  <use :href="isOpen ? '/icons.svg#chevron-up' : '/icons.svg#chevron-down'"/>
</svg>
```

Niemals `x-text` für Icon-Buttons mit zwei Zuständen — `x-text` setzt `textContent` und killt das SVG. Stattdessen `<use :href="…">` reaktiv binden, oder zwei `<template x-if>`-Branches.

**Verfügbare Icons (Stand v1, Lucide-Namen):**
- Chevrons / Arrows: `chevron-left/right/up/down`, `arrow-left/right/up/down`
- Aktionen: `check`, `x`, `plus`, `minus`, `pencil`, `trash`, `search`, `play`, `undo`, `redo`
- Status: `circle`, `alert-triangle`, `loader`
- Viewport: `maximize`, `maximize-2`, `minimize-2`, `scan`
- Editor: `separator-horizontal` (Trennlinie), `move-horizontal` (Fit-Width)

Neuer Bedarf → Lucide-SVG von [lucide.dev](https://lucide.dev) als `<symbol>` in `public/icons.svg` ergänzen + `SHELL_CACHE` in `public/sw.js` bumpen.

**Mask-Variante für CSS-Pseudo-Elements:** Wo Icons aus CSS-Pseudo gerendert werden (rotierende Disclosure-Marker, `.history-chevron`, `.card-form-saved::before`), gibt es vorgehaltene `--icon-…`-Custom-Properties in `:root` (siehe `icons.css`). Konsumiert via:
```css
.my-thing::before {
  content: '';
  display: inline-block;
  width: 1em; height: 1em;
  background-color: currentColor;
  -webkit-mask: var(--icon-chevron-right) center / contain no-repeat;
          mask: var(--icon-chevron-right) center / contain no-repeat;
}
```
Mehr Masken in `:root` ergänzen, sobald sie ein zweites Mal gebraucht werden (Lucide-Pfad als URL-encoded SVG data-URL eintragen).

**Erlaubte Unicode-Ausnahmen (keine Icons im engeren Sinn):**
- Repetitions-Indikatoren (z.B. `↑↑↑` als Intensität-Skala für Machtverhältnis in Figuren-Beziehungen) — Icons als Sequenz wären visuell muddled.
- Mathematische / typografische Zeichen im Fliesstext (`∑`, `·`, `–`) — kein Icon-Charakter.
- Fallback-Glyphen in Chevron-Spans (`›`) bleiben markup-seitig als Fallback bei CSS-disabled (visuell ausgeblendet via `text-indent: 100%`).

**Regeln:**
- **Keine Icon-Bibliothek per `<script>`** (Lucide-JS oder Heroicons via NPM-Build) — Sprite-Approach reicht, kein JS-Overhead, kein Build-Step.
- **`fill="none"` / `stroke="currentColor"` nicht auf `<symbol>` setzen** — Shadow-DOM-Vererbung greift nur, wenn die Properties am konsumierenden `<svg>` (via `.icon`-Klasse) liegen. Pfade bleiben attributfrei.
- **`aria-hidden="true"` an jedem dekorativen Icon-SVG** — bei Icon-only-Buttons immer auch `aria-label` am Button (nicht am SVG).
- **Hex-Farbe / inline-stroke**: nicht setzen. Farbe steuert das CSS-Parent über `color: …`.
- **`width: 1em`**-Default heisst: Icon-Grösse folgt Parent-`font-size`. Will man fixe 18px: `style="font-size:18px"` am SVG oder `.icon--md`.

---

## Icon-Toolbar (`.graph-tool-btn`)

**Use:** Kompakte Icon-Button-Reihe für Canvas-/Viewport-Steuerung (Zoom +/−, Reset, Fullscreen-Toggle). Genutzt von Figuren-Graph (vis-network) und Figur-Werkstatt-Mindmap (jsMind). Erste Wahl für jeden weiteren Graph/Map/Canvas-Viewer. Icons kommen aus dem [Lucide-Sprite](#icon-system-lucide-sprite).

**Markup (Overlay-Variante, oben rechts in Canvas-Ecke):**
```html
<div class="<viewer>-canvas" style="position: relative">
  <div class="…-mindmap-controls …-mindmap-controls--overlay">
    <button type="button" class="graph-tool-btn"
            :data-tip="$app.t('graph.zoomIn')" :aria-label="$app.t('graph.zoomIn')"
            @click="…zoomIn()">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#plus"/></svg>
    </button>
    <button type="button" class="graph-tool-btn"
            :data-tip="$app.t('graph.zoomOut')" :aria-label="$app.t('graph.zoomOut')"
            @click="…zoomOut()">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#minus"/></svg>
    </button>
    <button type="button" class="graph-tool-btn"
            :data-tip="$app.t('graph.reset')" :aria-label="$app.t('graph.reset')"
            @click="…fit()">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#scan"/></svg>
    </button>
    <button type="button" class="graph-tool-btn"
            :aria-pressed="fullscreen"
            :data-tip="fullscreen ? $app.t('graph.fullscreenClose') : $app.t('graph.fullscreen')"
            :aria-label="fullscreen ? $app.t('graph.fullscreenClose') : $app.t('graph.fullscreen')"
            @click="toggleFullscreen()">
      <svg class="icon" aria-hidden="true">
        <use :href="fullscreen ? '/icons.svg#minimize-2' : '/icons.svg#maximize-2'"/>
      </svg>
    </button>
  </div>
</div>
```

**Markup (Inline-Variante, unter Canvas — Legende links, Zoom-Cluster rechts):**
```html
<div class="figuren-graph-toolbar">
  <span class="card-status">…Legende…</span>
  <div class="figuren-graph-toolbar-zoom">
    <button class="graph-tool-btn"><svg class="icon"><use href="/icons.svg#plus"/></svg></button>
    …
  </div>
</div>
```

**Icon-Map (Pflicht-Vokabular pro Aktion):**

| Aktion | Lucide-Icon | Hinweis |
|--------|-------------|---------|
| Zoom in | `plus` | — |
| Zoom out | `minus` | — |
| Reset / Fit-to-View | `scan` | Vier Ecken-Klammern, viewport-semantisch |
| Fullscreen öffnen | `maximize-2` | Diagonale Pfeile auswärts |
| Fullscreen schliessen | `minimize-2` | Diagonale Pfeile einwärts |
| Undo / Redo | `undo` / `redo` | Action-Group-Variante (siehe unten) |
| Expand-all / Collapse-all | `chevron-down` / `chevron-up` | Action-Group-Variante |

Neue Aktionen erweitern diese Tabelle und das Sprite (siehe [Icon-System](#icon-system-lucide-sprite)).

**Klassen** ([public/css/tokens-est.css](public/css/tokens-est.css), Overlay-Modifier in [public/css/entities/figur-werkstatt.css](public/css/entities/figur-werkstatt.css)):
- `.graph-tool-btn` — quadratischer Icon-Button (28px min, `--radius-sm`, `--border-thin` solid `--color-border`, `--color-muted` Text, Hover-Tint via `--color-surface`). Innenliegendes `<svg.icon>` zentriert sich automatisch (`line-height: 1`).
- `.graph-tool-btn--reset` — Legacy-Override für mehrzeichige Glyphen; mit SVG-Icons nicht mehr nötig (kann beim nächsten Refactor entfernt werden).
- `.graph-tool-btn[aria-pressed="true"]` — aktiver Toggle (Fullscreen ein): `--color-history-active-bg` Hintergrund, `--color-primary` Border + Text. Greift automatisch — Konsument setzt nur `:aria-pressed`.
- `.figuren-graph-toolbar` — Inline-Wrapper: `display: flex; justify-content: space-between; gap: --space-sm`, oberhalb/unterhalb der Canvas.
- `.figuren-graph-toolbar-zoom` — Button-Cluster mit `gap: --space-xs`, `flex-shrink: 0`.
- `.<viewer>-mindmap-controls--overlay` — Overlay-Wrapper: `position: absolute; top: 8px; right: 8px`, `--color-surface` 88% mit `backdrop-filter: blur(4px)`, `--border-thin` + `--radius-sm` + `--shadow-sm`, `z-index: --z-sticky`. Parent muss `position: relative`.

**Regeln:**
- **Kein eigenes Button-Vokabular pro Viewer.** Neuer Graph/Map/Canvas → `.graph-tool-btn` wiederverwenden, ggf. eigenen Wrapper-Modifier (`--overlay` analog). Kein `.figuren-zoom-btn` o.ä. parallel anlegen.
- **Icons aus Sprite, nicht Unicode.** `<svg class="icon"><use href="/icons.svg#name"/></svg>` ist Pflicht. Unicode-Glyphen (`+`, `−`, `⤢`, `⛶`, `✕`) im Button-Markup sind seit Lucide-Migration verboten — Icon-Map oben ist der Index.
- **Toggle-Icons via `<use :href="…">`** (reaktiv), nicht via `x-text` — `x-text` ersetzt den SVG-Inhalt.
- **Tooltip Pflicht** über `data-tip` (sofort-Hover, siehe [Sofort-Tooltip](#sofort-tooltip-data-tip--default-variante)), `aria-label` zusätzlich für Screen-Reader.
- **Overlay-Position** nicht ohne Grund verschieben — oben-rechts ist konsistent über Figuren-Graph (Inline) + Werkstatt (Overlay).
- **Klassen-Präfix** weiterhin `graph-tool-btn` — nicht in `toolbar-btn` o.ä. umbenennen; Pattern teilt sich Vokabular über mehrere Features.

**Beispiele:** [public/partials/figuren.html:86-100](public/partials/figuren.html#L86), [public/partials/figur-werkstatt.html:210-233](public/partials/figur-werkstatt.html#L210).

---

## Toolbar-Action-Group (segmentierter Icon-Cluster neben Form-Feldern)

**Use:** Reihe von 2–5 Icon-Aktionen, **vertikal exakt mit Suchfeld + Combobox in derselben Toolbar bündig**. Eingesetzt im Buchorganizer (Undo/Redo/Expand-all/Collapse-all neben Such-Input + Sprung-Combobox) und in der Sidebar (Expand-all/Collapse-all neben Page-Search). Unterscheidet sich vom Canvas-Pattern oben dadurch, dass die Buttons **als Segment** zusammenstehen (geteilte Border, gerundete Aussenseiten) und an die Höhe ihrer Toolbar-Nachbarn gekoppelt sind.

**Markup:** (Icons aus [Lucide-Sprite](#icon-system-lucide-sprite))
```html
<div class="<feature>-toolbar">
  <input type="text" class="page-search" x-model="search" :placeholder="…">
  <div class="btn-group <feature>-action-group">
    <button type="button" class="graph-tool-btn <feature>-icon-btn"
            @click="undo()" :data-tip="…" :aria-label="…">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#undo"/></svg>
    </button>
    <button type="button" class="graph-tool-btn <feature>-icon-btn"
            @click="redo()" :data-tip="…" :aria-label="…">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#redo"/></svg>
    </button>
    <button type="button" class="graph-tool-btn <feature>-icon-btn"
            @click="expandAll()" :data-tip="…" :aria-label="…">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#chevron-down"/></svg>
    </button>
    <button type="button" class="graph-tool-btn <feature>-icon-btn"
            @click="collapseAll()" :data-tip="…" :aria-label="…">
      <svg class="icon" aria-hidden="true"><use href="/icons.svg#chevron-up"/></svg>
    </button>
  </div>
  <div class="<feature>-jump"
       x-data="combobox($app.t('…'))" x-modelable="value" x-model="jumpId"
       x-effect="options = …" @combobox-change="…"></div>
</div>
```

**CSS (Beispiel aus [public/css/book/buchorganizer.css](public/css/book/buchorganizer.css)):**
```css
.<feature>-toolbar {
  display: flex;
  align-items: stretch;          /* Pflicht — sonst stretcht Action-Group nicht */
  gap: var(--space-sm);
  flex-wrap: nowrap;
}
.<feature>-toolbar .page-search {
  flex: 1 1 0; min-width: 120px;
  height: 34px; padding: 0 10px; box-sizing: border-box;
}
.<feature>-jump { flex: 0 1 220px; min-width: 140px; }
.<feature>-jump .combobox-trigger {
  height: 34px; padding-block: 0; box-sizing: border-box;
}
.<feature>-action-group {
  display: inline-flex;
  align-items: stretch;
  gap: 0;                        /* Segment-Look: keine Lücke zwischen Buttons */
  flex-shrink: 0;
}
.<feature>-action-group .graph-tool-btn {
  width: 34px; height: 34px;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 0; padding: 0;
  font-size: var(--font-size-base); /* steuert SVG-Grösse (1em im .icon) */
  line-height: 1; box-sizing: border-box;
  border-radius: 0;
}
.<feature>-action-group .graph-tool-btn:first-child {
  border-top-left-radius: var(--radius-md);
  border-bottom-left-radius: var(--radius-md);
}
.<feature>-action-group .graph-tool-btn:last-child {
  border-top-right-radius: var(--radius-md);
  border-bottom-right-radius: var(--radius-md);
}
.<feature>-action-group .graph-tool-btn + .graph-tool-btn {
  border-left-width: 0;          /* doppelte Border vermeiden */
}
```

**Regeln:**
- **Vertikal-Alignment Pflicht:** Toolbar IMMER `align-items: stretch` und Nachbar-Elemente (Input, Combobox-Trigger, Buttons) auf **gleiche fixe Höhe** (`34px`-Standard). Ohne stretch + fixe Höhe ergeben Padding-Differenzen schräge Auslinierungen — der häufigste Bug bei diesem Pattern.
- **Combobox-Trigger anpassen:** `.combobox-trigger` hat Eigenpadding via `--size-compact-padding`. In der Toolbar mit `height: 34px; padding-block: 0;` override, sonst überragt der Trigger die Action-Group. Wrapper-Div bleibt leer (Helper überschreibt `innerHTML`).
- **Segment-Style statt Gap:** Buttons rücken aneinander (`gap: 0` auf Action-Group, `border-left-width: 0` auf Folge-Buttons). Aussenseiten gerundet via `:first-child` / `:last-child`. Liest sich als zusammengehörige Gruppe. Wer Lücke statt Segment will: anderes Pattern verwenden (z.B. `card-actions`).
- **Icons aus Sprite, kein Glyph-Wrapper mehr.** `<svg class="icon"><use href="/icons.svg#name"/></svg>` direkt im Button. `.icon` (1em-Quadrat) zentriert sich via Button-Flex automatisch — keine `font-size: 0`-Tricks, kein `<span class="…-icon">`-Wrapper, keine Font-Metrik-Wackelei. Icon-Map siehe [Icon-Toolbar](#icon-toolbar-graph-tool-btn).
- **Disabled-State** via `:disabled` (z.B. Undo bei leerem Stack). Greift automatisch durch `.graph-tool-btn`-Default-Styling.
- **Mobile:** Im `@media (max-width: 600px)`-Block Toolbar zu `flex-direction: column; align-items: stretch` drehen; Search + Combobox auf `width: 100%`. Action-Group bleibt horizontal (segmentierte Reihe), nimmt eigene Zeile ein.

**Beispiele:** [public/partials/buchorganizer.html:16-50](public/partials/buchorganizer.html#L16) (4 Buttons + Search + Combobox), [public/partials/sidebar.html:11-22](public/partials/sidebar.html#L11) (2 Buttons neben Search, kein Combobox).

---

## Form-Patterns (Settings- und Export-Karten)

**Use:** Karten mit Eingabefeldern in Label-Wert-Anordnung (book-settings, user-settings, finetune-export, …). Eine **gemeinsame** Geometrie über alle Karten — kein paralleles Klassen-Vokabular pro Karte.

### Grid (Label links, Wert rechts)

`.card-form-grid` / `.card-form-row` / `.card-form-label` (CSS in [public/css/components/card-form.css](public/css/components/card-form.css), 170 px-Label-Spalte). Modifier `.card-form-row--top` für oben-ausgerichtete Rows mit Textareas.

```html
<div class="card-form-grid">
  <div class="card-form-row">
    <label class="card-form-label" x-text="…"></label>
    <div class="form-stack">…</div>
  </div>
</div>
```

### Wertspalten-Bausteine (CSS in [public/css/components/card-form.css](public/css/components/card-form.css))

| Klasse | Verwendung |
|--------|------------|
| `.form-stack` | flex-column gap 10 — vertikale Liste (mehrere Checks oder Sub-Gruppen) |
| `.form-inline` | flex-row gap 20 wrap — Inline-Felder nebeneinander (z.B. Min/Max) |
| `.form-inline-field` | Wrapper aus Label + Input (`<label><span/><input/></label>`) |
| `.form-num` | numerischer Input, 90 px breit, kompakt — paart mit `.form-inline-field` |
| `.form-check` | Grid 18 px-Checkbox + Title-Desc-Stack |
| `.form-check-title` | bold Titel der Check-Option |
| `.form-check-desc` | mittlerer Erklaerungstext (12 px, muted) |
| `.form-lead` | Intro-Paragraph unter `.card-header`, oberhalb der Form |
| `.form-section` | Wrapper unter dem Form-Output (Trennstrich + 14 px Abstand) |
| `.form-stats` | flex-wrap gap 8 — Reihe aus `.tok-badge`-Stats |
| `.form-size-hint` | sekundärer Inline-Hinweis im Button (z.B. Dateigröße) |

### Section-Trenner innerhalb des Forms

`.card-form-section-divider` — `<p>`-Tag mit Border-Top + erklärendem Text, trennt logische Form-Sektionen (Beispiel: AI-Augmentierung in finetune-export).

### Hint / Error / Saved unterhalb der Form

`.card-form-hint` (12 px, muted, italic), `.card-form-error` (rot), `.card-form-saved` (success — ✓-Prefix via `::before`, fade via `x-transition.opacity.duration.250ms`, Auto-Dismiss 2500 ms via `_savedAtTimer` in der Karte).

### Validation-State auf Inputs (Pflicht bei Fehler)

Inputs mit Fehler bekommen `aria-invalid="true"` + `aria-describedby="<error-id>"`. Visuell rote Border via `[aria-invalid="true"]`-Selektor in [card-form.css](public/css/components/card-form.css). Kein eigener `.form-input--invalid`-State daneben — `aria-invalid` ist Pflicht-Attribut, der Selektor leitet daraus die Optik ab.

```html
<input id="bs-foo" :aria-invalid="!!fooError" aria-describedby="bs-foo-err">
<p class="card-form-error" id="bs-foo-err" x-show="fooError" x-text="fooError"></p>
```

Pure-CSS-Border ohne `aria-invalid` ist Anti-Pattern — Screen-Reader liest sonst nichts, nur die Sehenden bekommen Feedback.

### Textarea / Field-Note

`.card-form-textarea` (volle Breite, vertikal resizable) für mehrzeilige Inputs. `.card-form-field` ist Spalten-Stack (Input + Note darunter), `.card-form-field-note` ist 12 px-Erklärtext unter dem Input.

### Mobile (≤ 600 px)

Grid kollabiert auf 1 Spalte (in card-form.css). `.form-inline` reflowed auf 50/50 (`flex 1 1 calc(50% - 16px)`); `.form-num` wird flex-fluid.

### Regel: Gleiche Höhe pro Form-Zeile

In einer Form-Zeile (Inputs, Comboboxes, Buttons nebeneinander in Flex/Grid mit `align-items: center`/`stretch`) müssen alle Elemente dieselbe Geometrie haben — **entweder alle default oder alle compact**, kein Mix.

- Default-Set: `<input>`, `<button>` (ohne `.btn-compact`), `combobox({ compact: false })` → alle nutzen `--size-default-padding-y` (8px) + `--font-size-base` (14px).
- Compact-Set: `.btn-compact`, default-`combobox(...)` (Helper setzt `--compact` auto), Compact-Input (eigene Klasse mit `--size-compact-padding`/`--size-compact-font-size`) → alle nutzen `--size-compact-padding` (4px y) + `--size-compact-font-size` (12px).

Stolperfalle: `combobox(placeholder)` ist **default compact**. Steht der combobox neben einem nackten `<input>` oder `<button>` ohne `.btn-compact`, sieht das ungleich aus → Object-Form `combobox({ placeholder, compact: false })` verwenden. Umgekehrt: wenn die Zeile sonst nur Compact-Elemente hat (Filter-Bars, Table-Row-Controls), bleibt der Default-Compact-Combobox richtig.

Filter-Bars (`.filter-bar`, `.admin-usage-filter`, `.admin-users-requests-filter`) sind bewusst rein compact (Search-Input + Compact-Combobox + Compact-Buttons) — kein Mix zulässig.

### Regel: Forms folgen der UI-Locale

Alle Form-Inputs (Datums-/Zeit-Picker, Zahlen, Auswahllisten, Platzhalter, Hint-/Error-/Saved-Texte, Validation-Messages, Format-Beispiele) richten sich nach der aktiven UI-Locale (`this.uiLocale`), **nicht** nach Browser-Default oder Buchsprache.

- **Labels, Placeholder, Hints, Optionen:** ausschliesslich via `t('bereich.feld')` / `tRaw()` (siehe Harte Regel „UI-Strings nur in `public/js/i18n/{de,en}.json`"). Kein hartcodiertes DE/EN-Markup in Partials.
- **Zahlen, Datum, Zeit:** `Intl.NumberFormat` / `Intl.DateTimeFormat` mit Locale-Tag aus `this.uiLocale` (DE → `de-CH`, EN → `en-CH`/`en-US` je nach `defaultRegion`). DE-CH: Dezimal `.`, Tausender `’`; EN-US: Dezimal `.`, Tausender `,`. Nie statisch `'de-DE'` o.ä. setzen.
- **Inputs mit nativer Lokalisierung** (`<input type="number|date|time">`): erben das `lang`-Attribut vom `<html lang>`-Sync (gesetzt in [public/js/i18n.js](public/js/i18n.js) bei Locale-Wechsel). **Kein** eigenes `lang=`-Override am Input.
- **Combobox-Optionen / Sortierung:** Labels via `t()`; String-Sort `localeCompare(b, this.uiLocale)`.
- **Format-Helper** (`formatLastRun`, Schweizer-Zahlen-Util, …) bekommen `this.uiLocale` als Parameter, lesen ihn nicht aus globaler Konstante.
- **Buchsprache ≠ UI-Locale:** Buchinhalt kann DE sein, während UI auf EN läuft. Form-Chrome folgt UI, nicht Inhalt.

Reaktivität: `t()` referenziert `this.uiLocale` (siehe [public/js/i18n.js](public/js/i18n.js)), Alpine re-rendert bei Locale-Wechsel automatisch. Eigene Format-Methoden müssen `void this.uiLocale;` als Reaktivitäts-Anker enthalten, sonst frieren formatierte Werte bei Sprachwechsel ein.

### Regel: Keine parallele Reinvention

Wer eine neue Settings-/Export-Karte baut, nutzt diese Klassen direkt (siehe [public/partials/user-settings.html](public/partials/user-settings.html), [public/partials/finetune-export.html](public/partials/finetune-export.html)). Kein eigenes `.xxx-form` / `.xxx-row` / `.xxx-check` mehr. Verstößt gegen die Style-Konsistenz-Regel oben.

---

## Progress-Bar

**Markup:**
```html
<div class="progress-bar-wrap">
  <div class="progress-bar" :style="{ '--progress': xProgress + '%' }"></div>
</div>
```

**Regel (CLAUDE.md):** Breite kommt aus CSS-Custom-Prop `--progress`. Niemals `:style="'width:' + … + '%'"`.

---

## Entity-List (Listendarstellung)

**Use:** Tabellarische Listen mit Klick → Detail (Figuren, Orte, Szenen, Findings, …).

**Klassen:**
- `.entity-list` — Container
- `.entity-list--accented` — mit linkem Akzentstreifen
- `.entity-row` / `.entity-row--selected` — Zeile
- `.entity-row-title` / `.entity-row-meta`
- `.entity-meta-row` / `.entity-meta-label` / `.entity-meta-value` — Detail-Box

CSS: [public/css/entities/entity-list.css](public/css/entities/entity-list.css). Wiederverwendbar für jede neue Listen-Karte; nicht selbst neu bauen.

---

## Table-Scroll (`.table-scroll`)

**Use:** Wrapper um breite Tabellen, damit sie auf engen Viewports horizontal scrollen statt aus der Karte zu ragen. Pflicht für mehrspaltige Admin-/Listen-Tables.

**Markup:**
```html
<div class="table-scroll" x-show="rows.length">
  <table class="admin-users-table">…</table>
</div>
```

CSS: [public/css/layout/utilities.css](public/css/layout/utilities.css). `overflow-x: auto` + `max-width: 100%` am Wrapper; `min-width: 100%` an der Table.

---

## Card-Status / Loading / Empty / Error

| Zustand        | Klasse               | Inhalt |
|----------------|----------------------|--------|
| Loading        | `.card-status`       | i18n-Status + optional `.progress-bar-wrap` darüber |
| Empty          | `.card-status`       | `$app.t('common.noDataYet')` |
| Error          | `.card-status--error`| Fehlermeldung als i18n-Key |

Niemals reine `<div>`s mit Inline-Text dafür — immer durch `.card-status*`-Klassen.

---

## Chevron-Konventionen

| Pattern | Glyph (Fallback) | Lucide-Icon | Rotation |
|---------|------------------|-------------|----------|
| Collapsible-Toggle (`.history-chevron`) | `›` | `chevron-right` (gerendert via `mask: var(--icon-chevron-right)`) | 0° → 90° (Klasse `.open`) |
| Combobox-Trigger (`.combobox-chevron`) | `▾` | (noch Unicode-Glyph; auf `chevron-down`-Mask migrieren, sobald Touch) | 0° → 180° (Klasse `--open`) |
| Disclosure (sonstig) | nicht erfinden — vorhandenes Muster nehmen |

Markup-Fallback-Glyph (`›`) bleibt im DOM, wird per `text-indent: 100%; overflow: hidden` versteckt. Schadlos bei deaktiviertem CSS, kein Screen-Reader-Lärm (Konsumenten setzen `aria-hidden="true"` am Chevron-Span).

Kein neuer Marker ohne Eintrag hier.

---

## Mikro-Typografie (Memory-Regeln)

- **Doppelpunkt als Funktion-Separator:** `Funktion: Target` mit `:`. Nicht `·` (das ist Listen-Trenner für gleichwertige Items).
- **Schweizer Zahlen:** Dezimal `.`, Tausender `’` (Apostroph). Locale-Tag `de-CH`.
- **Keine Icons/Emojis** ohne ausdrückliche Aufforderung. Disclosure-Marker (Chevron) zählen nicht als Icons.
- **Style-Konsistenz:** Eine Style-Entscheidung gilt für alle vergleichbaren Elemente. Wer eine Komponente neu macht, prüft, ob ähnliche bereits existieren — und passt entweder die existierenden mit an oder übernimmt deren Stil.

---

## Mobile-Breakpoints

**Pflicht:** Jede neue UI-Komponente bekommt im selben Commit Mobile-Breakpoints (`@media (max-width: 600px)`). Nie auf später verschieben.

**Standard-Set** (CSS-Custom-Properties funktionieren in `@media` nicht — diese vier Werte ausschliesslich verwenden):
- `480px` — Phone-Small (sehr enge Devices, harter Reflow)
- `600px` — Phone-Large (Default-Mobile-Breakpoint)
- `768px` — Tablet
- `1024px` — Desktop-Compact

---

## Layout-Pattern: List-Header (`.list-header`)

**Use:** Header-Zeile innerhalb einer Karte oder Sektion, die Titel + Aktionen horizontal anordnet und auf Mobile auf Spalte umbricht.

**Markup:**
```html
<div class="list-header list-header--between list-header--wrap">
  <h3 class="history-heading" x-text="$app.t('bereich.title')"></h3>
  <div class="card-actions">…</div>
</div>
```

**Modifier:**
- `.list-header--between` — `justify-content: space-between`
- `.list-header--wrap` — `flex-wrap: wrap`

CSS in [public/css/layout/utilities.css](public/css/layout/utilities.css). Mobile (≤600 px) bricht automatisch auf Spalte (`flex-direction: column; align-items: flex-start`).

**Wichtig:** Bestehende Sub-Header-Klassen (`.figur-list-header`, `.figur-szene-header` etc.) haben kontextspezifische Sonderlogik (Margins, Borders, Padding) und bleiben unverändert; die Util-Klasse ist Default für **neue** Header-Zeilen.

---

## Layout

### Zwei-Spalten (Sidebar + Main)

**Use:** Haupt-Editor-Layout (Tree links, Editor mittig, optional Chat rechts).

**Klassen** [public/css/layout/twocolumn.css](public/css/layout/twocolumn.css):
- `.layout` — Grid-Container
- `.layout-sidebar` — linke Spalte mit Tree
- `.layout-main` — Hauptbereich
- `.sidebar-resize-handle` — Drag-Handle, persistiert Spaltenbreite via JS

Nur einmal verwendet — nicht neu erfinden für andere Kontexte (Karten haben eigene Modal-Logik via `_closeOtherMainCards`).

### Row-Utility

**Use:** Flexbox-Wrapper für Button-Gruppen, Input-Reihen mit responsive Stacking.

```html
<div class="row">…</div>
```

CSS: [public/css/layout/utilities.css](public/css/layout/utilities.css). Auf Mobile (`max-width: 480px`) stapelt sich der Inhalt automatisch.

---

## Confirm-Dialog (Modal)

**Use:** Destruktive Aktionen bestätigen (Löschen, Reset, Logout) **und** „Verwerfen ungespeicherter Änderungen" (Editor-Cancel, Reload einer Card mit dirty State, Page-Wechsel mit ausstehenden Edits).

**Markup:**
```html
<div class="confirm-overlay" x-show="confirmOpen" @click.self="confirmOpen = false">
  <div class="confirm-dialog">
    <div class="confirm-dialog-message" x-text="$app.t('…')"></div>
    <div class="confirm-dialog-actions">
      <button class="confirm-dialog-btn" @click="confirmOpen = false">…</button>
      <button class="confirm-dialog-btn confirm-dialog-btn--danger" @click="…">…</button>
    </div>
  </div>
</div>
```

CSS: [public/css/components/confirm-dialog.css](public/css/components/confirm-dialog.css). Varianten `--primary` und `--danger`. Niemals native `confirm()` verwenden.

**Unsaved-Changes-Pattern (Reuse, nicht parallel erfinden):** der einheitliche Discard-Dialog läuft über `appConfirm({ message, confirmLabel: t('edit.discardEdit'), danger: true })`. Beispiele: [editor/edit.js#cancelEdit](public/js/editor/edit.js), [figur-werkstatt-card.js#onCardRefresh](public/js/cards/figur-werkstatt-card.js). Pro Feature einen i18n-Key für die Frage (z. B. `edit.cancelConfirm`, `app.switchPageConfirm`, `werkstatt.confirmReload`); der Confirm-Button-Text bleibt der gemeinsame `edit.discardEdit` („Verwerfen" / „Discard").

---

## Skeleton-Loader

**Use:** Während Daten laden — verhindert CLS (Layout-Shift), zeigt Strukturhinweis.

**Entity-List** (Listen-Karten):
```html
<div class="entity-skeleton" x-show="loading">
  <template x-for="i in 5">
    <div class="entity-skeleton-row">
      <div class="entity-skeleton-cell entity-skeleton-cell--anchor"></div>
      <div class="entity-skeleton-cell entity-skeleton-cell--title"></div>
      <div class="entity-skeleton-cell entity-skeleton-cell--meta"></div>
    </div>
  </template>
</div>
```

**Chat** (mehrzeiliges Schimmer-Pattern):
- `.chat-skeleton-wrapper` + `.chat-skeleton-line`
- Animation `@keyframes skeleton-shimmer` in [public/css/chat.css](public/css/chat.css).

Kein Skeleton ohne Shimmer-Animation. CSS-File-Referenzen: [entity-list.css](public/css/entities/entity-list.css), [chat.css](public/css/chat.css).

---

## Filter-Bar (Listenfilter)

**Use:** Such-/Filtereingaben oberhalb von `.entity-list`-Listen.

**Markup:**
```html
<div class="filter-bar">
  <input class="filter-search-input" type="text" :placeholder="$app.t('filter.search')" x-model="filterText">
  <span class="filter-count" x-text="filteredItems.length + ' / ' + items.length"></span>
</div>
```

**Severity-/Wertungs-Filter:** generisches `.tabs` / `.tabs-btn` (siehe Tabs-Sektion oben). Kein eigenes Filter-Pattern. Beispiele: [public/partials/kontinuitaet.html](public/partials/kontinuitaet.html), [public/partials/szenen.html](public/partials/szenen.html).

---

## Heatmap-Visualisierung

**Use:** Tabellarische Datenintensitäts-Darstellung (Stil-Heatmap, Fehler-Heatmap).

**Klassen** [public/css/analysis/heatmap.css](public/css/analysis/heatmap.css):
- `.heatmap-wrap` — Container
- `.heatmap-legend` — Skala oberhalb
- `.heatmap-scroll` — horizontaler Scroll-Container
- `.heatmap-table` — Tabelle mit sticky `thead`
- `.heatmap-rowhead` — sticky linke Spalte
- `.heatmap-cell--tinted` / `--primary` / `--faded` / `--empty` — Intensitätsstufen
- `.heatmap-cell--clickable` / `--active` — interaktiv

**Cluster-Header** (Fehler-Heatmap, > 10 Spalten): zweistufiger `<thead>`. Erste Zeile `.heatmap-cluster-row` rendert pro Cluster ein `<th class="heatmap-cluster-head" :colspan="N">` mit Cluster-Label (uppercase, klein, getrackt). Zweite Zeile rendert pro Typ ein `<th>` mit Typ-Label. Spalten an Cluster-Grenzen tragen `.heatmap-cluster-start` (linker Border in Typen-Reihe **und** Body) — Trennlinie zwischen Clustern. SSoT: `FEHLER_CLUSTERS`-Array in [public/js/fehler-heatmap.js](public/js/fehler-heatmap.js); Reihenfolge der Spalten = Reihenfolge im Cluster-Array. Helper `fehlerHeatmapClusterStarts` liefert die Cluster-Grenz-Indizes für die Trennlinien-Klasse.

**Detail-Drawer** unter Tabelle: `.heatmap-detail` mit `.heatmap-detail-list`/`-page`/`-token-groups`.

**Mode-Toggle innerhalb Heatmaps:** `.tabs` + `.tabs-btn` + `--active`. Identisch zur generischen Tabs-Sektion oben — kein eigenes Heatmap-Pattern, einfach `.tabs` wiederverwenden.

---

## Tree (Sidebar-Navigation)

**Use:** Hierarchische Buch-/Kapitel-/Seiten-Navigation in der Sidebar.

**Klassen** [public/css/page/tree-history.css](public/css/page/tree-history.css):
- `.tree-chapter` / `.tree-chapter-header` / `.tree-chapter-header--active`
- `.tree-chapter-meta` — Counter rechts
- `.history-chevron` / `.history-chevron.open` — wiederverwendetes Rotations-Pattern (0° → 90°)
- `.tree-chapter-pages::before` — visuelle Guide-Linie zu Children

Nur in Sidebar-Tree verwendet. Bei neuer hierarchischer Liste: erst prüfen, ob die Tree-Klassen passen.

---

## History-Item-List (Versionierung, Job-Verlauf)

**Use:** Liste vergangener Job-Läufe / Page-Revisions, klappbar mit Detail-Drawer.

**Markup:**
```html
<button class="history-item" :class="{ 'history-item--active': active, 'history-item--open': open }">
  <span class="history-chevron" :class="{ open }">›</span>
  <span class="history-date" x-text="date"></span>
  <button class="history-item-delete" @click.stop="del()">…</button>
</button>
<div x-show="open" class="history-detail">…</div>
```

CSS: [public/css/page/tree-history.css](public/css/page/tree-history.css). `.history-detail` hat einen gestrichelten Top-Border, der visuell anschliesst. Chevron + State (`open`) wiederverwenden — nicht neu definieren.

---

## Editor

Editor-spezifische Patterns. Greifen nur in der Editor-Card und im Fokus-Modus; andere Karten verwenden sie nicht.

**Sub-Sections:**
- [Findings-Cards](#findings-cards-lektorat-ergebnisse) (Lektorat-Output, Severity, Marginalia-Stripe)
- [Page-Content-View](#page-content-view-reading-frame) (Reading-Frame, Buchsatz, Callouts)
- [Focus-Mode](#focus-mode) (Vollbild + Typewriter-Dimming)
- [Edit-Bubble-Toolbar](#edit-bubble-toolbar-inline-formatierung) (Inline-Format + Slash-Menu)
- [Find-and-Replace](#find-and-replace) (Cmd+F-Panel)
- [Lookup-Popover](#lookup-popover-figur-lookup) (Figuren-Detail bei Ctrl+Click)

### Findings-Cards (Lektorat-Ergebnisse)

**Use:** Einzelne Lektorats-/Review-Findings mit Original/Korrektur und Apply-Action.

**Klassen** (CSS in [public/css/editor/findings.css](public/css/editor/findings.css), Render-Logik im Frontend):
- `.finding` / `.finding--flash` (Highlight-Animation) / `.finding--applied` (nach Übernahme)
- Severity-Variante: `.finding.error` / `.ok` / `.style` (siehe Section „Severity-Vokabular" für Mapping)
- Children: `.finding-header`, `.finding-checkbox`, `.finding-content`, `.finding-original`, `.finding-korrektur`, `.finding-explanation`, `.finding-toggle-group`

**Stilbox** (`.stilbox`, `.stilbox--review-summary`, `.stilbox--spaced`) — bordered Container für Analyse-Sektionen, in Reviews und Findings wiederverwendet.

#### Marginalia-Stripe (Reading-Frame)

**Use:** Visueller Rotstift-Akzent rechts an Absätzen, die Lektorats-Markierungen enthalten. Editorial-Manuskript-Anmutung.

**Mechanik:** `.page-content-view p:has(.lektorat-mark)` setzt `padding-right` + Pseudo-`::after`-Stripe in severity-Farbe. Hartes Finding (`.lektorat-mark--selected`) → roter Stripe, weiches → amber. Modern-Browser-Only via `:has()`; ältere Engines fallen auf Default zurück (kein Stripe, Marks sind weiterhin sichtbar).

CSS: [public/css/page/page-view.css](public/css/page/page-view.css).

### Page-Content-View (Reading-Frame)

**Use:** Seiteninhalt im Lese-/Fokus-Modus (Serifenfont, lange Zeilen, Callouts).

**Klassen** [public/css/page/page-view.css](public/css/page/page-view.css):
- `.page-content-view` — Container mit max-width, Serif-Font
- `.page-content-view--editing` — Variante während Bearbeitung
- Innerhalb: native `h1`–`h6`, `blockquote` werden auto-gestylt
- `.callout.info` / `.success` / `.warning` / `.danger` — links eingerückte Callout-Boxen
- `.callout.pullquote` — zentrierte, gross gesetzte Hervorhebung zwischen Absätzen. Kein Border, kein Background — Typografie trägt allein. Auto-Anführungszeichen via `::before`/`::after` in Akzentfarbe.
- `.poem` — Sonderlayout für Verse (preserve whitespace)
- `.lektorat-mark` / `.lektorat-mark--selected` — Inline-Annotationen

**Buchsatz-Mikrotypografie** (am Container `.page-content-view`):
- `hanging-punctuation: first allow-end last` — Anführungszeichen ragen aus Satzkante.
- `font-feature-settings: "kern", "liga", "dlig", "calt", "onum"` — Ligaturen + alte Ziffern (Source Serif 4 hat OldStyle-Numerals).
- `text-rendering: optimizeLegibility`.
- `text-wrap: pretty` auf `<p>`, `text-wrap: balance` auf Headings (verhindert Witwen/Waisen).

Nicht selbst Reading-Typografie definieren; immer diesen Frame verwenden.

### Focus-Mode

**Use:** Vollbild-Editor mit Typewriter-Dimming (Cmd+Shift+F).

**State-Selektor:** `body.focus-mode` (gesetzt durch JS-Toggle).

**Klassen** [public/css/editor/focus-mode.css](public/css/editor/focus-mode.css):
- `.focus-paragraph-active` — voll sichtbarer Paragraph
- `.focus-paragraph-near` — leicht gedimmt (opacity 0.6)
- nicht-aktive Paragraphen: opacity 0.35
- `.focus-live-counter` / `.focus-live-counter--today` — Live-Wortzähler

Granularität (paragraph/sentence) und Timings sind über Tests abgesichert ([tests/unit/focus-granularity.test.mjs](tests/unit/focus-granularity.test.mjs)). Bei Änderungen Tests laufen lassen.

### Edit-Bubble-Toolbar (Inline-Formatierung)

**Use:** Schwebender Format-Button-Bar bei Editor-Selection (Bold/Italic/Heading).

**Klassen** [public/css/editor/edit-toolbar.css](public/css/editor/edit-toolbar.css):
- `.edit-bubble-toolbar` — fixed-position Container
- `.edit-bubble-btn` / `.edit-bubble-btn--bold` / `--italic` — Variante pro Format
- Slash-Menu: `.edit-slash-menu`, `.edit-slash-hint`, `.edit-slash-item`, `.edit-slash-item--active`

Spezifisch für Editor — bei neuer Inline-Toolbar erst prüfen, ob die Edit-Klassen passen.

### Find-and-Replace

**Use:** Suchen/Ersetzen-Panel im Editor (Cmd/Ctrl+F).

**Klassen** [public/css/editor/find-replace.css](public/css/editor/find-replace.css):
- `.edit-find` (fixed Container), `.edit-find-row`
- `.edit-find-input` (Such-/Ersetzen-Input)
- `.edit-find-count` (Treffer-Anzeige)
- `.edit-find-btn` / `.edit-find-btn--toggle` / `--active`
- `.edit-find-close`

Nur einmal verwendet (Editor). Doku hier zur Auffindbarkeit für künftige Such-Features.

### Lookup-Popover (Figur-Lookup)

**Use:** Hover-/Click-Popover mit Detail-Info (z.B. Figuren-Lookup im Editor bei Ctrl+Click).

**Klassen** [public/css/editor/figur-lookup.css](public/css/editor/figur-lookup.css):
- `.figur-lookup`, `.figur-lookup-header`, `.figur-lookup-body`, `.figur-lookup-row`, `.figur-lookup-footer`, `.figur-lookup-link`
- Position: fixed, JS setzt Top/Left aus Cursor-Position

Bei neuen Popover-Komponenten dieses Markup-Schema übernehmen (Header/Body/Footer), Custom-Klassen-Präfix pro Use-Case (`.xxx-lookup`).

---

## Heading-Hierarchie in Karten

- `.card-title` — Karten-Titel (Header, h2-Niveau)
- `.card-subline` / `.card-subline-link` — Untertitel mit Timestamp/Save-Indicator
- `.section-heading` — Sub-Sektion innerhalb generierter Outputs (h3-Niveau)
- `.section-heading-top` — erste Section ohne oberen Abstand
- `.section-heading-sub` — Sub-Section innerhalb `.section-heading` (h4-Niveau, kleiner, weniger Abstand). Anlegen, sobald gebraucht — kein eigenes `.xxx-subheading` pro Karte.

Kein `<h3>`/`<h4>` innerhalb von Karten ohne diese Klassen — sonst kollidiert es mit globaler Heading-Cascade.

---

## Save-Indicator

**Use:** Karten mit auto-saving State (Editor, User-Settings, Book-Settings).

```html
<span class="save-indicator save-indicator--draft" x-text="$app.t('common.draft')"></span>
<span class="save-indicator save-indicator--offline" x-text="$app.t('common.offline')"></span>
```

CSS: [public/css/editor/focus-mode.css](public/css/editor/focus-mode.css). Inline in `.card-subline`.

---

## Avatar-Menu

**Use:** User-Menü oben rechts (Profil, Logout, Sprache).

**Klassen** (CSS in [public/css/components/buttons-badges.css](public/css/components/buttons-badges.css) + erweitert):
- `.avatar-btn` / `.avatar-btn--active` — Trigger
- `.avatar-btn-img` (Foto) oder `.avatar-btn-initials` (Fallback)
- `.avatar-menu-panel` — Dropdown
- `.avatar-menu-header` (mit `-avatar`/`-text`/`-img`)
- `.avatar-menu-section`, `.avatar-menu-item`, `.avatar-menu-item--logout`
- `.avatar-menu-divider`, `.avatar-menu-label`
- `.avatar-menu-provider` + `-dot` (Provider-Indikator)

Markup: [public/partials/avatar-menu.html](public/partials/avatar-menu.html). Bei neuen Header-Dropdowns dieses Pattern wiederverwenden statt eigenes Menu zu bauen.

---

## Sofort-Tooltip (`data-tip`) — **Default-Variante**

**Harte Regel:** `data-tip` ist die bevorzugte Tooltip-Variante. Natives `title=` hat ~500ms Delay, der nicht abstellbar ist — zu langsam für jedes Hover-Feedback. Neue Tooltips werden grundsätzlich als `data-tip` gesetzt.

**Markup:** `data-tip="Mo: +1234"` (oder Alpine `:data-tip="..."`) auf beliebigem Element. Das Attribut bleibt — gerendert wird via geteiltem Layer.

**Implementation:** Ein einziges `.tip-layer`-Element wird beim ersten Hover via [public/js/tooltip.js](public/js/tooltip.js) in den Body gehängt und auf das jeweilige Target positioniert (fixed). Pseudo-Slots (`::before`/`::after`) auf den Targets bleiben so frei für eigene Decorations.

**Klassen** [public/css/components/tooltip.css](public/css/components/tooltip.css):
- `.tip-layer` (Wrapper, `position: fixed`), `.tip-bubble` (Inhalt), `.tip-arrow` (Dreieck).
- `data-placement="top|bottom"` schaltet die Pfeilseite. Auto-Flip nach unten, wenn oben kein Platz.

**Wann `title=` ausnahmsweise erlaubt:**
- Reine Form-Inputs / Icon-Buttons, wo a11y-Screenreader-Hint wichtiger ist als Geschwindigkeit (`<button title="Schliessen">` etc.).
- In Konflikt-Fällen darf beides parallel gesetzt werden (`data-tip` für Sicht, `title` für Screenreader).

**Nicht erlaubt:**
- Neue Wert- oder Erklärungs-Tooltips als `:title=` ohne `data-tip` daneben — User-Präferenz, weil 500ms-Delay als störend empfunden wird.
- **Keine** `[data-tip]:hover::before` / `::after`-Selektoren — Pseudos auf dem Target gehören dem Element.

---

## Header-Actions

**Use:** Rechts-ausgerichtete Button-Cluster im Karten-Header (z.B. „Aktualisieren"-Button, Token-Stats).

**Klassen** [public/css/book/header-actions.css](public/css/book/header-actions.css):
- `.header-actions` — flex-Container
- `.header-action-cluster` — Sub-Gruppe mit reduziertem Gap
- Innerhalb: `.tok-stats` für Token-Counter

Nicht eigene Toolbar-Layouts pro Karte erfinden.

### Card-Actions: Gruppierung (`.card-actions--grouped`)

**Use:** Karten-Header mit ≥4 Aktionen, die semantisch in Bündel zerfallen (z.B. Editor: run-Aktionen / Modus-Toggles / Side-Card-Toggles). Trennstrich zwischen Bündeln macht die Aktionstypen visuell unterscheidbar.

**Markup:**
```html
<div class="card-actions card-actions--grouped">
  <span class="action-group">
    <button>Prüfen</button>
    <button>Speichern</button>
  </span>
  <span class="action-sep" aria-hidden="true"></span>
  <span class="action-group">
    <button>Bearbeiten</button>
    <button>Fokus</button>
  </span>
</div>
```

**Klassen** ([public/css/components/card-form.css](public/css/components/card-form.css)):
- `.action-group` — `display: contents` — semantischer Wrapper, kein Layout-Bruch zum Flex-Parent
- `.action-sep` — 1 px Trennstrich (`var(--color-border)`), full-height via `align-self: stretch`

**Mobile (≤700 px):** `.action-sep` wird ausgeblendet (Buttons stapeln ohnehin auf 100% Breite via Flex-Reflow). Kein paralleler Stack-Marker nötig.

**Wann nicht:** Karten mit ≤3 Aktionen oder ohne semantische Bündel — bleiben bei flachem `.card-actions`. Gruppierung nur, wenn die Sektionen wirklich unterschiedliche Aktionstypen sind.

**Referenz:** [public/partials/editor.html](public/partials/editor.html) (View-Mode: 3 Gruppen × run/mode/side; Edit-Mode: 2 Gruppen × commit/mode).

---

## Command-Palette

**Use:** Globaler Power-User-Eintritt zu allen Features (Cmd/Ctrl+K bzw. `/`). Gruppierte Liste aus Karten, globalen Aktionen und Such-Providern (Seiten, Kapitel, Figuren, Orte, Szenen).

**Hero-Trigger** (auf Buch-Übersicht oben):
```html
<button type="button" class="palette-hero" @click="openPalette()">
  <span class="palette-hero-icon" aria-hidden="true">⌘</span>
  <span class="palette-hero-text" x-text="t('palette.hero.text')"></span>
  <kbd class="palette-hero-kbd">⌘K</kbd>
</button>
```

**Modal-Markup:** siehe [public/partials/palette.html](public/partials/palette.html) (per `x-teleport="body"` — fixed-Overlay aus transformiertem Eltern-Container befreit).

**Klassen** ([public/css/components/feature-tiles.css](public/css/components/feature-tiles.css)):
- `.palette-hero` / `-icon` / `-text` / `-kbd` — Hero-Trigger im Home
- `.palette-overlay` — Fullscreen-Overlay mit Backdrop-Blur
- `.palette-panel` — zentriertes Modal
- `.palette-input` — Such-Input (mit `role="combobox"`, `aria-controls`)
- `.palette-list` (`role="listbox"`) + `.palette-section` + `.palette-section-label`
- `.palette-item` / `--active` / `--disabled` (`role="option"`)
- `.palette-item-label` / `.palette-item-desc`
- `.palette-mode` + `.palette-mode-pill` — aktive Prefix-Mode-Anzeige (`>` Befehle, `#` Seiten, `!` Kapitel, `@` Figuren, `$` Orte, `%` Szenen)
- `.palette-legend` + `-grid` + `-row` — Prefix-Legende bei leerem Input
- `.palette-mark` — Fuzzy-Match-Highlight im Item-Label
- `.palette-empty` / `.palette-toast`

**SSoT:** Karten/Aktionen/Provider stehen in [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js), nicht im Template. Neuer Eintrag → dort, nicht hier.

**Kein zweiter Such-Trigger:** Jede neue „Spotlight"-/„Quick-Switcher"-Idee zuerst in Palette-Provider einbauen, kein paralleles Modal.

---

## Routing / Deep-Links (URL-Pflicht)

**Use:** Jedes Feature mit eigener Hauptansicht (Karte, Detail, Editor-Modus, Modal mit dauerhaftem Zustand) braucht eine eigene URL. State, der nicht in der URL steht, ist nicht teilbar, nicht bookmarkbar, geht beim Reload verloren und ist im Plausible nicht messbar. Single-Source-of-Truth für Sichtbarkeit ist die URL — nicht der Show-Flag.

**Schema** (siehe [public/js/app-hash-router.js](public/js/app-hash-router.js)):
```
#profil
#book/:bookId                                     ← Buch-Übersicht
#book/:bookId/<view>                              ← Buchebenen-Karte ohne Selektion
#book/:bookId/page/:pageId                        ← Seite im Editor
#book/:bookId/figur/:figId | ort/:ortId | szene/:szId
#book/:bookId/kapitel[/:chapterId]
```

Bekannte Views: `figuren`, `orte`, `szenen`, `ereignisse`, `kontinuitaet`, `bewertung`, `kapitel`, `chat`, `uebersicht`, `stats`, `stil`, `fehler`, `einstellungen`, `finetune`, `export`, `pdf`.

**Regeln:**
- **Neue Karte → eigener View-Slug** in `_computeHash()` ([public/js/app-hash-router.js](public/js/app-hash-router.js)) **und** Apply-Zweig in `_applyHash()`. Slug kurz, deutsch, Kleinbuchstaben (passt zu bestehenden: `bewertung`, `einstellungen`).
- **Selektion (`selectedFigurId` etc.) muss in der URL** stehen, sonst Reload verliert die Auswahl. Pattern: eigene Sub-Route `#book/:bookId/<entity>/:id`.
- **Push vs. Replace:** gleiche Kategorie (z.B. Figur ↔ Figur) = Replace, Wechsel = Push. Liefert `_hashCategory()` automatisch — neue Aliase (`figur` → `figuren`) dort eintragen.
- **Watcher auf neue State-Felder, die in der URL landen** ([app-hash-router.js](public/js/app-hash-router.js)#`_setupHashWatchers`). Ohne Watcher kein Auto-Sync; Hash-Stand driftet.
- **Feature-Registry** ([public/js/cards/feature-registry.js](public/js/cards/feature-registry.js)): jeder neue Toggle bekommt einen Eintrag mit Show-Flag-Key, der in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js) gespiegelt ist. Recency-Tracking (Palette „Zuletzt") triggert auf rising-edge des Show-Flags und braucht den exakten Key.
- **Exklusivität / Home-Klick / View-Reset** sind Registry-driven ([public/js/cards/feature-registry.js](public/js/cards/feature-registry.js)#`EXCLUSIVE_CARDS`). `_closeOtherMainCards`, `resetView` und `_maybeOpenBookOverview` ([public/js/app-view.js](public/js/app-view.js)) iterieren ausschliesslich über diese Liste — neue Hauptkarte braucht **nur** einen `{ key, flag }`-Eintrag dort, keine zusätzliche Stelle in app-view.js. `key` matcht das Argument von `_closeOtherMainCards(keep)`. Auch nicht-Palette-Karten (`kapitelReview`, `userSettings`) gehören rein, sobald sie sich gegenseitig ausschliessen. Test: [tests/unit/card-exclusivity.test.mjs](tests/unit/card-exclusivity.test.mjs) deckt Home-Klick-Regression ab.
- **Plausible-Tracking:** `_writeHash` triggert nach jedem Push/Replace `plausible('pageview')`. Eigene URL = eigene Metrik, ohne Code-Änderung an Analytics.
- **Test:** [tests/unit/hash-router.test.mjs](tests/unit/hash-router.test.mjs) ergänzen für jede neue View/Selektion (Push/Replace + Apply-Roundtrip).

**Anti-Pattern:**
- Karte zeigen via reinem Show-Flag ohne URL-Pendant → Reload verliert Ansicht, „Link mir mal X" geht nicht.
- Selektion nur in lokalem Sub-State (Karte hält `selectedXxxId` selbst) → Hash kann nicht synchronisieren.
- Modal/Drawer mit dauerhaftem Inhalt (z.B. eigener Settings-Bereich) ohne URL — gleiche Regel wie Karten.

**Ausnahmen** (kein eigener Hash):
- Kurzlebige Overlays ohne Inhalts-State: Confirm-Dialog, Toast, Sofort-Tooltip, Avatar-Menu, Edit-Bubble-Toolbar.
- Editor-Sub-Modi (Edit, Fokus, Findings) — sie hängen am Page-Hash; Modus selbst wird nicht gehashed (würde sonst Back-Button-Verhalten zerschiessen).
- Command-Palette (öffnet via Shortcut, schliesst sofort wieder; kein Inhalts-State).

---

## Book-Overview-Tiles

**Use:** Default-Home beim Buchwechsel ([public/partials/bookoverview.html](public/partials/bookoverview.html)). Tile-Grid mit Inline-SVG-Visualisierungen (Sparkline, Donut, 7-Tage-Bars, Stacked-Bar, Sterne) — bewusst **kein Chart.js-Lazy-Load** (Tiles laden sofort, wenig Daten).

**Klassen** ([public/css/book-overview/base.css](public/css/book-overview/base.css)):
- `.book-overview .overview-grid` — `repeat(auto-fit, minmax(220px, 1fr))` + `grid-auto-flow: row dense` (verhindert Whitespace-Inseln bei `--hero`/`--medium`/`--wide`-Spans)
- `.overview-tile` — Basis-Tile, optional `.internal-link` für klickbar
- Spans (≥720px): `.overview-tile--hero` (span 2), `.overview-tile--medium` (span 2), `.overview-tile--wide` (full-width)
- `.overview-tile--actions` — Quick-Action-Container (gestrichelter Border, kein Hover-Lift, optisch von Daten-Tiles abgesetzt)
- Tile-Innenleben: `.overview-tile-label` (Header), `.overview-hero-row`/`-num`/`-value`/`-unit`, `.overview-substats`/`-substat`, `.overview-sparkline`, `.overview-trend-meta`/`-pct` (`--up`/`--down`)
- 7-Tage-Bars: `.overview-bars7` + `-col`/`-track`/`-fill` (`--pos`/`--neg`)/`-label`, `.overview-bars7-total`
- Donut: `.overview-donut-row` + `.overview-donut` + `-text`/`-meta`
- Heute-Ring: `.overview-today-ring` (Modifier `--active` triggert `overviewTodayPulse`-Animation, `--reached` flippt Stroke auf success-Farbe). Respektiert `prefers-reduced-motion`. Math via `overviewTodayRing(goal)` in [public/js/book-overview.js](public/js/book-overview.js).
- Streak-Heatmap: `.overview-streak-grid` (53 Spalten × 7 Reihen, GitHub-Stil) + `.overview-streak-week` (`display: contents` als logische Wochen-Gruppe) + `.overview-streak-cell--lvl0..4` (`color-mix(--color-accent, --color-bg)`-Stufen), `--empty` (visibility hidden für Future-Cells), `--future` (opacity-Reduce). Plus `.overview-streak-meta` (Stats-Reihe), `.overview-streak-legend` (kleine Cells als Skala). Math via `overviewStreakHeatmap()` — Quartil-Bucketing der positiven Tagesdeltas, Streak bricht bei null/negativem Delta (heutiges Null-Delta zählt nicht als Bruch).
- Fehler-Bars: `.overview-error-bars` + `-bar-item`/`-head`/`-typ`/`-count`/`-track`/`-fill`
- Bewertung: `.overview-stars` + `.overview-star` (`--full`/`--half`), `.overview-review-meta`/`-date`/`-trend`
- Figuren-Chips: `.overview-fig-row` + `-count`/`-count-unit`/`-chips`/`-chip`/`-name`/`-avatar` (Avatar-Farbe via `[data-idx="0|1|2"]`)

**Klick-Verhalten:** `.overview-tile.internal-link` öffnet die zugehörige Karte (über globalen `.internal-link`-Handler aus app.js — nicht selbst verdrahten).

**Hover-Override:** Globaler `.internal-link:hover` setzt `opacity: 0.65`. Für Tiles ungewollt — `.overview-tile.internal-link:hover` setzt `opacity: 1` zurück und nutzt Border/Shadow als Affordance.

**Neuer Tile-Typ:** Bestehende Tile-Klassen wiederverwenden, SVG inline ins Markup, keine externe Vis-Lib für Overview einführen.

### Tile-Size-Policy

Verbindlich pro Tile-Typ. `grid-auto-flow: row dense` füllt mittlere Lücken, Tail-Lücken in der letzten Zeile sind erlaubt. Tiles werden **nie zwischen** anderen Tiles leer gelassen — Span entweder fix grossgenug oder klein genug, dass Dense-Packing die Lücke schliesst.

| Tile | Span | Begründung |
|------|------|-----------|
| Snapshot (Hero) | `--hero` (2) | Hero-Zahl + 5 Sub-Stats brauchen Zeile |
| Trend (Sparkline) | small (1) | SVG skaliert, Trend-% darunter |
| 7-Tage-Bars | small (1) | 7 schmale Bars |
| Heute-Ring | small (1) | Donut + kurze Meta |
| Streak-Heatmap | `--wide` (full) | 53 Wochen × 7 Tage Grid, eigene Zeile |
| Coverage (Donut) | small (1) | Donut + Meta |
| Top-Fehlertypen | small (1) | Bars vertikal gestapelt |
| Letzte Bewertung | small (1) | Sterne + Datum |
| Figuren / Szenen / Schauplätze (Chips) | small (1) | Count + 3-6 Chips, max 2 Zeilen |
| Figuren-Präsenz-Matrix | `--medium` (2) | Spalten-Header (vertikal rotiert) braucht Höhe; mehrere Top-Figuren brauchen Cell-Reihe |
| Schauplatz-Präsenz-Matrix | `--medium` (2) | analog zur Figuren-Matrix |
| Kapitel-Verteilung (Bar+Meta-Liste) | `--medium` (2) | Bar + 5 Meta-Zellen (Δ%, Z, NS, W, S) brauchen horizontalen Platz, sonst wrap |
| Lektorat-Findings pro Kapitel | `--medium` (2) | analog: Bar + Δ% + Count |
| Lektoratszeit pro Kapitel | `--medium` (2) | analog: Bar + Δ% + Dauer |
| Zuletzt bearbeitet (Page-Liste) | `--medium` (2) | Name + Z + NS + Kapitel-Tag pro Zeile |
| Quick-Actions | small (1) | 4 Buttons mit Wrap, kein Daten-Tile |

**Regel:** Wer einen neuen Tile-Typ hinzufügt, ergänzt diese Tabelle und wählt Span nach demselben Prinzip — Content mit horizontaler Struktur (Bars/Liste/Matrix) → medium; Content mit vertikaler Struktur (Donut, Sparkline, Chip-Cluster) → small. Hero und full-width nur für die im Header dokumentierten Sonderfälle (Snapshot, Streak).

**Container-Query:** `.overview-tile` hat `container-type: inline-size`. Chapter-Row-Reflow (`@container (max-width: 380px)` in [public/css/book-overview/base.css](public/css/book-overview/base.css)) greift, falls ein Listen-Tile doch auf small fällt (Mobile/2-Spalten-Viewport), und bricht das 3-Spalten-Grid in einen Stack — keine zerquetschten Meta-Zellen.

---

## Container-Queries vs. Media-Queries

**Wann was:** Komponente in **fixem Layout-Slot** (Sidebar 280 px breit, Modal 600 px max) → `@media (max-width: …px)`. Komponente in **variablem Slot** (Tile-Grid mit `--hero`/`--medium`/small-Spans, Drawer-Content das je nach Höhe scrollt) → `@container (max-width: …px)`.

**Bestehender Stand:**
- [public/css/book-overview/base.css](public/css/book-overview/base.css) — `.overview-tile` hat `container-type: inline-size`. Chapter-Row-Reflow (`@container (max-width: 380px)`) bricht 3-Spalten-Grid in Stack, falls Tile auf small fällt.

**Pflicht-Pattern:**
```css
.foo-container {
  container-type: inline-size;
  container-name: foo;
}
@container foo (max-width: 380px) {
  .foo-child { … }
}
```

**Regeln:**
- Kein Mix in derselben Regel — entweder Media- oder Container-Query, nicht beide gleichzeitig.
- Mobile-Regel mit Viewport-Bezug (Phone-Layout, Touch-Targets) → Media. Mobile-Regel mit Slot-Bezug (Tile schmal weil 2-Spalten-Grid auf Tablet) → Container.
- Container-Name setzen, sobald mehr als ein Container im Komponenten-Baum nistet.

---

## Print-Styles

**Status:** Nicht supported. Browser-Print für Karten/Editor ist undefiniert. Wer ein Buch oder einen Bericht als PDF braucht, nutzt den Custom-PDF-Export ([routes/jobs/pdf-export.js](routes/jobs/pdf-export.js)).

Kein eigenes `@media print {}` pro Karte einführen — der Aufwand für sauberes Print-Layout wäre erheblich (Page-Breaks, Header/Footer, Schwarzweiss-Fallbacks) und nicht im Scope.

---

## Drawer / Side-Panel

**Status:** Aktuell **kein generisches Drawer-Pattern**. Drawer-artige Inhalte existieren nur als `.heatmap-detail` ([heatmap.css](public/css/analysis/heatmap.css)) — Detail-Box unter der Heatmap-Tabelle, nicht als Slide-In-Side-Panel.

**Wann anlegen:** Sobald ein zweiter Konsument auftaucht (Findings-Detail-Drawer, Figuren-Detail-Drawer, Chat-Side-Panel im Editor). Dann hier dokumentieren, nicht ad-hoc daneben bauen.

**Vorbedingungen für globales Drawer-Pattern:**
- `--z-overlay` (2000) als Layer; Backdrop optional (Modal-Charakter ja → Backdrop, persistenter Begleitpanel → kein Backdrop).
- Slide-In-Animation via `--transition-emphasized`, mit `prefers-reduced-motion`-Fallback (kein Slide, nur Fade).
- Focus-Trap analog `.confirm-overlay` wenn Modal-Charakter.
- `aria-labelledby` + `role="dialog"` (Modal) bzw. `role="complementary"` (persistent).
- Geometrie: feste Breite (z.B. 360 px) mit `min(360px, 100vw - 32px)`-Cap für Mobile.

**Bis dahin:** Detail-Inhalt unter der Liste rendern (analog `.heatmap-detail`) oder als Karte mit `_closeOtherMainCards` (analog Editor + Chat).

---

## Z-Index-Stack

**Pflicht-Tokens** ([public/css/tokens.css](public/css/tokens.css)). Hartcoded `z-index: 9999` o.ä. nur, wenn der Layer wirklich neu ist — dann Token ergänzen, nicht ad-hoc setzen.

| Token | Wert | Verwendung |
|-------|------|-----------|
| `--z-base` | 1 | In-flow Standard, `position: relative`-Sticky-Anker (z.B. Heatmap-Body-Cells, Book-Overview-Tile-SVG-Layer) |
| `--z-sticky` | 100 | Sticky Inhalts-Header in Listen/Heatmaps (`.heatmap-table thead`, sticky Filter-Bars) |
| `--z-header` | 200 | Sticky Card-Header, Toolbar-Header (Avatar-/Komplettstatus-Popover-Panels) |
| `--z-popover` | 1000 | Tooltip-Layer, Synonym-Menu, Figur-Lookup, Combobox-Dropdown, Focus-Counter, Token-Setup-Inline-Hint, Ideen-Move-Picker |
| `--z-toolbar` | 1100 | Edit-Bubble-Toolbar (1001), Find-and-Replace (1002) — über Popovers, weil sie auf Selektion reagieren |
| `--z-overlay` | 2000 | Palette-Overlay, künftige Fullscreen-Trigger ohne Modal-Charakter |
| `--z-banner` | 10000 | Session-Banner, Dev-Banner (oben fixed, über Karten und Palette, unter Modals) |
| `--z-modal` | 9500 | Confirm-Dialog Overlay-Backdrop |
| `--z-modal-front` | 11000 | Confirm-Dialog Panel — über Banner und Palette, weil Dialog aus jedem Kontext getriggert werden kann |
| `--z-toast` | 12000 | Reserviert für künftige Toasts/Snackbars (siehe Section „Toast/Snackbar") |

**Regeln:**
- Stapel-Verletzung (Layer X muss über Layer Y liegen, ist aber numerisch darunter) → Token-Tabelle hier korrigieren, nicht lokal patchen.
- Zwei Modals gleichzeitig sind verboten (`_closeOtherMainCards` + Confirm-Dialog ist Single-Modal-Garant). Wenn doch → `--z-modal-front` belegt der zuletzt geöffnete.
- `position: fixed` ohne z-index erbt nicht den Stack-Kontext der Eltern — Token ist Pflicht.

---

## Reduced-Motion (Pflicht)

**Globale Regel:** [base.css](public/css/layout/base.css) enthält einen globalen `@media (prefers-reduced-motion: reduce)`-Block, der **alle** Animationen und Transitions auf 0.01ms setzt:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Das deckt 100 % der Karten-Eingangs-Animationen, Skeleton-Shimmer, Hover-Transitions und Slide-Effekte ab. **Keine pro-Komponente-Override nötig** für die Standard-Cases.

**Pro-Komponente-Override sinnvoll, wenn:**
- Animation hat Funktionssemantik, die ohne Bewegung nicht greift (z.B. Loading-Spinner) → ggf. statisches Icon-Fallback statt einfach ausgeschaltet.
- JS-getriebene Animation (smooth-scroll, manuelle setInterval-Animationen) — die globale CSS-Regel greift hier nicht. JS muss `window.matchMedia('(prefers-reduced-motion: reduce)').matches` prüfen ([public/js/editor/focus.js](public/js/editor/focus.js) als Referenz).

**Bestehende JS-Reduktion:** [editor/focus.js](public/js/editor/focus.js), [book-overview/stats.css](public/css/book-overview/stats.css) (Today-Ring `--active`-Animation explizit auf `none` gesetzt, weil `animation: pulse infinite` auch unter `0.01ms` weiter zappeln würde).

**Nicht-betroffen:**
- Hover-Color-Tints (kein Layout-Shift, < 0.15s)
- Chevron-Rotation `›` 0°→90° (semantischer Marker für Zustand)

Wer eine neue Animation einführt: nichts tun, ausser sie ist `infinite` (dann explizit `animation: none` im Reduced-Motion-Block setzen) oder JS-getrieben (dann `matchMedia`-Check).

---

## Severity-Vokabular (Mapping)

Drei parallele Skalen sind vorhanden — bewusst, weil Use-Cases unterschiedlich sind. Pflicht: das passende Vokabular pro Kontext, nicht querkreuzen.

**Zwei Farb-Achsen in tokens/colors.css:**
- **content-severity** (`--color-stark/-mittel/-schwach` mit `-bg`/`-text`) — Findings, Continuity, Lektorats-Output. Semantisch reicher als ok/warn/err und visuell getrennt, damit Findings nicht wie System-Banner aussehen.
- **operational-status** (`--color-ok-*`, `--color-warn-*`, `--color-err-*`) — Banner, Validation-Border, Job-Status, Sync-Status, System-Hinweise.

Eigene Shades bewusst nicht aliased — Achsen optisch trennen. Regel: Lektorats-/Continuity-Output greift content-severity, Banner/Job/Validation greifen operational-status. Querkreuzen nur, wenn ein Element semantisch beides ist (rar).

| Skala | Klassen | Use-Case | CSS |
|-------|---------|---------|-----|
| **Findings** (Lektorat-Ergebnisse) | `.finding.error` / `.ok` / `.style` | Output von `runCheck` — Border-Color am Findings-Container | [findings.css](public/css/editor/findings.css) |
| **Severity-Tag** (Listen-Anker, Sortier-Marker) | `.severity-tag--kritisch` / `--stark` / `--mittel` / `--schwach` / `--niedrig` | Inline-Tag in `.entity-list` (Lektorats-Findings, Kontinuitäts-Issues, Fehler-Heatmap, Szenen-Wertung) | [entity-list.css](public/css/entities/entity-list.css) |
| **Status-Badge** (Job-/Sync-Status) | `.badge-ok` / `.badge-warn` / `.badge-err` | Job-Queue, Sync-Status, allgemeine Inline-Indikatoren | [buttons-badges.css](public/css/components/buttons-badges.css) |

**Mapping Lektorat-Schweregrad → Severity-Tag → Findings-Klasse:**

| Schweregrad (KI-Output) | `.severity-tag--*` | `.finding.*` | Token |
|-------------------------|--------------------|--------------|-------|
| `kritisch` | `--kritisch` | `.error` | `--color-err-border` |
| `stark` | `--stark` | `.error` | `--color-stark` |
| `mittel` | `--mittel` | `.style` | `--color-mittel` / `--color-style-border` |
| `schwach` | `--schwach` | `.style` | `--color-mittel` / `--color-schwach-bg` |
| `niedrig` | `--niedrig` | `.ok` | `--color-tag-bg` / `--color-ok-border` |

**Regel:** Severity-Tag ist visueller Anker in Listen, Findings-Klasse trägt Border am Output-Container. Beide Skalen werden parallel gesetzt — ein Tag im Listenitem, eine Container-Klasse beim Detail-Render. Wer eine neue Severity-Karte baut: dieselben fünf Stufen + diese Mapping-Zeile, nichts Neues erfinden.

**Anti-Pattern:** `.finding.kritisch` (Kreuzung der Skalen), eigene Klassen wie `.warn-tag` neben `.severity-tag--mittel` (Reinvention).

---

## Toast/Snackbar

**Status:** Ein generischer Job-Done-Toast ist umgesetzt (`.job-toast` in [job-toast.css](public/css/components/job-toast.css), Markup [partials/job-toast.html](public/partials/job-toast.html), State `jobToast` + `_showJobToast()`/`_dismissJobToast()` am Root). Daneben weiterhin lokal: `.palette-toast` ([feature-tiles.css:151](public/css/components/feature-tiles.css#L151)) als Statuszeile innerhalb des Palette-Modals — kein Floating-Snackbar, deshalb keine Migration nötig.

**Markup:**
```html
<div class="job-toast job-toast--ok" role="status" aria-live="polite">
  <span class="job-toast-msg">Komplettanalyse fertig</span>
  <button class="job-toast-close" aria-label="Schliessen">×</button>
</div>
```
- Severity-Modifier: `.job-toast--ok` (Success) / `.job-toast--err` (Error). Mappt auf `--color-ok-*` bzw. `--color-err-*` aus operational-status (siehe Severity-Achsen).
- Position: fixed bottom-right (`--z-toast` = 12000). Mobile (<600px): full-width unten.
- Animation: 160 ms Fade+Slide; bei `prefers-reduced-motion: reduce` nur Fade.

**Trigger:** Root-Handler `_onJobFinished` ([app-jobs-core.js](public/js/app-jobs-core.js)) ruft `_maybeShowJobToast(detail)` für eine Whitelist langlaufender Job-Typen (`komplett-analyse`, `kontinuitaet`, `review`, `kapitel-review`, `figuren`, `book-chat`, `finetune-export`, `pdf-export`, `batch-check`, `werkstatt-brainstorm`, `werkstatt-consistency`). `type === 'check'` (Seiten-Lektorat) ist absichtlich ausgenommen — feuert pro Seitenklick und hat sein eigenes Sidebar-Signal. `status === 'cancelled'` erzeugt keinen Toast.

**Auto-Dismiss:** 4500 ms via `_jobToastTimer`. Close-Button setzt Toast sofort auf `null`.

**Regeln für neue Konsumenten:**
- `aria-live="polite"` für Info/Success, `aria-live="assertive"` für Error (Markup oben → `polite`; bei Pflicht-Error im Markup overriden).
- Niemals modal/blockierend. Für Bestätigungen ist `.confirm-overlay` da.
- Toast-Text immer i18n-Key (Severity-Suffix `toast.job.done` / `toast.job.failed` separat, damit Job-Labels wiederverwendbar bleiben).
- Bei zusätzlichen Use-Cases (Save-Success, Network-Recovery): zweiten State `appToast` o.ä. *nicht* anlegen — `jobToast` umbenennen in `appToast` und Severity/Source-Felder erweitern.

**Card-interne Status-Hinweise** (Save-Bestätigung in einer Form, Validation-Fehler innerhalb einer Karte) bleiben bei `.card-status` / `.book-settings-saved` / `.book-settings-error` — Toast nur für globale, kartenübergreifende Events.

---

## Accessibility (A11y)

Pflicht-Patterns. Verstreute aria-Verwendungen werden hier zentralisiert; neue Komponenten orientieren sich daran statt eigene Lösungen zu finden.

### Klickbare Nicht-Buttons

`.internal-link` (siehe CLAUDE.md harte Regel) wird global per MutationObserver tastatur-erreichbar gemacht (`role="button"`, `tabindex="0"`, Enter/Space → click). Keine eigene Verdrahtung pro Element.

### Toggle-Sections (Accordion)

`.collapsible-toggle` braucht `:aria-expanded="open"`. Der Chevron-Marker `›` ist optisch redundant, daher `aria-hidden="true"` am `<span class="history-chevron">` setzen, sonst liest Screen-Reader „›" als „chevron right".

### Combobox

`Alpine.data('combobox')` setzt `role="combobox"` + `aria-controls` + `aria-expanded` automatisch. Liste hat `role="listbox"`, Items `role="option"` mit `aria-selected`. Kein eigenes ARIA-Setup im Konsumenten-Markup.

### Dialoge / Modale

`.confirm-overlay` → `role="dialog"` + `aria-modal="true"` + `aria-labelledby`/`aria-describedby` auf den Message-Container. Focus-Trap: erstes fokussierbares Element bekommt Fokus beim Open, Esc schliesst, Tab/Shift+Tab bleibt im Modal. Beim Close: Fokus zurück auf den auslösenden Trigger.

Gilt analog für Palette-Overlay, Token-Setup-Modal, Avatar-Menu (letzteres als `role="menu"`, Items `role="menuitem"`).

### Live-Regions (Status-Updates ohne Visual-Refocus)

| Use-Case | Region |
|---------|--------|
| Job-Status (Lektorat läuft, Findings X/Y) | `aria-live="polite"`, `aria-busy="true"` während Loading |
| Save-Indicator (`.save-indicator--draft/--offline`) | `aria-live="polite"` |
| Fehler-Banner (Session-Expired, Network) | `aria-live="assertive"` |
| Toast (künftig) | `polite` für Info, `assertive` für Error |

Card-Loading-States setzen am `.card-status`-Element `aria-busy="true"` solange `loading` truthy ist.

### Form-Validation

Inputs mit Fehler: `aria-invalid="true"` + `aria-describedby="<id-of-error>"` auf den Input. Fehler-Element bekommt eigene ID. Kein Fehler nur visuell via Roter Border — Screen-Reader liest sonst nichts.

### Focus-Visible

Globaler `:focus-visible`-Stil in [base.css](public/css/layout/base.css). Karten dürfen nicht per `outline: none` ohne Ersatz überschreiben. Wenn lokal eigener Fokus-Stil nötig: `:focus-visible` mit `box-shadow: 0 0 0 2px var(--color-border-focus)` oder analog.

### Tastatur-Navigation in Listen

`.entity-list` mit klickbaren Zeilen → Pfeil-Up/Down navigiert, Enter aktiviert (analog Palette). Roving-Tabindex statt Tab durch alle 200 Items. Pattern: ein Item `tabindex="0"`, alle anderen `tabindex="-1"`, Pfeile verschieben den Tabindex.

### Reduzierte Bewegung

Siehe Section „Reduced-Motion" oben.

### Lang-Attribut

Inhalte in einer Locale, die vom `<html lang="...">`-Default abweicht, bekommen `lang="de"` / `lang="en"` am Container. Relevant für Chat-Antworten und Seiten-HTML (User-Sprache pro Buch).

---

## CSS-File-Inventar

Welche Datei besitzt welche Klassen. Bei neuer Klasse: erst hier prüfen, ob ein File thematisch passt — sonst neue Datei anlegen + in [public/index.html](public/index.html) **und** [tests/fixtures/focus-harness.html](tests/fixtures/focus-harness.html) einhängen (gleiche Reihenfolge!).

Struktur: 8 thematische Subfolder unter [public/css/](public/css/) + Root-Solitäre. Cascade-Order = Lade-Order in [public/index.html](public/index.html).

### Root (Facade + Solitäre)
| File | Inhalt |
|------|--------|
| [tokens.css](public/css/tokens.css) | Cascade-Layer-Order, `@font-face`, `@import` der Token-Module aus `tokens/`. Slim Facade — keine Tokens direkt drin. Unlayered. |
| [card-accents.css](public/css/card-accents.css) | `.card--<key> { --card-accent: var(--card-accent-<key>); }` — SSoT für Karten-Akzentfarben (alle Karten). |
| [chat.css](public/css/chat.css) | Seiten-/Buch-Chat. |
| [search.css](public/css/search.css) | Volltext-Suche, Buchwahl. |
| [tokens-est.css](public/css/tokens-est.css) | Token-Schätzung Inline-Badges + Tooltip. |
| [landing.css](public/css/landing.css) | Landing-/Register-/Login-Seiten (kein SPA-Bundle). |

### tokens/ (Custom-Properties)
| File | Inhalt |
|------|--------|
| [tokens/colors.css](public/css/tokens/colors.css) | Farb-Tokens Light (`:root`) + Dark (`:root[data-theme="dark"]`). Inkl. `--color-text` + `--color-muted` + `--color-subtle` + `--color-faint`, Status-Achsen (content-severity + operational), `--card-accent-*`-Hues. |
| [tokens/typography.css](public/css/tokens/typography.css) | `--font-sans` / `--font-serif`, `--font-size-xs/sm/base/md/lg/xl/2xl`, `--fw-*`, `--lh-*`, Control-Sizes. |
| [tokens/spacing.css](public/css/tokens/spacing.css) | `--space-*` (4px-Raster), `--pad-*`, `--border-*`, `--radius-sm/-md/-lg` (0/2/4). |
| [tokens/motion.css](public/css/tokens/motion.css) | `--transition-*`, `--shadow-*`, `--opacity-*` + `prefers-reduced-motion`-Override. |
| [tokens/scale.css](public/css/tokens/scale.css) | `--z-*` Stack. |

### layout/ (Foundation)
| File | Inhalt |
|------|--------|
| [layout/base.css](public/css/layout/base.css) | Reset, `h1`-`h3`, `.skip-link`. |
| [layout/layout-base.css](public/css/layout/layout-base.css) | `.session-banner`, `.dev-banner` (oben fixed). |
| [layout/twocolumn.css](public/css/layout/twocolumn.css) | `.layout` / `-sidebar` / `-main` (Editor-Layout). |
| [layout/utilities.css](public/css/layout/utilities.css) | `.list-header`, Job-Queue-Footer, `.palette-badge`, `.row` Flexbox-Utility, `.batch-status`. |
| [layout/safari-fallback.css](public/css/layout/safari-fallback.css) | Safari < 16.2 `color-mix()`-Fallbacks via `@supports not (...)`. **Wichtig: muss spät in der Cascade geladen werden** (Override-Wirkung), darum eigenes File und nicht in andere Datei gemergt. |

### components/ (geteilt)
| File | Inhalt |
|------|--------|
| [components/card-form.css](public/css/components/card-form.css) | `.card`, `.card-header*`, `.card-actions*`, `.btn-card-close`, `.card-form-*` Grid, Form-Wertspalten, Combobox-Klassen, `cardFadeIn`, `.token-setup-*` First-Run-Modal. |
| [components/buttons-badges.css](public/css/components/buttons-badges.css) | `<button>` Hierarchie, `.badge-*`, `.avatar-*`, `.btn-bookstack-link`, `.btn-group`, `.btn-compact`. |
| [components/tabs.css](public/css/components/tabs.css) | `.tabs` / `.tabs-btn` + `--active`/`--scrollable`/`--fullwidth`. |
| [components/confirm-dialog.css](public/css/components/confirm-dialog.css) | `.confirm-overlay` / `-dialog`, Shortcuts-Overlay. |
| [components/icons.css](public/css/components/icons.css) | `.icon`-Klasse, SVG-Sprite-Konsumenten. |
| [components/job-toast.css](public/css/components/job-toast.css) | `.job-toast` (Job-Done-Floater). |
| [components/user-chip.css](public/css/components/user-chip.css) | User-Avatar-Chip. |
| [components/feature-tiles.css](public/css/components/feature-tiles.css) | Palette (Hero/Overlay/Panel/Item), Quick-Pills. |
| [components/tooltip.css](public/css/components/tooltip.css) | `.tip-layer` / `.tip-bubble` / `.tip-arrow` für `[data-tip]`. |
| [components/folder-import.css](public/css/components/folder-import.css) | Folder-Import-Karte (Drop-Zone, Mode-Toggle, Progress, Result). |

### page/
| File | Inhalt |
|------|--------|
| [page/page-list.css](public/css/page/page-list.css) | Seiten-Liste in Sidebar, `.tok-stats`, `.tok-totals`. |
| [page/page-view.css](public/css/page/page-view.css) | `.page-content-view` Reading-Frame, Callouts, Marginalia-Stripe. |
| [page/page-revision-viewer.css](public/css/page/page-revision-viewer.css) | Page-Revision-Diff-Viewer. |
| [page/tree-history.css](public/css/page/tree-history.css) | Sidebar-Tree, `.history-*`, `.history-chevron`. |

### editor/
| File | Inhalt |
|------|--------|
| [editor/book-editor.css](public/css/editor/book-editor.css) | Editor-Card-Layout (Toolbar, Bubble-Bar, Slash-Menu-Container). |
| [editor/focus-mode.css](public/css/editor/focus-mode.css) | Fokus-Modus, Save-Indicator, Caret-Pulse. |
| [editor/edit-toolbar.css](public/css/editor/edit-toolbar.css) | `.edit-bubble-toolbar`, `.edit-slash-menu`. |
| [editor/find-replace.css](public/css/editor/find-replace.css) | `.edit-find*`. |
| [editor/synonym-menu.css](public/css/editor/synonym-menu.css) | Synonym-Kontextmenü + Picker. |
| [editor/synonyme.css](public/css/editor/synonyme.css) | Synonyme-Karten-Stile (Listen). |
| [editor/figur-lookup.css](public/css/editor/figur-lookup.css) | `.figur-lookup` Popover. |
| [editor/lektorat.css](public/css/editor/lektorat.css) | `.lektorat-mark`, Findings-Flash, Hover-Sync. |
| [editor/findings.css](public/css/editor/findings.css) | `.finding` / `.stilbox`. |

### entities/
| File | Inhalt |
|------|--------|
| [entities/figuren.css](public/css/entities/figuren.css) | Figuren-Karte (Graph, Familie, Soziogramm). |
| [entities/figur-werkstatt.css](public/css/entities/figur-werkstatt.css) | Figuren-Werkstatt (Mindmap, Drafts-Sidebar, Read-only-Tree). |
| [entities/szenen.css](public/css/entities/szenen.css) | Szenen-Karte. |
| [entities/ideen.css](public/css/entities/ideen.css) | Ideen-Karte. |
| [entities/entity-list.css](public/css/entities/entity-list.css) | `.entity-list` / `-row`, `.severity-tag*`, `.collapsible-*`, Skeleton, `.ort-*` Schauplätze. |

### analysis/
| File | Inhalt |
|------|--------|
| [analysis/analysis.css](public/css/analysis/analysis.css) | `.section-heading*`, JS-generated Output-Stile. |
| [analysis/heatmap.css](public/css/analysis/heatmap.css) | `.heatmap-*` Tabelle + Detail-Drawer. |
| [analysis/kontinuitaet.css](public/css/analysis/kontinuitaet.css) | Kontinuitätsprüfung + Buch-Einstellungen-Spezifika. |
| [analysis/komplett-status.css](public/css/analysis/komplett-status.css) | Komplettanalyse-Status-Header. |
| [analysis/zeitleiste.css](public/css/analysis/zeitleiste.css) | Globaler Zeitstrahl. |
| [analysis/kapitel-review.css](public/css/analysis/kapitel-review.css) | Kapitel-Review. |

### admin/
| File | Inhalt |
|------|--------|
| [admin/admin-home.css](public/css/admin/admin-home.css) | Admin-Übersicht. |
| [admin/admin-settings.css](public/css/admin/admin-settings.css) | Admin-Settings-Form. |
| [admin/admin-usage.css](public/css/admin/admin-usage.css) | Admin-Usage-Dashboard. |
| [admin/admin-users.css](public/css/admin/admin-users.css) | Admin-Users-Tabelle. |

### book/
| File | Inhalt |
|------|--------|
| [book/book-create-modal.css](public/css/book/book-create-modal.css) | Buch-Anlage-Modal. |
| [book/book-settings.css](public/css/book/book-settings.css) | Buch-Einstellungen Job-Stats-Tabellen. |
| [book/header-actions.css](public/css/book/header-actions.css) | `.header-actions`-Cluster, Update-All-Panel. |
| [book/buchorganizer.css](public/css/book/buchorganizer.css) | Buch-Organisations-Karte. |
| [book/export.css](public/css/book/export.css) | Buch-Export. |
| [book/pdf-export.css](public/css/book/pdf-export.css) | PDF-Export-Profile + Tabs. |

### book-overview/ (dichtes Tile-Grid)
[coverage.css](public/css/book-overview/coverage.css), [domain.css](public/css/book-overview/domain.css), [kapitel.css](public/css/book-overview/kapitel.css), [presence.css](public/css/book-overview/presence.css), [recent-actions.css](public/css/book-overview/recent-actions.css), [stats.css](public/css/book-overview/stats.css), [base.css](public/css/book-overview/base.css), [review.css](public/css/book-overview/review.css) — pro Tile-Familie ein File.

---

## Naming-Konventionen

Project mixt zwei Schemata. Beide sind erlaubt, aber pro Komponente konsistent.

**BEM-light** für Komponenten mit Modifiern: `.block`, `.block-element`, `.block--modifier`. Beispiele: `.card`, `.card-header`, `.card-form-row--top`, `.tabs-btn--active`.

**Flat** für kleine Utility-Klassen ohne Modifier-Bedarf: `.row`, `.muted-msg`, `.spinner`. Beispiele: `.list-header`, `.form-stack`.

**Anti-Patterns:**
- `.tabs-btn-count-active` ❌ — Modifier per `--active`-Suffix nicht durch Konkatenation. Richtig: `.tabs-btn--active .tabs-btn-count`.
- Camel-Case-Klassen (`.cardForm`) ❌ — kebab-case Pflicht.
- Doppel-Element (`.card-header-title-text`) ❌ — bei mehr als zwei Element-Stufen Refactor zu Sub-Komponente erwägen.

**Präfix-Konventionen pro Domain:**
- `card-`, `card-form-` — Karten-Form-Geometrie (geteilt)
- `tabs-`, `entity-`, `palette-`, `tree-`, `history-`, `heatmap-`, `finding-` — geteilte Komponenten
- `editor-`, `edit-`, `lektorat-`, `figur-`, `chat-` — Editor-Slices
- `overview-` — Book-Overview-Tiles
- `pdfx-` — PDF-Export-spezifisch (kurz, weil viele Sub-Klassen)
- `book-settings-` — Buch-Einstellungs-spezifische Klassen (Danger-Zone, Locale, Options) — generische Form-Klassen heissen `card-form-*`.

---

## Modal-Wrapper (generisches Pattern)

**Status:** Aktuell **kein generisches Modal-Wrapper-Pattern**. Mehrere Modal-artige Overlays existieren parallel:
- `.confirm-overlay` + `.confirm-dialog` ([confirm-dialog.css](public/css/components/confirm-dialog.css))
- `.shortcuts-overlay` + `.shortcuts-panel` ([confirm-dialog.css](public/css/components/confirm-dialog.css))
- `.palette-overlay` + `.palette-panel` ([feature-tiles.css](public/css/components/feature-tiles.css))
- `.token-setup-*` ([card-form.css](public/css/components/card-form.css))

Jedes hat eigenen Backdrop, eigene Close-Logik, eigenen Focus-Trap. Drift-Risiko hoch.

**Wann konsolidieren:** Sobald ein fünfter Konsument auftaucht, oder ein Bug zeigt, dass eine Variante z.B. Esc nicht behandelt während andere es tun.

**Vorgesehenes Konsolidat:**
```html
<div class="modal-overlay" role="dialog" aria-modal="true">
  <div class="modal-panel modal-panel--md">…</div>
</div>
```
- `.modal-overlay` — Backdrop + Position-Fixed + `--z-modal`
- `.modal-panel` — zentriertes Panel mit `--shadow-lg`
- Modifier `--sm/-md/-lg` für Breite (480/720/960)

Bestehende Confirm/Shortcuts/Palette/Token-Setup würden darauf migrieren, behalten aber ihre eigenen Inhalts-Klassen (`.confirm-dialog-message`, `.palette-list`, etc.).

**Bis dahin:** Neue Modale orientieren sich an `.confirm-overlay` (am vollständigsten dokumentiert) und kopieren die Geometrie statt eigene zu erfinden.

---

## Loading-Overlay

**Status:** Kein generisches Pattern. Loading-Indikatoren existieren als:
- Inline-`.spinner` neben Button-Label (Standard für Buttons während async-Action)
- `.card-status` mit Text + `.progress-bar-wrap`
- Skeleton-Loader (`.entity-skeleton*` / `.chat-skeleton-*`)

**Wann anlegen:** Sobald jemand „kompletter Kartenüberlay während Refresh" braucht (aktuell behandelt jede Karte das via `x-show`-Toggling auf Inhalt + `.card-status` daneben).

**Soll-Pattern (wenn nötig):**
```html
<div class="card-loading-overlay" x-show="loading" aria-busy="true">
  <span class="spinner" aria-hidden="true"></span>
</div>
```
Position: absolute innerhalb `.card`, `background: var(--color-surface) / 0.7` mit Backdrop-Blur. `aria-busy="true"` auf Karte oder Overlay.

---

## Empty-State mit CTA

**Status:** Aktiv (eingeführt mit Figuren-Werkstatt). Klassen leben in [card-form.css](public/css/components/card-form.css). Verwenden, wann immer eine Karte „Keine Daten — hier der Button um welche zu erzeugen" rendert (z.B. leere Findings, leere Figuren-Liste).

**Markup:**
```html
<div class="card-empty">
  <p class="card-empty-text" x-text="$app.t('feature.empty.title')"></p>
  <p class="card-empty-hint" x-text="$app.t('feature.empty.hint')"></p>
  <button class="primary" @click="…" x-text="$app.t('feature.empty.cta')"></button>
</div>
```
- `.card-empty` — flex-column, zentriert, Padding `--space-2xl --space-lg` (Mobile: `--space-xl --space-md`)
- `.card-empty-text` — semantischer Hauptsatz, `--font-size-md`, `--fw-medium`
- `.card-empty-hint` — 12 px muted Erklärung, `max-width: 32em`
- Button ist Standard `.primary` — kein eigener Empty-CTA-Stil

Wenn die Karte zusätzlich Inline-Inputs braucht (z.B. „Neue Figur — Name eingeben"), `.card-empty` als Container für Input + Button-Row mit `.row` weiternutzen — siehe [public/partials/figur-werkstatt.html](public/partials/figur-werkstatt.html).

---

## Inline-Action-Group

**Status:** Kein Standard. Patterns wie „Mehr anzeigen / Alle ausklappen / Filter zurücksetzen" als Link-Reihe nach Listen werden ad-hoc gebaut.

**Soll-Pattern (wenn jemand Bedarf hat):**
```html
<div class="inline-actions">
  <button type="button" class="link-btn" @click="…">Alle ausklappen</button>
  <span class="inline-actions-sep">·</span>
  <button type="button" class="link-btn" @click="…">Filter zurücksetzen</button>
</div>
```
- `.inline-actions` — flex row, `gap: var(--space-sm)`, `font-size: var(--font-size-sm)`
- `.link-btn` — Button-Reset auf Text-Link (color: var(--color-primary), Hover: underline)
- `.inline-actions-sep` — `·` als Separator (entspricht Mikro-Typografie-Regel: gleichwertige Items mit `·`, nicht `:`)

---

## Keyboard-Shortcut-Anzeige (`<kbd>`)

**Use:** Tasten anzeigen (Hotkeys, Help-Overlay, Palette-Hero).

**Markup:** Native `<kbd>` mit globalem Reset in [base.css](public/css/layout/base.css):
```html
Shortcut: <kbd>⌘</kbd>+<kbd>K</kbd>
```

**Klasse-Stil** existiert pro Konsument: `.palette-hero-kbd`, `.palette-mode-pill kbd`. Globaler Reset ist gesetzt — neue Konsumenten erben automatisch und überschreiben nur, wenn nötig.

---

## Pattern-Matrix (Karte → Pattern)

Welche Karte verwendet welche Patterns. Drift-Erkennung: wer auf der gleichen Zeile fehlt obwohl er sollte, verwendet wahrscheinlich Reinvention.

| Karte | `.card` | Form | Tabs | Combobox | Entity-List | Heatmap | Findings | Filter-Bar |
|-------|:------:|:----:|:----:|:--------:|:-----------:|:-------:|:--------:|:----------:|
| BookOverview | ✓ | — | — | — | — | — | — | — |
| BookReview | ✓ | — | — | — | — | — | — | — |
| KapitelReview | ✓ | — | — | — | — | — | — | — |
| Figuren | ✓ | — | ✓ | — | ✓ | — | — | ✓ |
| FigurWerkstatt | ✓ | ✓ | — | ✓ | — | — | — | — |
| Orte | ✓ | — | — | — | ✓ | — | — | ✓ |
| Szenen | ✓ | — | ✓ | ✓ | ✓ | — | — | ✓ |
| Ereignisse | ✓ | — | — | ✓ | ✓ | — | — | ✓ |
| Kontinuität | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| BookStats | ✓ | — | — | — | — | — | — | — |
| Stil | ✓ | — | ✓ | — | — | ✓ | — | — |
| FehlerHeatmap | ✓ | — | ✓ | — | — | ✓ | — | — |
| BookSettings | ✓ | ✓ | — | ✓ | — | — | — | — |
| UserSettings | ✓ | ✓ | — | ✓ | — | — | — | — |
| FinetuneExport | ✓ | ✓ | — | ✓ | — | — | — | — |
| PdfExport | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| Ideen | ✓ | — | — | ✓ | ✓ | — | — | ✓ |
| Chat (Seite) | ✓ | — | — | — | — | — | — | — |
| BuchChat | ✓ | — | — | — | — | — | — | — |
| Editor (Findings) | ✓ | — | — | — | ✓ | — | ✓ | — |
| PageHistory | ✓ | — | — | — | — | — | — | — |
| Palette | (Modal) | — | — | — | ✓ | — | — | ✓ |

**Audit-Hinweis:** Wer eine neue Karte oder ein neues Pattern einführt, fügt hier Spalte/Zeile + Häkchen hinzu. Nicht nur Existenz prüfen — auch ob die Karte die geteilte Klasse benutzt oder eigenes Vokabular pflegt.

---

## Relative z-index (lokal-stack-Werte)

Werte 1, 2, 5, 10, 20, 50 in [heatmap.css](public/css/analysis/heatmap.css), [lektorat.css](public/css/editor/lektorat.css), [twocolumn.css](public/css/layout/twocolumn.css), [search.css](public/css/search.css), [book-overview/](public/css/book-overview/) sind **lokal-relativ** und gehören NICHT in den globalen Stack:
- Heatmap: sticky-thead (1) und sticky-rowhead (2) innerhalb der Tabelle
- Lektorat-Marks: Findings-Flash (50) über In-Place-Markierungen
- Twocolumn: Resize-Handle (5) über Sidebar-Content
- Book-Overview-Tiles: SVG-Layering innerhalb Tile

Diese Werte bleiben hartcoded mit Kommentar `/* lokal-relativ, kein globaler Stack-Tier */` in der Nähe. Wer sie migriert, durchbricht die lokale Stack-Logik.

Im globalen Stack (siehe [Z-Index-Stack](#z-index-stack)) steht alles, was per `position: fixed` oder gegen andere Komponenten konkurriert.

---

## Tooling: stylelint-Skizze

**Status:** Aktuell nicht eingerichtet. Skizze für späteren Setup:

```json
{
  "rules": {
    "declaration-property-value-disallowed-list": {
      "z-index": ["/^[0-9]+$/"],
      "/^font-weight$/": ["/^[0-9]+$/"],
      "/^transition-duration$/": ["/^[0-9.]+m?s$/"]
    },
    "declaration-property-value-allowed-list": {
      "/^z-index$/": ["/^var\\(--z-/", "/^[1-5]$/"]
    },
    "color-no-hex": true,
    "color-named": "never",
    "custom-property-pattern": "^[a-z][a-z0-9-]+$"
  }
}
```

Was es prüft:
- z-index muss `var(--z-*)` oder lokal-relative 1-5 sein
- font-weight muss Token sein, nicht Zahl
- transition-duration muss Token sein, nicht Literal
- Hex-Farben verboten, immer Token
- Custom-Property-Naming einheitlich kebab-case

Setup-Aufwand: ~1 Stunde (`npm i -D stylelint stylelint-config-standard` + `.stylelintrc.json` + npm-Script). Aktuelle Codebase würde initial ~50-100 Verstöße melden — die meisten Migrationskandidaten, einzelne Ausnahmen via `/* stylelint-disable-next-line */`.

Nicht in scope für DESIGN.md-Refactor — separater Task wenn gewünscht.

---

## Wartung

Wer ein neues Pattern einführt:
1. Gibt es schon eines, das passt? → wiederverwenden.
2. Wirklich neu? → hier dokumentieren (Markup-Snippet + CSS-Datei + Use-Case) und im **Inhalt**-Abschnitt oben verlinken.
3. Doku-Template (oben) eingehalten? Use → Markup → Klassen → Regeln → Beispiele.
4. SHELL_CACHE in [public/sw.js](public/sw.js) bumpen (CSS/JS-Änderung).
5. i18n-Strings in beide Locales eintragen (CLAUDE.md-Regel).
6. Mobile-Breakpoints im selben Commit (CLAUDE.md-Regel).
7. Spacing/Padding/Schatten/Transition aus Tokens (`--space-*`, `--pad-*`, `--shadow-*`, `--transition-*`) — keine ad-hoc Pixel-Werte ohne Begründung.
8. `prefers-reduced-motion`-Override gesetzt (sofern Animation/Transition mit Bewegung)?
9. A11y-Attribute (`aria-*`, `role`, Focus-Trap bei Modal, `aria-invalid` bei Inputs) gesetzt?
10. Z-Index über Token aus tokens.css gesetzt (kein hartcoded Wert)?
11. Container-Query vs. Media-Query bewusst gewählt (siehe Section)?
12. Eigene URL für die neue Hauptansicht im [Hash-Router](#routing--deep-links-url-pflicht) (View-Slug + Apply-Zweig + Selektion + Watcher + Test)?
