'use strict';
// Abgerechnete Anthropic-Kosten (Tabelle anthropic_cost_daily, Mig 291) —
// Spiegel der Cost-Report-API, befuellt von lib/anthropic-billing.js#syncBilling.
//
// Gespeichert werden ALLE Workspaces; der Workspace-Filter
// (`ai.claude.billing.workspace_id`) greift erst beim Lesen, damit ein Wechsel
// der Einstellung keinen neuen Abruf braucht.
//
// Tage sind UTC-Tage (`YYYY-MM-DD`), so wie die API ihre Buckets schneidet.
// Bereichsgrenzen: `fromDay` inklusiv, `toDay` exklusiv.

const { db } = require('./connection');
require('./migrations');

const _del = db.prepare('DELETE FROM anthropic_cost_daily WHERE day >= ? AND day < ?');
const _ins = db.prepare(`
  INSERT INTO anthropic_cost_daily
    (day, workspace_id, description, model, cost_type, token_type, service_tier, context_window, usd, fetched_at)
  VALUES (@day, @workspace_id, @description, @model, @cost_type, @token_type, @service_tier, @context_window, @usd, @fetched_at)
`);

// Ersetzt den kompletten Tagesbereich: Anthropic korrigiert juengste Tage noch
// nachtraeglich, ein reines Anhaengen wuerde doppelt zaehlen.
const replaceRange = db.transaction((fromDay, toDay, rows) => {
  _del.run(fromDay, toDay);
  const fetchedAt = new Date().toISOString();
  for (const r of rows) _ins.run({ ...r, fetched_at: fetchedAt });
  return rows.length;
});

// '' = alle Workspaces, 'default' = Default-Workspace (API liefert dort NULL).
function _workspaceCond(workspace) {
  const ws = String(workspace || '').trim();
  if (!ws) return { sql: '1', args: [] };
  if (ws === 'default') return { sql: 'workspace_id IS NULL', args: [] };
  return { sql: 'workspace_id = ?', args: [ws] };
}

// Jeder abgerufene Tag erscheint (der Sync legt fuer leere Tage eine 0-Zeile
// an) — auch wenn der gefilterte Workspace an dem Tag nichts verbraucht hat.
// Nur so bleibt „abgerufen, 0" von „nie abgerufen" unterscheidbar.
function dailyTotals({ fromDay, toDay, workspace }) {
  const w = _workspaceCond(workspace);
  return db.prepare(`
    SELECT day, SUM(CASE WHEN ${w.sql} THEN usd ELSE 0 END) AS usd FROM anthropic_cost_daily
     WHERE day >= ? AND day < ?
     GROUP BY day ORDER BY day
  `).all(...w.args, fromDay, toDay);
}

// model NULL = Nicht-Token-Kosten (Web-Suche, Code-Execution); die Route fasst
// sie unter cost_type zusammen.
function totalsByModel({ fromDay, toDay, workspace }) {
  const w = _workspaceCond(workspace);
  return db.prepare(`
    SELECT model, cost_type, SUM(usd) AS usd FROM anthropic_cost_daily
     WHERE day >= ? AND day < ? AND ${w.sql}
     GROUP BY model, cost_type
  `).all(fromDay, toDay, ...w.args);
}

function listWorkspaces() {
  return db.prepare(`
    SELECT workspace_id, SUM(usd) AS usd FROM anthropic_cost_daily
     GROUP BY workspace_id ORDER BY usd DESC
  `).all();
}

function lastFetchedAt() {
  return db.prepare('SELECT MAX(fetched_at) AS at FROM anthropic_cost_daily').get().at || null;
}

module.exports = { replaceRange, dailyTotals, totalsByModel, listWorkspaces, lastFetchedAt };
