'use strict';
// Modell-Preise pro 1 Mio Tokens
// in USD. Cost wird zur Lese-Zeit aus (provider, model, tokens_*) berechnet —
// keine Materialisierung in job_runs/chat_messages. Preis-Update via PR wirkt
// rueckwirkend auf historische Daten.
//
// Update-Disziplin: bei Anthropic-Preisaenderung PR auf PRICING. Logger warnt
// einmal pro unbekanntem Modell, damit kein stiller Drift entsteht.

const logger = require('../logger');

const PRICING = Object.freeze({
  'claude-opus-4-7':         { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-opus-4-5':         { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-opus-4-1':         { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-opus-4-0':         { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'claude-sonnet-4-6':       { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-sonnet-4-5':       { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-sonnet-4-0':       { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-3-7-sonnet-latest':{ input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  'claude-haiku-4-5':        { input:  1.00, output:  5.00, cache_write:  1.25, cache_read: 0.10 },
  'claude-3-5-haiku-latest': { input:  0.80, output:  4.00, cache_write:  1.00, cache_read: 0.08 },
});

const _warnedModels = new Set();

// Family-Fallback: identifier wie 'claude-opus-4-7-20251212' werden auf den
// Basistarif geleitet. Reihenfolge wichtig (laengster Match zuerst).
const _FAMILY_PREFIXES = [
  'claude-opus-4-7', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4-0',
  'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-0',
  'claude-3-7-sonnet',
  'claude-haiku-4-5',
  'claude-3-5-haiku',
];

function fallbackFamily(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase();
  for (const prefix of _FAMILY_PREFIXES) {
    if (m.startsWith(prefix)) {
      // Mapping auf den Hauptkey, der in PRICING haengt.
      if (prefix === 'claude-3-7-sonnet') return 'claude-3-7-sonnet-latest';
      if (prefix === 'claude-3-5-haiku')  return 'claude-3-5-haiku-latest';
      return prefix;
    }
  }
  return null;
}

function _resolvePricing(model) {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  const family = fallbackFamily(model);
  if (family && PRICING[family]) return PRICING[family];
  if (!_warnedModels.has(model)) {
    _warnedModels.add(model);
    logger.warn(`[pricing] Modell '${model}' unbekannt — Cost=0 angesetzt. Pricing in lib/pricing.js ergaenzen.`);
  }
  return null;
}

// USD-Kosten fuer einen Aufruf. Cache-Read = guenstig (~10% Input), Cache-Write
// = teuer (~125% Input). Lokale Provider (ollama/llama) sind 0 USD — Strom/
// Compute-Aufwand des Betreibers, nicht App-Sache.
function costUsd({ provider, model, tokensIn = 0, tokensOut = 0, cacheReadIn = 0, cacheCreationIn = 0 } = {}) {
  if (provider !== 'claude') return 0;
  const p = _resolvePricing(model);
  if (!p) return 0;
  return (
    (Number(tokensIn)        || 0) * p.input +
    (Number(tokensOut)       || 0) * p.output +
    (Number(cacheCreationIn) || 0) * p.cache_write +
    (Number(cacheReadIn)     || 0) * p.cache_read
  ) / 1_000_000;
}

module.exports = { PRICING, costUsd, fallbackFamily };
