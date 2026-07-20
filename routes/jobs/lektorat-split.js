'use strict';
// Claude-Split des Seiten-Lektorats: Objektiv-Pass (K× parallel, Konsens) +
// Stil-Pass (1×), konsolidiert zu einer dublettenfreien fehler-Liste. Ausgelagert
// aus lektorat.js, damit der Job-Router schlank bleibt. Lokale Provider splitten
// nicht (K=1 → alter kombinierter Single-Call).

const { aiCall, i18nError } = require('./shared');
const appSettings = require('../../lib/app-settings');
const { consensusFindings, mergePasses } = require('../../lib/lektorat-consolidate');

// Anzahl paralleler Objektiv-Läufe für den Konsens + Konsens-Schwelle.
// Admin-tunebar (ai.lektorat_objective_runs / ai.lektorat_consensus_threshold);
// Defaults kommen aus lib/app-settings.js (3 bzw. 2).
function objektivRuns() {
  const n = parseInt(appSettings.get('ai.lektorat_objective_runs'), 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
function consensusThreshold() {
  const n = parseInt(appSettings.get('ai.lektorat_consensus_threshold'), 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

// Kern-KI-Schritt des Lektorats. Cloud (Claude): Objektiv-Pass K× (Konsens ≥
// Schwelle → maximale Präzision, filtert lauf-instabile Einzelgänger) PLUS
// Stil-Pass 1× (kombinierter Prompt ohne objektive Typen, liefert szenen/
// stilanalyse/fazit), danach Span-Overlap-Merge zu einer dublettenfreien
// fehler-Liste. Objektiv-Läufe werden gestaffelt, damit der Prompt-Cache greift.
// Lokale Provider: genau EIN kombinierter Call, unverändert. Rückgabe hat stets
// die Form { fehler, szenen, stilanalyse, fazit } — Cache/History/Frontend gleich.
async function lektoratAnalyze({ jobId, tok, text, local, prompts, system, promptOpts, single, fromPct, toPct }) {
  const {
    buildLektoratPrompt, buildBatchLektoratPrompt,
    buildObjektivLektoratPrompt, buildStilLektoratPrompt,
    SCHEMA_LEKTORAT, SCHEMA_LEKTORAT_OBJEKTIV,
  } = prompts;
  const K = local ? 1 : objektivRuns();

  if (K <= 1) {
    const prompt = single ? buildLektoratPrompt(text, promptOpts) : buildBatchLektoratPrompt(text, promptOpts);
    const result = await aiCall(jobId, tok, prompt, system, fromPct, toPct, 5000, 0.2, null, undefined, SCHEMA_LEKTORAT);
    if (!Array.isArray(result?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
    return result;
  }

  if (!tok.inflight) tok.inflight = new Map();   // parallele Live-Token-Summierung
  const objektivOpts = {
    figuren: promptOpts.figuren, figurenBeziehungen: promptOpts.figurenBeziehungen,
    orte: promptOpts.orte, pageName: promptOpts.pageName, chapterName: promptOpts.chapterName,
    langCode: promptOpts.langCode,
  };
  const objektivPrompt = buildObjektivLektoratPrompt(text, objektivOpts);
  const stilPrompt = buildStilLektoratPrompt(text, promptOpts);
  const objCall = () => aiCall(jobId, tok, objektivPrompt, system, null, null, 4000, 0.2, null, undefined, SCHEMA_LEKTORAT_OBJEKTIV);

  // Stil-Pass parallel starten – eigener User-Prompt, profitiert nicht vom
  // Objektiv-Cache (teilt nur den kleinen System-Block).
  const stilPromise = aiCall(jobId, tok, stilPrompt, system, null, null, 5000, 0.2, null, undefined, SCHEMA_LEKTORAT);

  // Objektiv-Läufe STAFFELN statt sofort alle parallel: den ersten Lauf voll
  // abschliessen, damit er den Prompt-Cache primet (voller Input = System +
  // identischer Objektiv-Prompt). Erst danach die restlichen K-1 parallel – die
  // lesen dann den warmen Cache (cache_read statt K× Voll-Input). Gleichzeitiges
  // Feuern verfehlt den Cache komplett (jeder Lauf zahlt den vollen Input).
  const objRuns = [await objCall()];
  if (K > 1) {
    const rest = await Promise.all(Array.from({ length: K - 1 }, objCall));
    objRuns.push(...rest);
  }
  const stilResult = await stilPromise;

  if (!Array.isArray(stilResult?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
  const objFehlerRuns = objRuns.map(r => (Array.isArray(r?.fehler) ? r.fehler : []));
  const objConsensus = consensusFindings(objFehlerRuns, text, { threshold: consensusThreshold() });
  const fehler = mergePasses([objConsensus, stilResult.fehler], text);
  return { fehler, szenen: stilResult.szenen, stilanalyse: stilResult.stilanalyse, fazit: stilResult.fazit };
}

module.exports = { lektoratAnalyze, objektivRuns };
