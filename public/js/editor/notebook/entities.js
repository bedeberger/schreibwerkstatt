// Entity-Linking (Notebook-Editor): Figuren-/Orte-Highlights + Szenen-/Ereignisse-
// Panel der aktuellen Seite. Strikt rueckwaerts: keine KI, nur sichtbar machen
// was die Komplettanalyse bereits extrahiert hat.
//
// Pure-Funktionen (ohne DOM) sind unit-getestet:
//   - buildRanges(text, entities)  → Range-Deskriptoren mit Wortgrenzen
//   - selectScenesForView(scenes, pageId, chapterId)
//   - selectEventsForView(events, pageId, chapterId)
// DOM-Bindings (applyHighlights/clearHighlights) leben darunter und nutzen die
// CSS-Custom-Highlight-API analog zu editor/find.js — keine DOM-Mutation.

// Wortzeichen: Unicode-Buchstaben (\p{L}) + Marks (\p{M}) + Ziffern (\p{N})
// + Apostroph/Bindestrich, damit Namen wie "O'Brien" / "Anna-Lena" als
// Einheit zaehlen. Wortgrenzen-Pruefung ist symmetrisch (vorher + nachher).
const WORD_CHAR_RE = /[\p{L}\p{M}\p{N}'’\-]/u;

function isWordChar(ch) {
  return !!ch && WORD_CHAR_RE.test(ch);
}

/** Liefert Range-Deskriptoren fuer Vorkommen der Entitaeten im Text.
 *  Eingabe: { text: string, entities: [{ id, name, kind }] } — `kind` in
 *  'figure' | 'location'. Ausgabe: Array von { start, end, kind, id, name }
 *  sortiert nach start, ohne Overlap. Kollisionsregel: Figur > Ort am
 *  selben Offset (gleicher Name als Figur und Ort → Figur gewinnt).
 *  Match: case-insensitiv, ganze Woerter, Unicode-aware. */
export function buildRanges(text, entities) {
  if (!text || !Array.isArray(entities) || entities.length === 0) return [];
  const lowText = text.toLowerCase();
  const hits = [];
  for (const e of entities) {
    const name = (e?.name || '').trim();
    if (!name) continue;
    const lowName = name.toLowerCase();
    let from = 0;
    while (from <= lowText.length - lowName.length) {
      const idx = lowText.indexOf(lowName, from);
      if (idx < 0) break;
      const before = idx > 0 ? text[idx - 1] : '';
      const after  = text[idx + name.length] || '';
      if (!isWordChar(before) && !isWordChar(after)) {
        hits.push({ start: idx, end: idx + name.length, kind: e.kind, id: e.id, name });
      }
      from = idx + Math.max(1, name.length);
    }
  }
  // Sortiere nach start, dann nach kind-Prio (figure < location → figure
  // gewinnt bei gleichem start). Filtere Overlaps (laengster bzw. erster).
  hits.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.kind !== b.kind) return a.kind === 'figure' ? -1 : 1;
    return b.end - b.start - (a.end - a.start);
  });
  const out = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start < lastEnd) continue; // Overlap → ueberspringe
    out.push(h);
    lastEnd = h.end;
  }
  return out;
}

/** Filtert Szenen fuer das Seiten-Panel:
 *   - onPage: scenes mit page_id = aktuelle Seite
 *   - inChapter: scenes mit chapter_id = aktuelles Kapitel UND page_id IS NULL
 *  Sortierung nach sort_order (falls vorhanden), sonst nach id. */
export function selectScenesForView(scenes, pageId, chapterId) {
  if (!Array.isArray(scenes)) return { onPage: [], inChapter: [] };
  const pid = pageId != null ? Number(pageId) : null;
  const cid = chapterId != null ? Number(chapterId) : null;
  const onPage = pid != null ? scenes.filter(s => Number(s.page_id) === pid) : [];
  const inChapter = (cid != null)
    ? scenes.filter(s => Number(s.chapter_id) === cid && (s.page_id == null || s.page_id === ''))
    : [];
  const sortFn = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.id - b.id);
  return { onPage: [...onPage].sort(sortFn), inChapter: [...inChapter].sort(sortFn) };
}

/** Filtert figurgebundene Ereignisse fuer das Seiten-Panel.
 *  Datenstruktur: `figuren[].lebensereignisse[]` (pro-Figur). Wir flatten
 *  on-the-fly und attachen die zugehoerige Figur als figure-Property.
 *  Sortierung nach `datum_year`/`datum_month`/`datum_day` (falls strukturiert,
 *  ab Migration 156) sonst lexikographisch nach `datum`. */
