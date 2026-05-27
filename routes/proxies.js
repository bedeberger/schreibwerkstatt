const crypto = require('crypto');
const express = require('express');
const logger = require('../logger');
const avatarCache = require('../lib/avatar-cache');
const { MAX_TOKENS_OUT, CHARS_PER_TOKEN } = require('../lib/ai');
const { getBookLocale } = require('../db/schema');
const appUsers = require('../db/app-users');
const { getPromptConfig } = require('../lib/prompts-loader');
const { toIntId } = require('../lib/validate');
const appSettings = require('../lib/app-settings');

const router = express.Router();

// Modell-Konfiguration ans Frontend liefern (keine Credentials)
router.get('/config', (req, res) => {
  const sessionUser = req.session?.user || null;
  let user = sessionUser;
  let userSettings = null;
  if (sessionUser) {
    const appUser = appUsers.getUser(sessionUser.email);
    // Google-Profilbild über den Same-Origin-Proxy (/auth/avatar) ausliefern,
    // damit Browser-Tracking-Prevention den Direktzugriff auf
    // googleusercontent.com nicht blockt. `?v=` bricht den Browser-Cache, wenn
    // Google die Avatar-URL rotiert (avatarCache liest die echte URL aus der Session).
    let picture = sessionUser.picture || null;
    if (avatarCache.isAllowedAvatarUrl(picture)) {
      const v = crypto.createHash('sha1').update(picture).digest('hex').slice(0, 8);
      picture = `/auth/avatar?v=${v}`;
    }
    user = {
      ...sessionUser,
      picture,
      role: appUser?.global_role || 'user',
      status: appUser?.status || 'active',
      can_invite_users: appUser?.can_invite_users ? 1 : 0,
      isAdmin: appUser?.global_role === 'admin',
    };
    if (appUser) {
      // `locale` ist API-Vertrag; app_users-Spalte heisst `language`.
      userSettings = {
        locale:            appUser.language,
        theme:             appUser.theme,
        default_buchtyp:   appUser.default_buchtyp,
        default_language:  appUser.default_language,
        default_region:    appUser.default_region,
        focus_granularity: appUser.focus_granularity,
      };
    }
  }
  res.json({
    claudeMaxTokens: MAX_TOKENS_OUT,
    claudeModel: appSettings.get('ai.claude.model') || 'claude-sonnet-4-6',
    apiProvider: appSettings.get('ai.provider') || 'claude',
    charsPerToken: CHARS_PER_TOKEN,
    ollamaModel: appSettings.get('ai.ollama.model') || 'llama3.2',
    llamaModel:  appSettings.get('ai.llama.model')  || 'llama3.2',
    user,
    userSettings,
    devMode: process.env.LOCAL_DEV_MODE === 'true',
    promptConfig: getPromptConfig(),
    appTimezone: appSettings.get('app.timezone') || 'Europe/Zurich',
    appName: appSettings.get('app.name') || 'Schreibwerkstatt',
    languagetool: {
      enabled: appSettings.get('languagetool.enabled') === true
        && !!String(appSettings.get('languagetool.url') || '').replace(/\/$/, '').replace(/\/v2$/i, '').trim(),
      debounceMs: Number(appSettings.get('languagetool.debounce_ms')) || 1500,
    },
  });
});

// OpenThesaurus (openthesaurus.de) — deutscher Community-Thesaurus von Daniel Naber.
// JSON-API liefert Bedeutungsgruppen (synsets) mit stilistischem Level; nur für deutsche Bücher.
// Terme können Kontext in Klammern enthalten ("(sich) identifizieren (mit)") — wird fürs Ersetzen gestrippt.
function cleanThesTerm(term) {
  return String(term || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchOpenThesaurusRaw(word, budgetSignal) {
  const url = `https://www.openthesaurus.de/synonyme/search?q=${encodeURIComponent(word)}&format=application/json&baseform=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  const onBudget = () => ctrl.abort();
  budgetSignal?.addEventListener?.('abort', onBudget);
  try {
    const upstream = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!upstream.ok) return null;
    return await upstream.json();
  } catch (err) {
    if (err.name !== 'AbortError') logger.warn(`OpenThesaurus fetch «${word}»: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
    budgetSignal?.removeEventListener?.('abort', onBudget);
  }
}

function extractThesSynonyms(data, queryWord) {
  const synsets = Array.isArray(data?.synsets) ? data.synsets : [];
  const normQuery = queryWord.toLowerCase();
  const out = [];
  const seen = new Set([normQuery]);
  for (const synset of synsets) {
    const terms = Array.isArray(synset?.terms) ? synset.terms : [];
    for (const t of terms) {
      const clean = cleanThesTerm(t?.term);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ wort: clean, hinweis: (t?.level || '').trim() });
    }
  }
  return out;
}

// Liefert Synonyme; fällt bei flektierten Formen ("ging") automatisch auf die Grundform zurück.
async function fetchOpenThesaurus(word, budgetSignal) {
  const first = await fetchOpenThesaurusRaw(word, budgetSignal);
  if (!first) return { synonyme: [], lemma: null };
  const direct = extractThesSynonyms(first, word);
  if (direct.length > 0) return { synonyme: direct, lemma: null };
  const baseforms = Array.isArray(first?.baseforms) ? first.baseforms : [];
  for (const lemma of baseforms) {
    if (!lemma || lemma.toLowerCase() === word.toLowerCase()) continue;
    if (budgetSignal?.aborted) break;
    const second = await fetchOpenThesaurusRaw(lemma, budgetSignal);
    if (!second) continue;
    const hits = extractThesSynonyms(second, lemma);
    if (hits.length > 0) {
      const hinweis = `Grundform: ${lemma}`;
      return {
        synonyme: hits.map(h => ({ wort: h.wort, hinweis: h.hinweis || hinweis })),
        lemma,
      };
    }
  }
  return { synonyme: [], lemma: null };
}

router.get('/openthesaurus/synonyms', async (req, res) => {
  const word = (req.query.word || '').trim();
  const bookId = toIntId(req.query.book_id);
  const log = logger.child({ job: 'thesaurus', user: req.session?.user?.email || '-', book: bookId || '-' });
  if (!word) return res.json({ synonyme: [], disabled: false });
  const userEmail = req.session?.user?.email || null;
  const locale = bookId ? getBookLocale(bookId, userEmail) : 'de-CH';
  if (!locale || !locale.toLowerCase().startsWith('de')) {
    log.info(`word=«${word}» skipped (locale=${locale})`);
    return res.json({ synonyme: [], disabled: true });
  }
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), 10000);
  const t0 = Date.now();
  try {
    const { synonyme, lemma } = await fetchOpenThesaurus(word, budget.signal);
    const ms = Date.now() - t0;
    log.info(`word=«${word}»${lemma ? ` lemma=«${lemma}»` : ''} hits=${synonyme.length} ${ms}ms`);
    res.json({ synonyme, disabled: false, lemma });
  } finally {
    clearTimeout(budgetTimer);
  }
});

module.exports = { router };
