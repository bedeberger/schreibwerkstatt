'use strict';
// Phase 4d (BookStack-Exit, docs/bookstack-exit.md): Budget-Enforcement.
// checkBudget(email) liest app_users.{monthly_budget_usd, budget_mode} und
// aggregiert die monatliche USD-Summe ueber job_runs + chat_messages.
//   mode='none' => kein Check (Default fuer Neu-User).
//   mode='soft' => allowed=true, overrun-Flag fuer Banner.
//   mode='hard' => allowed=false bei Overrun => Middleware antwortet 429.
//
// Enforcement bewusst nur auf POST-Routen (Job-Start, Chat-Send). Status-Polls
// duerfen weiterlaufen, sonst kann ein gerade kostenpflichtig gewordener Job
// nicht mehr abgefragt werden.

const { db } = require('../db/connection');
const appUsers = require('../db/app-users');
const { costUsd } = require('./pricing');
const appSettings = require('./app-settings');
const logger = require('../logger');

function firstOfCurrentMonthUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

const _stmtJobRowsForUser = db.prepare(`
  SELECT provider, model, tokens_in, tokens_out, cache_read_in, cache_creation_in
    FROM job_runs
   WHERE user_email = ? AND queued_at >= ?
`);

const _stmtChatRowsForUser = db.prepare(`
  SELECT cm.provider, cm.model, cm.tokens_in, cm.tokens_out,
         cm.cache_read_in, cm.cache_creation_in
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
   WHERE cs.user_email = ? AND cm.created_at >= ? AND cm.role = 'assistant'
`);

// Summiert USD-Kosten eines Users seit `sinceIso`. Re-Compute pro Call ist
// guenstig — Tabellen sind klein (< 10k Rows/Monat), Index auf queued_at /
// created_at sorgt fuer Scan-Bound.
function sumCostUsdSince(email, sinceIso) {
  if (!email) return 0;
  const jobRows = _stmtJobRowsForUser.all(email, sinceIso);
  const chatRows = _stmtChatRowsForUser.all(email, sinceIso);
  let sum = 0;
  for (const r of jobRows) {
    sum += costUsd({
      provider: r.provider, model: r.model,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      cacheReadIn: r.cache_read_in, cacheCreationIn: r.cache_creation_in,
    });
  }
  for (const r of chatRows) {
    sum += costUsd({
      provider: r.provider, model: r.model,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      cacheReadIn: r.cache_read_in, cacheCreationIn: r.cache_creation_in,
    });
  }
  return sum;
}

// Liefert { allowed, mode, usd, budget, overrun? }.
//   allowed=false ausschliesslich bei mode='hard' UND usd>=budget>0.
function checkBudget(email) {
  if (!email) return { allowed: true, mode: 'none', usd: 0, budget: null };
  const user = appUsers.getUser(email);
  if (!user) return { allowed: true, mode: 'none', usd: 0, budget: null };
  const mode = user.budget_mode || 'none';
  if (mode === 'none') return { allowed: true, mode, usd: 0, budget: user.monthly_budget_usd };
  const budget = user.monthly_budget_usd;
  if (!budget || !Number.isFinite(budget) || budget <= 0) {
    return { allowed: true, mode, usd: 0, budget };
  }
  const usd = sumCostUsdSince(email, firstOfCurrentMonthUtc());
  const overrun = usd >= budget;
  return { allowed: mode !== 'hard' || !overrun, mode, usd, budget, overrun };
}

// Express-Middleware: blockt POSTs mit 429 BUDGET_EXCEEDED bei hard-overrun.
// Skip-Bedingungen:
//   - Provider != 'claude' (lokale Modelle kosten 0 USD).
//   - Nicht-POST (Status-Polls, GETs).
//   - Kein eingeloggter User (eigene Auth-Middleware faengt das vorher).
function enforceBudget(req, res, next) {
  if (req.method !== 'POST') return next();
  const email = req.session?.user?.email;
  if (!email) return next();

  const provider = (appSettings.get('ai.provider') || 'claude').toLowerCase();
  if (provider !== 'claude') return next();

  let result;
  try { result = checkBudget(email); }
  catch (err) {
    logger.warn(`[budget] checkBudget failed for ${email}: ${err.message}`);
    return next();
  }
  if (result.allowed) return next();

  res.status(429).json({
    error_code: 'BUDGET_EXCEEDED',
    usd: Math.round(result.usd * 100) / 100,
    budget: result.budget,
    mode: result.mode,
  });
}

module.exports = { checkBudget, enforceBudget, firstOfCurrentMonthUtc, sumCostUsdSince };
