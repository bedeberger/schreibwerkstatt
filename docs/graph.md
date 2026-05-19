# Figuren-Graph

Drei Render-Modi auf einer vis-network-Instanz: Figurengraph (Kapitel-Swimlane), Familie (hierarchischer Baum), Soziogramm (Sozialschicht-Bands). Modus-Toggle ohne Page-Reload, kein Re-Fetch der Figuren — alle Modi lesen aus `window.__app.figuren`.

Code: [public/js/graph.js](../public/js/graph.js) (Facade) + [public/js/graph/](../public/js/graph/) (Slices). Eingehängt in [public/js/cards/figuren-card.js](../public/js/cards/figuren-card.js) via `...graphMethods` im `Alpine.data`-Pool.

## Modul-Layout

| Slice | Verantwortung |
|-------|---------------|
| `graph/constants.js` | `DEFAULT_FONT`, `nodeLabel`, `SCHICHT_COLOR`, `SCHICHT_LEVEL`, `BZ` (Edge-Styles Figurengraph), `BZ_SOZIO_COLOR`/`BZ_SOZIO_CAT` (Soziogramm), `DIRECTED_TYPES`. |
| `graph/core.js` | Mode-Switch (`setFigurenGraphModus`), Fullscreen-Toggle, Render-Dispatcher (`renderFigurGraph`), Hash-Cache, vis-Lazy-Load. |
| `graph/shared.js` | `_figTypColor`, `_figurenGraphSetKapitel` (Kapitel-Filter dim/highlight), `_buildEdges` (gemeinsame Edge-Liste mit Dedup), `_attachTooltip` (Hover-Tooltip mit Escape). |
| `graph/figurengraph.js` | Kapitel-Swimlane (deterministisch, ohne Physics). |
| `graph/familiengraph.js` | Hierarchischer Baum, nur Familien-Edges (elternteil/kind/geschwister). |
| `graph/soziogramm.js` | Sozialschicht-Bands, Macht-Sortierung innerhalb Schicht. |

## State auf der Card

```js
figurenGraphModus       // 'figur' | 'familie' | 'soziogramm'
figurenGraphKapitel     // String | null — gewähltes Kapitel-Filter
figurenGraphFullscreen  // Boolean
_figurenNetwork         // vis.Network — wird im destroy()/onBookChanged geräumt
_figurenHash            // String — Cache-Key (kapSig + Modus + Locale)
_figurenNodes           // vis.DataSet
_figurenEdges           // vis.DataSet
```

`destroy()` und `onBookChanged` rufen `_figurenNetwork.destroy()` und nullen die Refs.

## Render-Dispatch (`core.js#renderFigurGraph`)

```
container vorhanden?           → sonst no-op
vis geladen?                   → sonst loadVis() (lazy-libs), Placeholder währenddessen
hash = kapSig + modus + locale → match? no-op
network destroyen + null'en
figuren leer?                  → Placeholder, return
modus switch:
  'soziogramm' → _renderSoziogramm
  'familie'    → _renderFamiliengraph
  default      → _renderFigurengraph
falls figurenGraphKapitel → rAF → _figurenGraphSetKapitel
```

`kapSig` ist `figId:k1Name+k1Häufigkeit,k2Name+…|figId:…` — derselbe Cache-Key erkennt Kapitel-Häufigkeits-Drift, ignoriert aber irrelevante Felder. Locale ist Teil des Keys, weil Labels (Tier-Pills, Schicht-Labels, Tooltips) lokalisiert sind.

## Modi

### Figurengraph (Kapitel-Swimlane)

Deterministisches Layout, kein Physics:

- **X = narrative Kapitel-Achse.** Jede Figur landet auf dem **gewichteten Mittel** ihrer Kapitel-Indizes (`weight = häufigkeit^1.5`). Damit ziehen häufige Auftritte stärker.
- **Y = Tier (Figurentyp).** Reihenfolge: `hauptfigur, antagonist, mentor, nebenfigur, randfigur, andere`. Nur belegte Tiers werden gerendert.
- **Greedy-Stapelung innerhalb Tier.** Figuren landen am tatsächlichen X-Schwerpunkt (kein Binning). Mindestabstand `MIN_DX = 130`. Wenn unterer Slot belegt, geht es eine Zeile (`ROW_H = 50`) nach unten. Jedes Tier reserviert genau so viel vertikalen Platz wie es Stapelzeilen hat — Nebenfiguren-Stapel ragen nie ins nächste Tier.
- **Spaltenbreite adaptiv:** `COL_W = clamp(160, 440, containerW / max(N, 4))`. Floor verhindert, dass bei 30+ Kapiteln eine 16k-Canvas entsteht, in die `fit()` winzige Nodes hineinzoomt.
- **Border-Width = Wichtigkeit:** `1 + round(log2(Σ häufigkeiten))`, clamped auf 4.

