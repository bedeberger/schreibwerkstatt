'use strict';
// Aggregierte Token-Verbrauchsstatistik pro Tag.
// Quellen: job_runs (alle Hintergrund-Jobs) + chat_messages (Seiten-Chat).
// Beide Quellen über UNION ALL gemixt; Klassifizierung via `source`-Spalte.
//
// Granularität: Tag × User × Provider × Modell × Quelle/Typ.
// Cache-Tokens (Claude) werden in cache_read_in (billig) und cache_creation_in (teuer)
// getrennt geführt. Lokale Provider liefern dort 0.
const { db } = require('./connection');

/**
 * @param {object} opts
 * @param {string} [opts.from]         ISO-Datum oder YYYY-MM-DD (inklusive). Default: 30 Tage zurück.
 * @param {string} [opts.to]           ISO-Datum oder YYYY-MM-DD (inklusive, exklusive Tagesgrenze).
 * @param {string} [opts.userEmail]    Filter auf einen User. Ohne: alle.
 * @param {string} [opts.provider]     Filter auf einen Provider (claude/ollama/llama).
 * @param {string} [opts.source]       'job' | 'chat' | 'all' (default).
 * @returns {Array<{day:string,userEmail:string,provider:string,model:string,source:string,type:string,calls:number,tokensIn:number,tokensOut:number,cacheReadIn:number,cacheCreationIn:number,cacheCreation1hIn:number}>}
 */
function getDailyTokenUsage({ from, to, userEmail, provider, source = 'all' } = {}) {
  const fromIso = from || new Date(Date.now() - 30 * 86400_000).toISOString();
  const toIso = to || new Date(Date.now() + 86400_000).toISOString();

  const where = ['queued_at >= @from', 'queued_at < @to'];
  if (userEmail) where.push('user_email = @userEmail');
  if (provider)  where.push('provider = @provider');
  const jobWhere = where.join(' AND ');

  const whereCm = ['cm.created_at >= @from', 'cm.created_at < @to', "cm.role = 'assistant'"];
  if (userEmail) whereCm.push('cs.user_email = @userEmail');
  if (provider)  whereCm.push('cm.provider = @provider');
  const cmWhere = whereCm.join(' AND ');

  const parts = [];
  if (source === 'all' || source === 'job') {
    parts.push(`
      SELECT
        substr(queued_at, 1, 10) AS day,
        user_email                AS userEmail,
        provider,
        model,
        'job'                     AS source,
        type,
        COUNT(*)                  AS calls,
        COALESCE(SUM(tokens_in), 0)         AS tokensIn,
        COALESCE(SUM(tokens_out), 0)        AS tokensOut,
        COALESCE(SUM(cache_read_in), 0)     AS cacheReadIn,
        COALESCE(SUM(cache_creation_in), 0) AS cacheCreationIn,
        COALESCE(SUM(cache_creation_1h_in), 0) AS cacheCreation1hIn
      FROM job_runs
      WHERE ${jobWhere}
      GROUP BY day, user_email, provider, model, type
    `);
  }
  if (source === 'all' || source === 'chat') {
    parts.push(`
      SELECT
        substr(cm.created_at, 1, 10) AS day,
        cs.user_email                 AS userEmail,
        cm.provider,
        cm.model,
        'chat'                        AS source,
        cs.kind                       AS type,
        COUNT(*)                      AS calls,
        COALESCE(SUM(cm.tokens_in), 0)         AS tokensIn,
        COALESCE(SUM(cm.tokens_out), 0)        AS tokensOut,
        COALESCE(SUM(cm.cache_read_in), 0)     AS cacheReadIn,
        COALESCE(SUM(cm.cache_creation_in), 0) AS cacheCreationIn,
        COALESCE(SUM(cm.cache_creation_1h_in), 0) AS cacheCreation1hIn
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.session_id
      WHERE ${cmWhere}
      GROUP BY day, cs.user_email, cm.provider, cm.model, cs.kind
    `);
  }
  if (!parts.length) return [];

  const sql = parts.join('\nUNION ALL\n') + '\nORDER BY day DESC, userEmail, provider, source, type';
  return db.prepare(sql).all({
    from: fromIso, to: toIso,
    userEmail: userEmail || null,
    provider: provider || null,
  });
}

/**
 * Tagessummen pro User über ALLE Provider/Modelle/Typen hinweg.
 * Für High-Level-Reports „User X heute Y Tokens".
 */
function getDailyTotalsByUser({ from, to, userEmail } = {}) {
  const rows = getDailyTokenUsage({ from, to, userEmail });
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.day}\t${r.userEmail || ''}\t${r.provider || ''}`;
    const acc = byKey.get(key) || {
      day: r.day, userEmail: r.userEmail, provider: r.provider,
      calls: 0, tokensIn: 0, tokensOut: 0, cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0,
    };
    acc.calls             += r.calls;
    acc.tokensIn          += r.tokensIn;
    acc.tokensOut         += r.tokensOut;
    acc.cacheReadIn       += r.cacheReadIn;
    acc.cacheCreationIn   += r.cacheCreationIn;
    acc.cacheCreation1hIn += r.cacheCreation1hIn;
    byKey.set(key, acc);
  }
  return [...byKey.values()].sort((a, b) =>
    b.day.localeCompare(a.day) || (a.userEmail || '').localeCompare(b.userEmail || '')
  );
}

module.exports = { getDailyTokenUsage, getDailyTotalsByUser };
