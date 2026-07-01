'use strict';
// KI-Konfiguration & Auflösung: Provider-Resolution (global/per-User/ALS-Override),
// Token-Budget-Konstanten (boot-frozen + Validierung), Per-Provider-Temperatur/
// Think/Repeat-Penalty, Claude-Modell-Parameter (Sampling/Thinking/Effort/Caps).

const appSettings = require('../app-settings');
const logger = require('../../logger');
const { getContext } = require('../log-context');

const VALID_PROVIDERS = new Set(['claude', 'ollama', 'openai-compat']);

// Per-User-Provider-Resolution. Reihenfolge:
//   1. app_users.ai_provider_override (NULL = follows global)
//   2. app_settings.ai.provider
//   3. Hardcoded 'claude'
// userEmail wird ueblicherweise via ALS-Context aus dem Job/Request gezogen
// (siehe routes/jobs/shared/queue.js#runWithContext). Lazy-require auf db/app-users,
// damit lib/ai auch in Pre-Migration-Pfaden (Tests) ladbar bleibt.
function _globalProvider() {
  const v = String(appSettings.get('ai.provider') || 'claude').toLowerCase();
  return VALID_PROVIDERS.has(v) ? v : 'claude';
}

function _userOverride(email) {
  if (!email) return null;
  try {
    const appUsers = require('../../db/app-users');
    const u = appUsers.getUser(email);
    if (!u || !u.ai_provider_override) return null;
    const v = String(u.ai_provider_override).toLowerCase();
    return VALID_PROVIDERS.has(v) ? v : null;
  } catch { return null; }
}

function resolveProvider({ userEmail } = {}) {
  const email = userEmail || getContext().user || null;
  return _userOverride(email) || _globalProvider();
}

// Durchschnittliche Zeichen pro Token – bestimmt die Umrechnung zwischen Text-Länge
// und Token-Budget. Tokenizer-abhängig: Claude komprimiert deutschen Text effizient
// (~3 chars/token); moderne SentencePiece-Tokenizer von Mistral/Llama liegen bei
// ~4 chars/token auf deutschem Fliesstext (gemessen an Mistral-Small3.2). Falscher
// Wert → Input-Budget grob unter-/überschätzt → entweder 400-Fehler vom Provider
// oder massiv unterausgelasteter Kontext. Admin-Setting `ai.chars_per_token` für
// Modelle mit abweichendem Tokenizer.
// Boot-frozen: Budget-Ableitungen (SINGLE_PASS_LIMIT etc.) lesen den Wert beim
// Modul-Load anderer Files. Admin-PUT erfordert App-Restart.
const _PROVIDER = String(appSettings.get('ai.provider') || 'claude').toLowerCase();
const _CHARS_PER_TOKEN_DEFAULT = _PROVIDER === 'claude' ? 3 : 4;
const CHARS_PER_TOKEN = appSettings.has('ai.chars_per_token')
  ? Number(appSettings.get('ai.chars_per_token')) || _CHARS_PER_TOKEN_DEFAULT
  : _CHARS_PER_TOKEN_DEFAULT;

// Maximale Output-Tokens.
const MAX_TOKENS_OUT = Number(appSettings.get('ai.claude.max_tokens_out')) || 64000;

// Gesamtes Kontextfenster des Modells (Input + Output). Für Claude-API provider-
// seitig fix (200K), für lokale Modelle vom User zu setzen je nach Deployment
// (Mistral-Small3.2: 128K, Gemma3-12B: 128K, kleinere Modelle oft 32K oder 8K).
const MODEL_CONTEXT = Number(appSettings.get('ai.claude.context_window')) || 200000;

// Sicherheitspuffer für Tokenisierungs-Unsicherheit und System-Prompt-Overhead,
// den CHARS_PER_TOKEN nicht exakt trifft.
const CONTEXT_SAFETY_MARGIN = 2000;

