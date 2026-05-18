'use strict';
// budget_alerts: dedupes Budget-Overrun-Mails. Pro (email, period) eine Mail.
// Periode ist 'YYYY-MM' in app.timezone (deckungsgleich mit lib/budget.js#firstOfCurrentMonthIso).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { localMonthPeriod } = require('../lib/local-date');

const _stmtWasSent = db.prepare(`
  SELECT 1 FROM budget_alerts WHERE email = ? AND period = ?
`);

const _stmtMarkSent = db.prepare(`
  INSERT OR IGNORE INTO budget_alerts (email, period, sent_at) VALUES (?, ?, ${NOW_ISO_SQL})
`);

function currentPeriod() {
  return localMonthPeriod();
}

function wasSent(email, period) {
  if (!email || !period) return false;
  return !!_stmtWasSent.get(email, period);
}

function markSent(email, period) {
  if (!email || !period) return false;
  const info = _stmtMarkSent.run(email, period);
  return info.changes > 0;
}

module.exports = { wasSent, markSent, currentPeriod };