Custom-Canvas-Overlays via `beforeDrawing`/`afterDrawing`:

1. **Kapitel-Spalten** in Netzwerk-Koordinaten (zoomen mit). Alternierende Fillstyle für Streifen, dünne Trennlinien.
2. **Kapitel-Header oben** in Screen-Koordinaten (feste Lesegrösse, folgen Pan). **Adaptive Schriftgrösse** (11–18 px) skaliert mit Canvas-Höhe. **Adaptive Stride:** bei dicht gezoomten Spalten wird nur jeder n-te Header gezeichnet (`step = ceil(70 / pxPerCol)`), letzter Header immer (Orientierung). **Adaptive Truncation:** Labels werden bei kleineren Canvas auf 34 Zeichen gekürzt, bei höheren auf 60.
3. **Tier-Labels links** in Screen-Koordinaten. Pill-Hintergrund (`roundRect` mit Fallback für ältere Browser).
4. **Presence-Bar unter jeder Node** in Netzwerk-Koordinaten. Segment pro Kapitel; Alpha skaliert mit Häufigkeit (`0.35 + h/5`, clamped 1). Min-Breite skaliert mit N (`min(220, max(70, N*3))`).

**Click auf Kapitel-Header** (`pointer.canvas.y > Y_TOP + 60`) → Filter setzen/togglen via `_figurenGraphSetKapitel`.

**`fit()` auf Node-IDs** statt Canvas-Bounding-Box: leere Kapitel-Spalten würden die BBox aufblähen → Nodes mikroskopisch.

### Familiengraph

Filtert Edges auf `['elternteil', 'kind', 'geschwister']`, rendert nur die beteiligten Nodes. Layout: `hierarchical { direction: 'UD', sortMethod: 'directed' }` mit `hierarchicalRepulsion`-Solver. Nach `stabilizationIterationsDone` werden Positionen persistiert + Physics + hierarchisches Layout deaktiviert (User kann frei verschieben).

Wenn keine Familien-Edges existieren → Placeholder (`graph.empty.familie`).

### Soziogramm

- **Y-Position = Sozialschicht-Level** (`SCHICHT_LEVEL`: Wirtschaftselite=0 ↓ Unterwelt=6, `andere=2`).
- **Sortierung innerhalb Schicht = Macht.** `powerScore(f) = Σ -bz.machtverhaltnis`. Konvention: `bz.machtverhaltnis > 0` heisst, das Gegenüber dominiert; negiert ergibt die eigene Macht. Höhere Macht → kleinerer Y-Offset im Band (oben).
- **X = Rang innerhalb der Schicht**, zentriert: `(idx - (cnt-1)/2) * NODE_X_GAP`.
- **`fixed: { x: false, y: true }`** — Schicht-Reihe fixiert; horizontal löst Physics (`repulsion`-Solver) Überlappungen.
- Nach `stabilizationIterationsDone` → Physics aus (User-Drags bleiben stehen).

Custom-Overlay (`beforeDrawing`):
- **Schicht-Bands** in Netzwerk-Koordinaten (farbiger Streifen, dashed Trennlinie unten).
- **Schicht-Labels links** in Screen-Koordinaten (Pill-Hintergrund, lokalisiert via `figuren.schicht.<key>`).

Guard: keine Figur hat eine echte `sozialschicht` (alle `null`/`andere`) → Placeholder, kein leerer Graph.

## Edge-Bau (`shared.js#_buildEdges`)

Gemeinsam für Figurengraph + Soziogramm. Dedupliziert über Pair-Key:

- **Directed-Types** (`elternteil, kind, mentor, schuetzling, patronage`): Key = `from|to|typ` (Richtung zählt).
- **Andere Typen:** Key = `sorted(from,to)|typ` (ungerichtet).

Soziogramm-spezifisch: **Edge-Width skaliert mit Machtverhältnis** (`1 + |macht|*1.5`). Arrows: `macht > 0` → `to`, `< 0` → `from`, `= 0` & directed → Standard-Arrow aus `BZ`, sonst keine. Kategorie-Farbe aus `BZ_SOZIO_CAT` → `BZ_SOZIO_COLOR`.

Figurengraph-Modus: Style aus `BZ`-Tabelle (Farbe, Highlight, Arrows, Dashes).

## Kapitel-Filter (`_figurenGraphSetKapitel`)