// Hard-Check: max_tokens_out muss genug Platz für Input lassen — pro Provider.
// Sonst kollabieren abgeleitete Budgets auf ihre Mindestwerte, und lokale Provider
// (llama.cpp/Ollama) schicken max_tokens > num_ctx → 400-Fehler.
for (const p of ['claude', 'ollama', 'openai-compat']) {
  const ctx = Number(appSettings.get(`ai.${p}.context_window`));
  const out = Number(appSettings.get(`ai.${p}.max_tokens_out`));
  if (!ctx || !out) continue;
  if (out + CONTEXT_SAFETY_MARGIN >= ctx) {
    throw new Error(
      `Fehlkonfiguration: ai.${p}.max_tokens_out (${out}) + Sicherheitspuffer (${CONTEXT_SAFETY_MARGIN}) ` +
      `>= ai.${p}.context_window (${ctx}). max_tokens_out ist der Output-Cap und muss deutlich kleiner ` +
      `sein als das gesamte Kontextfenster context_window (Input + Output). Beispiel für Mistral-Small3.2: ` +
      `context_window=128000, max_tokens_out=16000.`
    );
  }
}

// Komplett-Override-Konsistenz: der obige Loop deckt nur die globalen Keys ab. Ein
// gesetztes ai.claude.max_tokens_out.komplett muss genug Platz fürs Input lassen — gegen
// ai.claude.context_window.komplett (falls gesetzt) bzw. sonst gegen das globale Claude-
// Kontextfenster. Ohne diesen Check kollabiert eine inkonsistente Override (z.B. 128K Output
// auf einem versehentlich auf 100K gesetzten Komplett-Kontext) das Input-Budget still auf
// den 2000-Token-Floor und die Extraktion sieht nur einen Bruchteil des Buchs.
{
  const kOut = parseInt(appSettings.get('ai.claude.max_tokens_out.komplett'), 10) || 0;
  if (kOut) {
    const kCtx = (parseInt(appSettings.get('ai.claude.context_window.komplett'), 10) || 0)
      || Number(appSettings.get('ai.claude.context_window')) || 200000;
    if (kOut + CONTEXT_SAFETY_MARGIN >= kCtx) {
      throw new Error(
        `Fehlkonfiguration: ai.claude.max_tokens_out.komplett (${kOut}) + Sicherheitspuffer ` +
        `(${CONTEXT_SAFETY_MARGIN}) >= effektives Komplett-Kontextfenster (${kCtx}). Setze ` +
        `ai.claude.context_window.komplett höher oder max_tokens_out.komplett tiefer ` +
        `(z.B. Opus 4.8: context_window.komplett=1000000, max_tokens_out.komplett=128000).`
      );
    }
  }
}

const INPUT_BUDGET_TOKENS = MODEL_CONTEXT - MAX_TOKENS_OUT - CONTEXT_SAFETY_MARGIN;
const INPUT_BUDGET_CHARS  = INPUT_BUDGET_TOKENS * CHARS_PER_TOKEN;

logger.info(`AI-Budget: context=${MODEL_CONTEXT} out=${MAX_TOKENS_OUT} inputBudget=${INPUT_BUDGET_TOKENS} tok (~${INPUT_BUDGET_CHARS} chars, ${CHARS_PER_TOKEN} chars/tok)`);

// Default-Temperaturen für lokale Provider – shared mit routes/proxies.js, damit
// Job-Pfad und Editor-Proxy-Pfad bei fehlender Env denselben Wert sehen.
const DEFAULT_OLLAMA_TEMP = 0.2;
const DEFAULT_OPENAI_COMPAT_TEMP = 0.1;

function ollamaTemp(override) {
  if (override != null && Number.isFinite(override)) return override;
  const v = Number(appSettings.get('ai.ollama.temperature'));
  return Number.isFinite(v) ? v : DEFAULT_OLLAMA_TEMP;
}
function openaiCompatTemp(override) {
  if (override != null && Number.isFinite(override)) return override;
  const v = Number(appSettings.get('ai.openai-compat.temperature'));
  return Number.isFinite(v) ? v : DEFAULT_OPENAI_COMPAT_TEMP;
}