export function selectEventsForView(figures, pageId, chapterId) {
  if (!Array.isArray(figures)) return { onPage: [], inChapter: [] };
  const pid = pageId != null ? Number(pageId) : null;
  const cid = chapterId != null ? Number(chapterId) : null;
  const onPage = [];
  const inChapter = [];
  for (const fig of figures) {
    const events = Array.isArray(fig?.lebensereignisse) ? fig.lebensereignisse : [];
    for (const ev of events) {
      const evPid = ev.page_id != null ? Number(ev.page_id) : null;
      const evCid = ev.chapter_id != null ? Number(ev.chapter_id) : null;
      const enriched = {
        ...ev,
        figure_id: fig.id,
        figure_name: fig.name,
        figure_kurzname: fig.kurzname || null,
      };
      if (pid != null && evPid === pid) onPage.push(enriched);
      else if (cid != null && evCid === cid && evPid == null) inChapter.push(enriched);
    }
  }
  const sortFn = (a, b) => {
    const ay = a.datum_year ?? 9999, by = b.datum_year ?? 9999;
    if (ay !== by) return ay - by;
    const am = a.datum_month ?? 99, bm = b.datum_month ?? 99;
    if (am !== bm) return am - bm;
    const ad = a.datum_day ?? 99, bd = b.datum_day ?? 99;
    if (ad !== bd) return ad - bd;
    return String(a.datum || '').localeCompare(String(b.datum || ''));
  };
  return { onPage: onPage.sort(sortFn), inChapter: inChapter.sort(sortFn) };
}

// ── CSS Custom Highlight API ────────────────────────────────────────────────
// Zwei Register: 'entity-figure' und 'entity-location'. Pattern wie find.js:
// einmal anlegen, ueber clear() leeren, neue Ranges hinzufuegen.

const HL_FIGURE = 'entity-figure';
const HL_LOCATION = 'entity-location';
let _hlFigure = null;
let _hlLocation = null;

function ensureHighlights() {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return false;
  if (!_hlFigure) {
    _hlFigure = new Highlight();
    CSS.highlights.set(HL_FIGURE, _hlFigure);
  }
  if (!_hlLocation) {
    _hlLocation = new Highlight();
    CSS.highlights.set(HL_LOCATION, _hlLocation);
  }
  return true;
}

export function clearHighlights() {
  if (_hlFigure) _hlFigure.clear();
  if (_hlLocation) _hlLocation.clear();
}

/** Sammelt Text-Nodes im root (Editor-Container) und konkateniert sie.
 *  Pendant zu find.js#collectTextNodes — duplizieren wir bewusst, weil
 *  find.js andere Aufrufer/Lifecycle hat. */
function collectTextNodes(root) {
  const nodes = [];
  if (!root) return { nodes, full: '', starts: [] };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  const starts = new Array(nodes.length);
  let acc = 0;
  for (let i = 0; i < nodes.length; i++) {
    starts[i] = acc;
    acc += nodes[i].nodeValue.length;
  }
  return { nodes, full: nodes.map(n => n.nodeValue).join(''), starts };
}

/** Rangiert einen globalen [start, end)-Offset auf konkrete (Node, Offset)
 *  und gibt ein Range zurueck, oder null wenn nicht mappbar. */
function rangeFromOffsets(nodes, starts, start, end) {
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  for (let i = 0; i < nodes.length; i++) {
    const s = starts[i];
    const e = s + nodes[i].nodeValue.length;
    if (startNode == null && start >= s && start <= e) {
      startNode = nodes[i];
      startOffset = start - s;
    }
    if (end >= s && end <= e) {
      endNode = nodes[i];
      endOffset = end - s;
      break;
    }
  }
  if (!startNode || !endNode) return null;
  try {
    const r = document.createRange();
    r.setStart(startNode, startOffset);
    r.setEnd(endNode, endOffset);
    return r;
  } catch {
    return null;
  }
}

/** Berechnet Ranges aus dem aktuellen DOM-Stand des Editor-Containers
 *  und schiebt sie in die zwei Highlight-Register. Kein DOM-Eingriff. */
export function applyHighlights(rootEl, entities) {
  if (!ensureHighlights()) return;
  clearHighlights();
  if (!rootEl) return;
  const { nodes, full, starts } = collectTextNodes(rootEl);
  if (!full) return;
  const ranges = buildRanges(full, entities);
  for (const r of ranges) {
    const range = rangeFromOffsets(nodes, starts, r.start, r.end);
    if (!range) continue;
    if (r.kind === 'figure') _hlFigure.add(range);
    else if (r.kind === 'location') _hlLocation.add(range);
  }
}

/** Vereint Figuren + Orte zur Entitaeten-Liste, die `buildRanges`
 *  konsumiert. Kollisions-Vorrang via Reihenfolge: Figuren zuerst.
 *  Eingabe: Roh-Arrays aus dem Catalog-Store. */
export function toEntitiesList(figuren, orte) {
  const out = [];
  for (const f of (figuren || [])) {
    if (f?.name) out.push({ id: f.id, name: f.name, kind: 'figure' });
  }
  for (const o of (orte || [])) {
    if (o?.name) out.push({ id: o.id, name: o.name, kind: 'location' });
  }
  return out;
}
