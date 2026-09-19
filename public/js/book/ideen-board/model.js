// Pure Rechnung des Ideen-Boards: aus dem Baum die Bahnen-Reihenfolge, aus den
// Ideen die belegten Bahnen und ihre Status-Spalten.
//
// Ohne Alpine, ohne fetch, ohne `this` — damit die Gruppierung testbar ist
// (tests/unit/ideen-board.test.mjs) und die Karte nur noch State haelt.

import { IDEE_STATUSES, ideeStatus, ideeLaneKey } from '../ideen-shared.js';

export const LANE_UNKNOWN = 'unknown:0';

/**
 * Bahnen-Reihenfolge aus `$store.nav.tree`.
 *
 * Die ORDNUNG der Bahnen kommt aus dem Baum und nicht aus der Ideen-Abfrage:
 * der Baum ist die SSoT der Buch-Reihenfolge (book_order-Overlay), eine
 * `ORDER BY position` im Ideen-SQL waere eine zweite, stillschweigend
 * abweichende Sortierung.
 *
 * Pro Kapitel entsteht zuerst die Kapitel-Bahn (Ideen, die am Kapitel als
 * Ganzem haengen), danach die Bahnen seiner Seiten. Solo-Seiten (Seiten ohne
 * Kapitel) stehen im Baum als Pseudo-Kapitel und ergeben nur ihre Seiten-Bahn —
 * eine Kapitel-Bahn dafuer waere eine Bahn fuer ein Kapitel, das es nicht gibt.
 */
export function buildLaneOrder(tree) {
  const lanes = [];
  for (const node of (tree || [])) {
    if (node.solo) {
      const p = (node.pages || [])[0];
      if (p) lanes.push({ key: `page:${p.id}`, kind: 'page', id: p.id, label: p.name || '', chapterId: null, chapterLabel: '', depth: 1 });
      continue;
    }
    lanes.push({
      key: `chapter:${node.id}`, kind: 'chapter', id: node.id, label: node.name || '',
      chapterId: node.id, chapterLabel: node.name || '', depth: node.depth || 1,
    });
    for (const p of (node.pages || [])) {
      lanes.push({
        key: `page:${p.id}`, kind: 'page', id: p.id, label: p.name || '',
        chapterId: node.id, chapterLabel: node.name || '', depth: (node.depth || 1) + 1,
      });
    }
  }
  return lanes;
}

function matchesQuery(idee, q) {
  if (!q) return true;
  return (idee.content || '').toLowerCase().includes(q);
}

/**
 * Das ganze Board in einem Pass.
 *
 * `hiddenByFilter` ist kein Beiwerk: der Filter blendet aus, er loescht nicht —
 * und eine ausgeblendete Idee, die nirgends mehr gezaehlt wird, ist von einer
 * verlorenen nicht zu unterscheiden. Darum faellt die Zahl hier mit an.
 *
 * Eine Idee, deren Bahn der Baum (noch) nicht kennt — Seite gerade angelegt,
 * Baum noch nicht nachgezogen —, landet in der Sammelbahn LANE_UNKNOWN statt
 * aus dem Board zu fallen. Das Board ist eine Pendenzenliste; still verschwinden
 * darf dort nichts.
 *
 * KLAPPEN ist Ansicht, nicht Filter — darum zaehlt es weder in `hiddenByFilter`
 * noch aus `visible` heraus. Zwei Achsen, unabhaengig voneinander:
 *   `collapsedLanes`    — Bahn-Keys, deren KARTEN eingeklappt sind.
 *   `collapsedChapters` — Kapitel-Bahn-Keys, deren SEITEN-BAHNEN in die
 *                         Kapitelzeile gefaltet sind.
 * Was dabei verschwindet, steht je Zeile und Stufe in `hidden` — dieselbe
 * Ueberlegung wie bei `hiddenByFilter`: eine eingeklappte Pendenz ist sonst von
 * einer verlorenen nicht zu unterscheiden.
 */
