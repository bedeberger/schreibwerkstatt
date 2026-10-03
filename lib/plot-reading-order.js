'use strict';
// Lesereihenfolge des Beat-Boards PRO LANE — PURE, ohne DB und ohne KI.
//
// Verbindliche Regel (SSoT; Zeit-Messung, KI-Kontext und jeder weitere
// Konsument, der „vorher/nachher" auf dem Board meint, nutzt diese Funktion):
//   - Eine Lane = ein Strang (nach position, id) oder die „ohne Strang"-Lane
//     (thread_id NULL; als letzte Lane).
//   - Die Akte einer Lane = die EIGENEN Akte des Strangs (thread_id = T, nach
//     position, id), falls er welche hat; sonst die GETEILTEN Akte (thread_id
//     NULL, nach position, id). Die „ohne Strang"-Lane nutzt immer die geteilten.
//   - Beats einer Lane = die Beats mit thread_id = T (bzw. NULL), geordnet nach
//     dem Rang ihres Akts in der Lane, dann sort_order, dann id. Ein Beat auf
//     einem Akt, der nicht zur Lane gehört (Altdaten), kommt ans Lane-Ende statt
//     verloren zu gehen.
//
// Warum pro Lane: die Akte geforkter Stränge haben eigene Positions-Sequenzen.
// Eine einzige globale Ordnung nach „Akt-Position" würde Akt 2 von Strang A mit
// Akt 2 der geteilten Struktur gleichsetzen und Beats verschiedener Erzähllinien
// verzahnen, die zeitlich nichts miteinander zu tun haben.

function _byPos(a, b) {
  return ((a.position ?? 0) - (b.position ?? 0)) || (a.id - b.id);
}

// acts:    [{ id, thread_id, position }]
// threads: [{ id, position }]
// beats:   [{ id, act_id, thread_id, sort_order }]
// Rückgabe: [{ key, threadId, acts: [act], beats: [beat] }] — key = 't<id>' bzw.
// 'none'. Die Lanes erscheinen in Board-Reihenfolge, auch wenn sie leer sind.
function laneReadingOrder({ acts = [], threads = [], beats = [] } = {}) {
  const shared = acts.filter(a => a.thread_id == null).sort(_byPos);
  const ownByThread = new Map();
  for (const a of acts) {
    if (a.thread_id == null) continue;
    if (!ownByThread.has(a.thread_id)) ownByThread.set(a.thread_id, []);
    ownByThread.get(a.thread_id).push(a);
  }
  const knownThreads = new Set(threads.map(t => t.id));
  const lanes = [...threads].sort(_byPos).map(t => ({
    key: `t${t.id}`,
    threadId: t.id,
    acts: ownByThread.has(t.id) ? ownByThread.get(t.id).sort(_byPos) : shared,
    beats: [],
  }));
  const noneLane = { key: 'none', threadId: null, acts: shared, beats: [] };
  lanes.push(noneLane);
  const laneByThread = new Map(lanes.map(l => [l.threadId, l]));

  for (const b of beats) {
    const tid = b.thread_id != null && knownThreads.has(b.thread_id) ? b.thread_id : null;
    (laneByThread.get(tid) || noneLane).beats.push(b);
  }
  for (const lane of lanes) {
    const rank = new Map(lane.acts.map((a, i) => [a.id, i]));
    const miss = lane.acts.length;
    lane.beats.sort((a, b) => ((rank.get(a.act_id) ?? miss) - (rank.get(b.act_id) ?? miss))
      || ((a.sort_order ?? 0) - (b.sort_order ?? 0))
      || (a.id - b.id));
  }
  return lanes;
}

// Flache Sicht: alle Beats, Lane für Lane in Lesereihenfolge, jeder Beat ergänzt
// um `lane` (Lane-Key) und `ordnung` (0-basierter Rang INNERHALB seiner Lane).
// Gibt neue Objekte zurück, die Eingabe bleibt unverändert.
function beatsInReadingOrder(input) {
  const out = [];
  for (const lane of laneReadingOrder(input)) {
    lane.beats.forEach((b, i) => out.push({ ...b, lane: lane.key, ordnung: i }));
  }
  return out;
}

module.exports = { laneReadingOrder, beatsInReadingOrder };