// Anti-Loop: repeat_penalty pro lokalem Provider aus app_settings (1.0 = aus).
// Bricht Wiederholungsschleifen bei grammar-constrained JSON-Decoding.
function ollamaRepeatPenalty() {
  const v = Number(appSettings.get('ai.ollama.repeat_penalty'));
  return Number.isFinite(v) && v >= 1 ? v : 1.15;
}
function openaiCompatRepeatPenalty() {
  const v = Number(appSettings.get('ai.openai-compat.repeat_penalty'));
  return Number.isFinite(v) && v >= 1 ? v : 1.15;
}

// Reasoning/„Thinking" pro lokalem Provider. false = unterdrücken (spart Output-
// Tokens für die <think>-Spur, die wir ohnehin verwerfen), true = Modell denken
// lassen. Per-Call gelesen → Admin-Änderung greift ohne Server-Restart.
function ollamaThink() {
  return appSettings.get('ai.ollama.think') === true;
}
function openaiCompatThink() {
  return appSettings.get('ai.openai-compat.think') === true;
}

// Chat-spezifische Temperatur-Override (nur Ollama/Llama). Wenn `ai.chat_temperature`
// in app_settings gesetzt ist, übersteuert sie die Provider-Defaults – aber nur für
// Seiten- und Buch-Chat. Andere Job-Typen (Review, Lektorat, Komplett-Analyse) bleiben
// auf ihren Provider-Defaults, weil sie deterministische Analyse-Antworten brauchen.
function chatTemperature() {
  if (!appSettings.has('ai.chat_temperature')) return null;
  const n = Number(appSettings.get('ai.chat_temperature'));
  return Number.isFinite(n) ? n : null;
}

// ── Per-Call Claude-Auflösung (global ODER Per-Job-Override via ALS-Context) ──
// Die Komplettanalyse-Familie kann Modell, Kontextfenster und Output-Cap eigenständig
// setzen (z.B. Opus 4.8 mit 128K Output, während global Sonnet 4.6 / 64K läuft).
// setContext({ claudeModel, claudeContextWindow, claudeMaxTokensOut }) in
// routes/jobs/komplett/job.js; alles andere folgt den globalen ai.claude.*-Settings.
// modelOverride: optionaler per-Call-Modellname (Tiered Routing der Komplettanalyse —
// mechanische Extraktions-Calls auf ein günstigeres Modell als die Konsolidierung/das
// Urteil). Präzedenz: per-Call > Per-Job-ALS-Override > globales Setting. Parallel-safe,
// weil als Argument durchgereicht (kein ALS-Mutieren zwischen nebenläufigen Calls).
function _resolveClaudeModel(modelOverride) {
  return modelOverride || getContext().claudeModel || appSettings.get('ai.claude.model') || 'claude-sonnet-4-6';
}
function _resolveClaudeContextWindow() {
  return Number(getContext().claudeContextWindow) || Number(appSettings.get('ai.claude.context_window')) || 200000;
}
function _resolveClaudeMaxOut() {
  return Number(getContext().claudeMaxTokensOut) || Number(appSettings.get('ai.claude.max_tokens_out')) || MAX_TOKENS_OUT;
}

// Hartes Output-Token-Ceiling pro Claude-Modell: die API lehnt höhere `max_tokens` mit
// HTTP 400 (invalid_request_error) ab — und 400 ist NICHT in RETRY_STATUS, killt also den
// gesamten Job non-retryable. Eine Fehlkonfiguration (z.B. max_tokens_out.komplett=150000 für
// Opus, das nur 128000 erlaubt) wird hier still aufs Modell-Limit geklemmt statt zum Job-Kill
// zu führen. Konservativ am Modellstring (greift auch bei Suffix-Varianten wie "…[1m]"):
// Opus 4.x = 128000, alle übrigen (Sonnet/Haiku 4.x, ältere) = 64000.
function _claudeModelMaxOut(model) {
  return /claude-opus-4-/.test(String(model || '')) ? 128000 : 64000;
}