export function buildBoard({
  ideen, laneOrder, filterChapterId = '', showErledigt = true, showVerworfen = true, query = '',
  collapsedLanes = [], collapsedChapters = [],
}) {
  const q = (query || '').trim().toLowerCase();
  const chapterFilter = filterChapterId === '' || filterChapterId == null ? null : Number(filterChapterId);

  const laneByKey = new Map((laneOrder || []).map(l => [l.key, l]));
  const buckets = new Map();   // laneKey → { lane, columns }
  let total = 0;
  let hiddenByFilter = 0;

  const ensure = (key, lane) => {
    if (!buckets.has(key)) {
      const columns = {};
      for (const s of IDEE_STATUSES) columns[s] = [];
      buckets.set(key, { lane, columns, count: 0 });
    }
    return buckets.get(key);
  };

  for (const idee of (ideen || [])) {
    total++;
    const status = ideeStatus(idee);
    // Kapitel-Filter misst die Bahn, nicht den Anker: eine Seiten-Idee gehoert
    // zum Kapitel IHRER Seite (`lane_chapter_id` vom Server), sonst faende der
    // Filter „Kapitel 3" nur die Ideen, die direkt am Kapitel haengen.
    const laneChapterId = idee.lane_chapter_id ?? idee.chapter_id ?? null;
    if (chapterFilter != null && laneChapterId !== chapterFilter) { hiddenByFilter++; continue; }
    if (!showErledigt && status === 'erledigt') { hiddenByFilter++; continue; }
    if (!showVerworfen && status === 'verworfen') { hiddenByFilter++; continue; }
    if (!matchesQuery(idee, q)) { hiddenByFilter++; continue; }

    const key = ideeLaneKey(idee);
    const lane = laneByKey.get(key) || {
      key: LANE_UNKNOWN, kind: 'unknown', id: 0, label: '',
      chapterId: laneChapterId, chapterLabel: idee.lane_chapter_name || '', depth: 1,
    };
    const bucket = ensure(lane.key, lane);
    bucket.columns[status].push(idee);
    bucket.count++;
  }

  // `visible` misst den FILTER, nicht die Klappung — es wird darum hier gezaehlt,
  // bevor gefaltet wird. Sonst zaehlte die Filterleiste das Einklappen als
  // Ausblenden und behauptete, der Filter verstecke etwas, das er nicht meint.
  let visible = 0;
  for (const b of buckets.values()) visible += b.count;

  const rows = [];
  const rowByKey = new Map();
  const foldedLanes = new Set(collapsedLanes || []);
  const foldedChapters = new Set(collapsedChapters || []);

  // Bahnen in Baum-Reihenfolge, die Sammelbahn zuletzt.
  for (const lane of (laneOrder || [])) {
    const bucket = buckets.get(lane.key);
    if (lane.kind === 'chapter') {
      const row = newRow(lane, bucket, foldedLanes.has(lane.key));
      row.childCollapsed = foldedChapters.has(lane.key);
      rows.push(row);
      rowByKey.set(lane.key, row);
      continue;
    }
    // Nur belegte SEITEN-Bahnen erscheinen — ein Board mit einer leeren Zeile je
    // Seite des Buches waere unlesbar.
    if (!bucket) continue;
    const host = lane.chapterId != null ? rowByKey.get(`chapter:${lane.chapterId}`) : null;
    if (host) host.childLanes++;
    if (host && host.childCollapsed) {
      for (const s of IDEE_STATUSES) host.folded[s] += bucket.columns[s].length;
      host.foldedCount += bucket.count;
      continue;
    }
    rows.push(newRow(lane, bucket, foldedLanes.has(lane.key)));
  }
  const unknown = buckets.get(LANE_UNKNOWN);
  if (unknown) rows.push(newRow(unknown.lane, unknown, foldedLanes.has(LANE_UNKNOWN)));

  // Eine Kapitel-Bahn bleibt auch OHNE eigene Ideen stehen, sobald eine ihrer
  // Seiten welche traegt: sie ist die Gruppen-Ueberschrift und der Griff, an dem
  // das Kapitel zuklappt. Ohne sie waere genau das Kapitel nicht klappbar,
  // dessen Pendenzen alle auf Seiten haengen — also fast jedes.
  const lanes = rows.filter(r => r.count > 0 || r.foldedCount > 0 || r.childLanes > 0);
  for (const row of lanes) {
    for (const s of IDEE_STATUSES) {
      row.hidden[s] = (row.collapsed ? row.columns[s].length : 0) + row.folded[s];
    }
  }

  return { lanes, total, visible, hiddenByFilter };
}

// Eine Board-Zeile. `folded`/`hidden` sind immer gesetzt (auch als Nullen),
// damit das Template sie ohne Existenz-Pruefung lesen kann.
function newRow(lane, bucket, collapsed) {
  const columns = {};
  const folded = {};
  const hidden = {};
  for (const s of IDEE_STATUSES) { columns[s] = bucket ? bucket.columns[s] : []; folded[s] = 0; hidden[s] = 0; }
  return {
    lane,
    columns,
    count: bucket ? bucket.count : 0,
    collapsed: !!collapsed,   // eigene Karten eingeklappt
    childCollapsed: false,    // Seiten-Bahnen in diese Kapitelzeile gefaltet
    childLanes: 0,            // Zahl der belegten Seiten-Bahnen darunter
    folded,                   // gefaltete Ideen je Stufe
    foldedCount: 0,
    hidden,                   // je Stufe: gefaltet + eigene eingeklappte
  };
}

/**
 * Kapitel-Optionen der Filterleiste: nur Kapitel, die ueberhaupt Ideen tragen —
 * und zwar unabhaengig von Status- und Textfilter, sonst verschwaende die eigene
 * Auswahl unter der Hand, sobald man `verworfen` ausblendet.
 */
export function chapterFilterOptions(ideen, laneOrder) {
  const withIdeen = new Set();
  for (const idee of (ideen || [])) {
    const cid = idee.lane_chapter_id ?? idee.chapter_id ?? null;
    if (cid != null) withIdeen.add(cid);
  }
  const seen = new Set();
  const out = [];
  for (const lane of (laneOrder || [])) {
    if (lane.kind !== 'chapter') continue;
    if (!withIdeen.has(lane.id) || seen.has(lane.id)) continue;
    seen.add(lane.id);
    out.push({ value: String(lane.id), label: lane.label });
  }
  return out;
}

/** Zahl der Ideen je Status ueber den GESAMTEN Bestand (Spaltenkopf-Zaehler). */
export function statusTotals(ideen) {
  const out = {};
  for (const s of IDEE_STATUSES) out[s] = 0;
  for (const idee of (ideen || [])) out[ideeStatus(idee)]++;
  return out;
}