Greift nach dem initialen Render. Mutiert nur Node-Color/Font + Edge-Color via `DataSet.update` — kein Re-Layout, keine Stabilisierung. Figuren, deren `kapitel`-Liste das gewählte Kapitel **nicht** enthält, werden grau dimmt (Background `#efefef`, Border `#ccc`, Font `#bbb`). Edges werden gedimmt, wenn weder `from` noch `to` aktiv sind.

Modus-aware: im Soziogramm-Modus bleibt die Schichtfarbe (`SCHICHT_COLOR`), sonst Typ-Farbe (`_figTypColor`). Edge-Farben kommen aus `BZ_SOZIO_COLOR` (Soziogramm) bzw. `BZ` (Figurengraph).

## Tooltip (`_attachTooltip`)

Hängt am `#figur-tooltip`-Element. Listener: `hoverNode`/`blurNode`, `hoverEdge`/`blurEdge`. Positionierung berücksichtigt Container-Bounds (`offsetWidth`/`offsetHeight`) und flippt das Tooltip nach links/oben, wenn es rechts/unten überlaufen würde.

**XSS-Escape-Invariante:** `escHtml()` für jeden eingesetzten Wert (Figurnamen, Beschreibungen, Schicht-/Typ-Labels). Template-Strings setzen Markup-Wrapper, alle Datenwerte vorher escaped.

## Fullscreen

`toggleFigurenGraphFullscreen` versucht zuerst `toggleWrapFullscreen` (Fullscreen-API auf dem `.figuren-graph-wrap`-Element). Bei Fehler fällt es auf einen Klassen-Toggle (`figurenGraphFullscreen`-Flag) zurück; danach `resize`-Event + `network.fit()` mit Easing.

## Pflicht-Invarianten

- **vis-Lazy-Load:** `_renderXxx` setzt `loadVis()` voraus. `renderFigurGraph` checkt `window.vis` und lädt bei Bedarf, mit Placeholder.
- **`escHtml` für jeden User-/KI-Wert** in Tooltips + Placeholder-Strings. `container.innerHTML` mit raw `t()`-Output wäre unsicher (Übersetzungen sind statisch, aber Konvention im Repo zwingt Escape überall).
- **Network destroyen vor Re-Render.** `renderFigurGraph` cleant `_figurenNetwork` vor Neu-Erzeugung; Card-Lifecycle (`onBookChanged`, `destroy`) ebenso.
- **Hash-Cache prüft Kapitel-Häufigkeits-Signatur**, nicht nur Figurenanzahl — Modus-Switches und Locale-Wechsel erzwingen Re-Render.
- **`fit()` nimmt Node-IDs**, nicht Canvas-Bounding-Box (Figurengraph hat sonst leere Spalten am Rand).
- **Soziogramm fixiert Y**, Figurengraph läuft komplett ohne Physics (User-Drags bleiben stehen), Familiengraph deaktiviert Physics nach Stabilisierung.

## Neuen Modus hinzufügen

1. Slice anlegen (`graph/<name>.js`), `_render<Name>(container)`-Methode exportieren.
2. In `graph.js`-Facade spreaden.
3. In `core.js#renderFigurGraph` Modus-Switch ergänzen.
4. UI-Toggle in `partials/figuren.html` + `figurenGraphModus`-Werte-Set in `figuren-card.js`.
5. `_figurenNodes` + `_figurenEdges` setzen — Kapitel-Filter (`_figurenGraphSetKapitel`) liest sie und passt seinen Modus-Branch entsprechend an (ggf. `else if` ergänzen).
6. Wenn eigene Canvas-Overlays: `beforeDrawing`/`afterDrawing` (Pflicht-Trennung: Netzwerk-Koordinaten vs. Screen-Koordinaten via `setTransform(1,0,0,1,0,0)`).
7. Tooltip via `this._attachTooltip(container)` aus shared.

## Neuer Beziehungstyp

Kein Schemawechsel (`figure_relations.typ` ist Freitext). Pflicht:

1. `BZ` in `constants.js` ergänzen — Farbe, Highlight, Arrow-Richtung, Dashes.
2. `BZ_SOZIO_CAT` zuordnen (Kategorie für Soziogramm-Farbe).
3. `DIRECTED_TYPES` ergänzen, wenn der Typ **gerichtet** ist (sonst landet `(A→B, freund)` und `(B→A, freund)` als zwei separate Edges statt einer).
4. KI-Prompt: `FIGUREN_BASIS_SCHEMA` in [public/js/prompts/komplett.js](../public/js/prompts/komplett.js).
5. i18n: `figuren.bz.<typ>` in beide Locales.
