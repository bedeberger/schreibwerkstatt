# Ideen: Stufen, Board und Verknüpfungen

Ideen sind in diesem Haus zweierlei: eine **mögliche Fortsetzung** („hier könnte
die Schwester auftauchen") und eine **Pendenz** an einer Stelle im Text („Beleg
nachtragen, Zeitangabe prüfen"). Beides hängt an genau einem Anker — einer Seite
**oder** einem Kapitel (XOR-CHECK in `ideen`).

Zwei Oberflächen, dieselben Zeilen:

| | Ideen-Karte | Ideen-Board |
|---|---|---|
| Frage | Was ist an **dieser** Stelle offen? | Was ist im **ganzen Buch** offen, und wie weit? |
| Ort | neben dem Editor bzw. neben der Kapitelbewertung | eigene Hauptkarte (exklusiv) |
| Scope | eine Seite ODER ein Kapitel | ein Buch |
| Code | [cards/ideen-card.js](../public/js/cards/ideen-card.js), [book/ideen.js](../public/js/book/ideen.js) | [cards/ideen-board-card.js](../public/js/cards/ideen-board-card.js), [book/ideen-board/](../public/js/book/ideen-board/) |
| Partial | [ideen.html](../public/partials/ideen.html) | [ideen-board.html](../public/partials/ideen-board.html) |
| Route | `GET /ideen?page_id=` / `?chapter_id=` | `GET /ideen/board?book_id=` |

Geteilt: die Stufen-SSoT ([ideen-shared.js](../public/js/book/ideen-shared.js) /
[lib/ideen-status.js](../lib/ideen-status.js)), die Verknüpfungs-Methoden
([ideen-links.js](../public/js/book/ideen-links.js)) und das Chip-Markup
([ideen-link-chips.html](../public/partials/ideen-link-chips.html)).

**User-privat.** `ideen.user_email` ist Sichtbarkeits-Scope, nicht Attribution —
auf einem geteilten Buch sieht jeder sein eigenes Brett. Das ist der Unterschied
zu `research_items`, die buchweit geteilt sind, und er wird an genau einer Stelle
durchgesetzt: **jede** Lesung in [db/ideen.js](../db/ideen.js) trägt `user_email`.

---

## 1 · Die Stufen-Achse

`ideen.status`: **offen → in_arbeit → erledigt**, daneben **verworfen**.
SSoT [lib/ideen-status.js](../lib/ideen-status.js), Frontend-Spiegel
[ideen-shared.js](../public/js/book/ideen-shared.js), Drift gegated in
[tests/unit/ideen-status.test.mjs](../tests/unit/ideen-status.test.mjs).

**Eine Spalte, ein CHECK.** Es gibt kein `erledigt`-Flag daneben: zwei Wahrheiten
über dieselbe Frage lösen sich nicht auf (`erledigt = 1` neben
`status = 'verworfen'`), und der nächste Schreibpfad setzt garantiert nur eine
von beiden. `status_at` hält fest, wann die Stufe zuletzt wechselte — ein
Content-Update bewegt ihn nicht.

**„Offen" heisst `offen` ODER `in_arbeit`** — SQL-Fragment `openStatusSql(alias)`,
damit die Zählpfade nicht jeder für sich eine `IN`-Liste schreiben. Daran hängen
drei Dinge, und in allen dreien ist `verworfen` **nicht** offen:

* die Sidebar-Plakette und `GET /ideen/counts`,
* der Ideen-Block im **Seiten-Chat** ([jobs/shared/queries.js](../routes/jobs/shared/queries.js)#`getOpenIdeen`),
* das Buch-Chat-Werkzeug `list_ideen` (`offen_only`).

**Why beim Chat:** eine verworfene Idee als Absicht des Autors vorzulegen ist die
schlechtere Halluzinationsquelle von beiden — das Modell schlägt dann genau das
vor, wogegen er sich entschieden hat. Darum nennt die Werkzeug-Beschreibung die
Stufe ausdrücklich.

**`verworfen` ist eine Stufe, kein Löschen** (dieselbe Regel wie bei
`research_items.status`). Eine gelöschte Idee verschweigt, dass man sie hatte und
gegen sie entschieden hat; genau das will man beim nächsten Durchgang nicht noch
einmal denken müssen. Der Board-Filter blendet sie aus, statt sie aus der Welt zu
nehmen — und sagt dabei, wie viele er ausblendet.

**Ein unbekannter Wert zählt als `offen`**, nicht als Fehler (`normalizeIdeeStatus`
/ `ideeStatus`): eine Zeile mit kaputtem Status ist eine ungeklärte Pendenz, keine
erledigte, und sie darf nicht aus dem Board fallen. Gleiche Regel wie `itemStatus`
im Recherche-Board.

**Ein Status-Key ist eine Persistenz-Konstante** (Spaltenwert + CHECK + i18n-Key
`ideen.status.<key>`): ergänzen ja, umbenennen nein.

**Abgeschlossen wandert nicht mehr.** Der Move (Idee auf eine andere Seite bzw.
ein anderes Kapitel) ist nur offen/in Arbeit erlaubt (`400 IDEE_CLOSED`): eine
abgeschlossene Idee ist die Spur einer Entscheidung an **dieser** Stelle;
anderswo hingehängt wäre sie eine Aussage über eine Stelle, an der sie nie stand.
Der Move bleibt ausserdem **within-kind** (Seiten-Idee nur auf eine Seite).

---

## 2 · Das Board

Ein Raster: **Zeilen sind die Anker im Buch** (Bahnen — Kapitel bzw. Seite),
**Spalten die Stufen**. Pure Rechnung in
[ideen-board/model.js](../public/js/book/ideen-board/model.js), gegated in
[tests/unit/ideen-board.test.mjs](../tests/unit/ideen-board.test.mjs).

**Die Reihenfolge der Bahnen kommt aus dem Baum**, nicht aus der Ideen-Abfrage:
`$store.nav.tree` ist die SSoT der Buch-Reihenfolge (`book_order`-Overlay), ein
`ORDER BY position` im Ideen-SQL wäre eine zweite, stillschweigend abweichende
Sortierung. Pro Kapitel entsteht zuerst die Kapitel-Bahn, danach die Bahnen seiner
Seiten; eine Solo-Seite bekommt nur ihre Seiten-Bahn (eine Kapitel-Bahn dafür wäre
eine Bahn für ein Kapitel, das es nicht gibt). Der Baum kann sich unter dem
offenen Board ändern — darum zieht ein `$watch` die Bahnen nach.

**Nur belegte Bahnen erscheinen.** Ein Board mit einer leeren Zeile je Seite des
Buches wäre unlesbar. **Ausnahme ist die Kapitel-Bahn:** sie bleibt auch ohne
eigene Ideen stehen, sobald eine ihrer Seiten welche trägt — sie ist die
Gruppen-Überschrift und der Griff, an dem das Kapitel zuklappt. Ohne sie wäre
genau das Kapitel nicht klappbar, dessen Pendenzen alle auf Seiten hängen, also
fast jedes.

**Klappen ist Ansicht, nicht Filter.** Zwei unabhängige Achsen, beide als Liste
von Bahn-Keys:

| | was sie faltet | Griff |
|---|---|---|
| `collapsedLanes` | die **Karten** einer Bahn | Chevron vor dem Bahntitel |
| `collapsedChapters` | die **Seiten-Bahnen** eines Kapitels, in dessen Zeile | „*n* Seiten" unter dem Kapiteltitel |

Sie sind getrennt, weil sie Verschiedenes beantworten („zeig das Kapitel ohne
seine Seiten" vs. „zeig die Bahn ohne ihre Notizen"). Beide liegen **pro Buch im
localStorage**, im selben Filter-Scope `ideenBoard` wie die Filterleiste
([cards/ideen-board-card.js](../public/js/cards/ideen-board-card.js),
[filter-persist.js](../public/js/filter-persist.js)) — ein eigener Scope wäre ein
zweiter Schlüssel für dieselbe Frage „wie sieht dieses Board für mich aus". Die
Listen werden immer **neu geschrieben**, nie mutiert: der Board-Memo vergleicht
seine Deps per Identität, und die Scope-Defaults sind ein geteiltes Objekt.

Die Klappung bewegt die **Filterzahlen nicht** (`visible`/`hiddenByFilter` werden
gezählt, bevor gefaltet wird) — sonst behauptete die Filterleiste, sie verstecke
etwas, das sie nicht meint. Was die Klappung verbirgt, steht stattdessen je Zeile
und Stufe als `+n` in der Zelle: dieselbe Überlegung wie beim Ausblend-Zähler.

**Nichts verschwindet still.** Eine Idee, deren Bahn der Baum (noch) nicht kennt —
Seite gerade angelegt, Baum noch nicht nachgezogen — landet in der Sammelbahn
`LANE_UNKNOWN` am Ende, statt aus dem Board zu fallen. Das Board ist eine
Pendenzenliste; eine verschwundene Pendenz ist von einer erledigten nicht zu
unterscheiden.

**Der Kapitel-Filter misst die BAHN, nicht den Anker.** Dafür liefert der Server
`lane_chapter_id` mit (für eine Seiten-Idee das Kapitel **ihrer Seite**). Nach
`chapter_id` gefiltert fände „Kapitel 3" nur die Ideen, die direkt am Kapitel
hängen — also die wenigsten.

**Zwei Haken für die zwei Schlussstufen.** `erledigt` und `verworfen` sind
getrennt ausblendbar, beide per Default aus: das Board ist eine Pendenzenliste,
und beide Stufen sollen beim Öffnen nicht mitarbeiten. Getrennt, weil sie
Verschiedenes beantworten — „fertig" und „dagegen entschieden"; wer den Stand
eines Kapitels prüft, will das Erledigte sehen, ohne das Verworfene
zurückzuholen. Ausgeblendet wird nur die Karte, nie die Spalte samt Zähler.

**Der Filter blendet aus und sagt es.** `hiddenByFilter` steht als Zahl in der
Filterleiste; ohne sie ist eine versteckte Pendenz von einer verlorenen nicht zu
unterscheiden. Die **Spalten-Zähler messen dagegen den ganzen Bestand** — sonst
zeigte die Spalte „verworfen" beim Ausblenden eine `0` und damit das Gegenteil
der Wahrheit. Aus demselben Grund filtert `GET /ideen/board` **serverseitig
nicht**: Bahnen, Spalten und Zähler rendern dieselbe Liste desselben Requests
(gleiche Regel wie die zwei Ansichten des Recherche-Boards).

**Die Kapitel-Optionen des Filters hängen nicht am Status-Filter** — sonst
verschwände die eigene Auswahl unter der Hand, sobald man `verworfen` ausblendet.

**Ein Drag trägt genau eine Aussage: den neuen Status.** Die Bahn bleibt, wie sie
ist — sie IST der Anker im Buch, und den verschiebt man nicht per Kanban-Zug quer
durchs Manuskript (dafür gibt es „Verschieben" auf der Ideen-Karte). Technisch:
SortableJS-Gruppe **pro Bahn** (`idee-lane-<key>`). Eine Reihenfolge innerhalb
einer Spalte gibt es nicht (`ideen` hat keine `sort_order`), darum wird der
DOM-Move immer zurückgenommen (`revertSortable`) und nur der Status geschrieben.
Der tastaturerreichbare Weg sind die Stufen-Knöpfe auf der Karte — **derselbe
Schreibpfad** (`setIdeeStatus`), drei Oberflächen (Board-Drag, Board-Knöpfe,
Menü der Ideen-Karte).

**Layout:** ein CSS-Grid, kein Flex-Spalten-Board wie bei der Recherche. Karten
derselben Bahn müssen über alle Spalten hinweg auf einer Linie liegen, sonst ist
die Zeile als Zusammenhang nicht mehr lesbar. Auf schmalem Container scrollt die
Fläche horizontal, statt die Zeilen-Achse aufzugeben — untereinander gestapelt
wäre genau die Aussage des Boards weg, und dann wäre die Ideen-Karte das bessere
Werkzeug.

---

## 3 · Verknüpfungen (beidseitig)

`idea_links` — Brücke von einer Idee zu einem **Recherche-Fundstück**, einem
**Plot-Beat** oder einem **Motiv**. Form ist der Zwilling von
`research_item_links`: sentinel-frei, genau eine `*_id` passend zum
`target_kind`, alle anderen NULL, partielle UNIQUE-Indexe je Ziel-Art.

**Warum eine eigene Tabelle** statt `research_item_links.target_kind` um `'idea'`
zu erweitern: die Idee besitzt ihre Verknüpfungen. Sonst läge ein Drittel davon
(Recherche) in einer fremden Tabelle und zwei Drittel (Beat, Motiv) hier — und
die Frage „woran hängt diese Pendenz" hätte zwei Lesepfade.

**Warum nur diese drei Ziele:** alle drei sind **planende** Kataloge desselben
Buches. Eine Pendenz hängt an einem Fundstück, einem Handlungspunkt oder einem
Motiv — nicht an einer Textstelle, denn ihre Stelle im Buch **ist** ja schon ihr
Anker.

**Ein Ziel bleibt im Buch.** Der FK allein liesse eine Idee aus Buch A auf ein
Motiv aus Buch B zeigen; die Buch-Prüfung liegt in
[db/ideen.js](../db/ideen.js)#`addIdeaLink` (sie muss die Ziel-Tabelle kennen und
gehört darum nicht in den Handler).

**Labels kommen per JOIN zur Lesezeit**, nie als Snapshot-Spalte: ein umbenanntes
Motiv heisst sofort überall neu.

### Die Gegenrichtung

Die Ideen-Plaketten **an** einem Fundstück / Beat / Motiv laufen über **einen**
Endpunkt — `GET /ideen/links?book_id=&target_kind=` — und ein geteiltes Modul
([ideen-backlinks.js](../public/js/book/ideen-backlinks.js) +
[ideen-backlinks.html](../public/partials/ideen-backlinks.html)).

**Why ein Endpunkt statt drei erweiterter Payloads:** so bleibt die Skopierung an
**einer** Stelle richtig. Hängte man die Anrisse an die `research_items`-Zeile,
müsste jeder ihrer Schreibpfade (`/capture`, Media-Upload, Scrape, Interview,
PATCH …) die E-Mail des Betrachters mitführen — und der erste, der es vergisst,
zeigt dem Mitarbeiter die privaten Pendenzen des Autors. `/research`, `/plot` und
`/motifs` bleiben unverändert.

**Read-only auf der Gegenseite.** Kuratiert wird die Kante ausschliesslich auf der
Ideen-Seite; die Plakette zeigt und springt. Gleiche Bauart wie die Motiv-Badges
auf der Beat-Karte, die in der Motiv-Werkstatt kuratiert werden.

**Non-fatal.** Schlägt die Nebenlesung fehl, steht die Karte ohne Ideen-Chips da —
ein Motiv-Katalog, der wegen einer fehlenden Beigabe gar nicht erscheint, wäre der
schlechtere Tausch.

**Der Host nennt das Ziel `ideaOwnerId`** (per `x-data` auf einem Wrapper über dem
Include), weil die drei Karten ihre Entität verschieden benennen.

**`.swbook` trägt die Kanten NICHT mit** ([db/book-migration-data.js](../db/book-migration-data.js)):
keiner der drei Zielkataloge steht im Bundle. Eine mitgenommene Kante hätte auf
der Zielinstanz kein Gegenüber — oder, schlimmer, träfe eine gleich nummerierte
fremde Zeile. Alt-Bundles mit `erledigt`/`erledigt_at` werden weiter gelesen,
geschrieben wird nur die aktuelle Form.

---

## 4 · Routen

| Route | Zweck |
|---|---|
| `GET /ideen?page_id=` / `?chapter_id=` | Ideen eines Ankers (offen zuerst) |
| `GET /ideen/counts?book_id=&kind=` | Map Anker → Zahl **offener** Ideen (Sidebar-Plakette) |
| `GET /ideen/board?book_id=` | alle Ideen des Buchs — Datenquelle des Boards |
| `GET /ideen/link-targets?book_id=` | verknüpfbare Ziele (Recherche / Beat / Motiv) |
| `GET /ideen/links?book_id=&target_kind=` | Gegenrichtung: Map Ziel-ID → Ideen-Anrisse |
| `POST /ideen` | anlegen (XOR `page_id`/`chapter_id`) |
| `PATCH /ideen/:id` | `content`, `status`, Move |
| `POST /ideen/:id/links` · `DELETE /ideen/:id/links/:linkId` | Kante setzen / lösen |
| `DELETE /ideen/:id` | löschen |

Alle ab Rolle `editor` auf dem Buch, alle zusätzlich auf den eigenen
`user_email`-Bestand beschränkt. Fehlerformen: `INVALID_SCOPE`, `BOOK_MISMATCH`,
`KIND_MISMATCH`, `IDEE_CLOSED`, `INVALID_STATUS`, `INVALID_LINK_KIND`,
`LINK_TARGET_NOT_FOUND`, `CONTENT_REQUIRED` / `CONTENT_TOO_LONG` (4000 Zeichen).

---

## 5 · Pflicht-Invarianten

1. **Eine Spalte für den Stand.** Kein zweites Ja/Nein neben `status`.
2. **`verworfen` ist nie „offen".** Weder Plakette noch Zähler noch Chat-Kontext.
3. **Verworfen wird nicht gelöscht.** Ausblenden ja, wegräumen nein.
4. **Jede Lesung trägt `user_email`** — besonders die Rückwärts-Lesung.
5. **Ein Ziel bleibt im Buch** (`addIdeaLink` prüft, der FK reicht nicht).
6. **Keine Idee verschwindet still** aus dem Board (Sammelbahn, ausgewiesene
   Ausblend-Zahl, `+n` je eingeklappter Zelle).
7. **Die Bahnen-Reihenfolge kommt aus dem Baum**, nie aus einer zweiten Sortierung.
8. **Spalten-Zähler messen den Gesamtbestand**, nicht die gefilterte Sicht.
9. **Ein Drag setzt den Status, nie die Bahn.**
10. **Klappen ist Ansicht, kein Filter** — es bewegt weder `visible` noch
    `hiddenByFilter`, und ein zugeklapptes Kapitel behält seine Zeile (sonst wäre
    der Griff zum Aufklappen mit weg).
11. **Ein Status-Key ist eine Persistenz-Konstante.** Ergänzen ja, umbenennen nein —
    mit Eintrag in beide Locales (`ideen.status.<key>`), sonst rendert eine
    Alt-Zeile ihren rohen Key.