// Sampling-Parameter pro Claude-Modell. Opus 4.7+ haben temperature/top_p/top_k
// ENTFERNT – ein gesetzter Wert quittiert die API mit HTTP 400. Sonnet 4.6 und
// Opus 4.6 (und ältere) akzeptieren temperature weiterhin. Greift automatisch am
// Modellstring, damit ein Modellwechsel (global oder per-Job via ALS) nicht 400t.
// Trifft auch Suffix-Varianten (z.B. "claude-opus-4-8[1m]").
function _claudeAcceptsTemperature(model) {
  // claude-opus-4-7 / -4-8 / -4-9 / -4-1x … und künftige Opus-Generationen lehnen ab.
  return !/claude-opus-4-(?:[789]|\d\d)/.test(String(model || ''));
}
function _claudeSamplingParams(model) {
  return _claudeAcceptsTemperature(model) ? { temperature: 0.2 } : {};
}

// Adaptive Thinking pro Claude-Modell. Opus 4.7+ schreiben bei DEAKTIVIERTEM Thinking
// (= kein `thinking`-Feld) zunehmend Reasoning-Prosa in den sichtbaren Output. Bei den
// JSON-Only-Pipelines (Komplettanalyse/Kontinuität/Lektorat) bläht das die Antwort auf,
// bis sie ans max_tokens-Ceiling stösst (`stop_reason: max_tokens` → truncated → Wurf
// gemäss JSON-Only-Invariante) oder das JSON mit Prosa verunreinigt — Symptom: „kein
// Output". Adaptive Thinking verlagert das Reasoning in Thinking-Blöcke (`display`
// defaultet auf 'omitted'), der sichtbare Text-Stream bleibt reines JSON. `budget_tokens`
// ist auf Opus 4.7+ entfernt (400), adaptive hat keinen Budget-Parameter. Greift am
// Modellstring (gleiche Generationen-Erkennung wie _claudeAcceptsTemperature) → ein
// Modellwechsel via ALS-Override schaltet es automatisch passend. Sonnet 4.6 / Opus 4.6
// haben diese Regression nicht und bleiben unverändert (kein thinking-Feld).
function _claudeUsesAdaptiveThinking(model) {
  return /claude-opus-4-(?:[789]|\d\d)/.test(String(model || ''));
}
function _claudeThinkingParams(model) {
  return _claudeUsesAdaptiveThinking(model) ? { thinking: { type: 'adaptive' } } : {};
}

// Effort-Parameter (`output_config.effort`) steuert Denk-Tiefe + Token-Spend auf
// Opus 4.5+ und Sonnet 4.6. Wird ausschliesslich per ALS-Override (`claudeEffort`)
// gesetzt – aktuell nur vom Buch-Chat (ai.claude.effort.bookchat → _applyBookChatClaudeOverrides).
// Kein globaler ai.claude.effort-Read: ohne Override bleiben alle anderen Job-Pfade
// (Komplett/Review/Lektorat) unverändert (= API-Default 'high', kein Feld gesendet).
const _CLAUDE_EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function _resolveClaudeEffort() {
  const v = getContext().claudeEffort;
  const s = v != null ? String(v).trim().toLowerCase() : '';
  return _CLAUDE_EFFORT_VALUES.has(s) ? s : null;
}
// effort 400t auf Sonnet 4.5 / Haiku 4.5. `max` ist Opus-tier-only, `xhigh` Opus-4.7+-only.
// Tier-Mismatch wird auf 'high' geklemmt statt zu werfen (analog _claudeAcceptsTemperature).
function _claudeAcceptsEffort(model) {
  const m = String(model || '');
  return /claude-opus-4-(?:[5-9]|\d\d)/.test(m) || /claude-sonnet-4-(?:[6-9]|\d\d)/.test(m);
}
function _claudeOutputConfigParams(model) {
  let effort = _resolveClaudeEffort();
  if (!effort || !_claudeAcceptsEffort(model)) return {};
  const m = String(model || '');
  const isOpus = /claude-opus-4-/.test(m);
  const isOpus47plus = /claude-opus-4-(?:[789]|\d\d)/.test(m);
  if (effort === 'max' && !isOpus) effort = 'high';
  if (effort === 'xhigh' && !isOpus47plus) effort = 'high';
  return { output_config: { effort } };
}

// Per-Provider Context-Config. Boot-Konstanten (`INPUT_BUDGET_TOKENS` etc.)
// bleiben fuer Backwards-Compat — sie repraesentieren den Globalwert beim Server-Start.
// Code-Pfade mit auflusbarem userEmail nutzen `getContextConfigFor(provider)`, um
// das per-Provider-Limit zu lesen. Fehlt fuer Ollama/Llama ein eigenes context_window
// in app_settings, faellt es auf 32 000 (typisch fuer 32K-Modelle) zurueck — der
// Admin kann via `ai.ollama.context_window` / `ai.openai-compat.context_window` hoeher setzen.
const PROVIDER_CONTEXT_DEFAULTS = {
  claude: 200000,
  ollama: 32000,
  'openai-compat': 32000,
};

function getContextConfigFor(provider) {
  const p = VALID_PROVIDERS.has(provider) ? provider : 'claude';
  // Claude liest via Resolver (ALS-Per-Job-Override → global), damit die
  // Komplettanalyse mit eigenem Kontextfenster/Output-Cap rechnet, ohne die
  // globalen (z.B. Sonnet-) Calls zu beeinflussen.
  let ctx, maxOut;
  if (p === 'claude') {
    ctx = _resolveClaudeContextWindow();
    maxOut = _resolveClaudeMaxOut();
  } else {
    ctx = Number(appSettings.get(`ai.${p}.context_window`)) || PROVIDER_CONTEXT_DEFAULTS[p];
    maxOut = Number(appSettings.get(`ai.${p}.max_tokens_out`)) || MAX_TOKENS_OUT;
  }
  const safety = CONTEXT_SAFETY_MARGIN;
  const cpt = p === 'claude' ? CHARS_PER_TOKEN : (CHARS_PER_TOKEN || 4);
  const inputBudgetTokens = Math.max(2000, ctx - maxOut - safety);
  return {
    provider: p,
    contextWindow: ctx,
    maxTokensOut: maxOut,
    charsPerToken: cpt,
    inputBudgetTokens,
    inputBudgetChars: inputBudgetTokens * cpt,
  };
}

module.exports = {
  VALID_PROVIDERS, resolveProvider,
  CHARS_PER_TOKEN, MAX_TOKENS_OUT, MODEL_CONTEXT, CONTEXT_SAFETY_MARGIN,
  INPUT_BUDGET_TOKENS, INPUT_BUDGET_CHARS,
  DEFAULT_OLLAMA_TEMP, DEFAULT_OPENAI_COMPAT_TEMP,
  ollamaTemp, openaiCompatTemp, ollamaRepeatPenalty, openaiCompatRepeatPenalty,
  ollamaThink, openaiCompatThink, chatTemperature,
  getContextConfigFor,
  _resolveClaudeModel, _resolveClaudeContextWindow, _resolveClaudeMaxOut, _claudeModelMaxOut,
  _claudeSamplingParams, _claudeThinkingParams, _claudeOutputConfigParams,
  _claudeAcceptsTemperature, _claudeUsesAdaptiveThinking, _claudeAcceptsEffort,
};
