'use strict';
// Nachbearbeitung roher Lektorat-Findings: validieren → Nachbarseiten-Findings
// verwerfen → dedupen → stilistischen Cap anwenden. Pure bis auf den Admin-Regler
// `ai.lektorat_stylistic_cap` – testbar ohne AI/DB.

const appSettings = require('../../lib/app-settings');
const { dropNeighbourFindings } = require('./lektorat-context');
const { splitEnabled, objektivRuns, consensusThreshold } = require('./lektorat-split');

// Erklärungs-Phrasen, mit denen das Modell einen Eintrag selbst widerruft.
// Sprach-agnostisches letztes Sicherheitsnetz: Lokale Modelle (Ollama/Llama)
// ignorieren die FILTER-PFLICHT im Prompt häufig, und bei englischsprachigen
// Büchern formuliert auch Claude die Selbst-Widerrufung auf Englisch («is in fact
// correct», «this entry is withdrawn») – die rein deutschen Prompt-Filter greifen
// dann nicht. Beide Sprachräume hier abgedeckt.
// Nur eindeutige Widerrufsformen: blosse Abschwächer wie «möglicherweise» oder ein
// freistehendes «vertretbar» stehen ebenso in echten Befunden («Die Behauptung ist
// möglicherweise nicht belegt») und dürfen keinen Eintrag kippen. «vertretbar»/
// «akzeptabel» zählen nur als Prädikat über die beanstandete Stelle.
const NON_ERROR_RE = /korrektur entfällt|kein fehler|kein mangel|ist korrekt\b|nicht falsch|eintrag entfällt|im schweizer kontext|(?:ist|sind|bleibt|bleiben) (?:hier |so |durchaus |grundsätzlich |stilistisch |sprachlich )?(?:vertretbar|akzeptabel)\b|\bwithdrawn\b|withdraw this entry|\bnot an error\b|\bno error\b|\bnot a mistake\b|\bnot wrong\b|is (?:in fact |actually |indeed |grammatically )?correct here|is (?:in fact|actually|indeed|grammatically) correct\b|correct as (?:written|is|it stands)|no correction (?:needed|necessary|required)|no change (?:needed|necessary|required)|leave (?:it |this )?as[- ]is|perfectly (?:fine|correct|acceptable|valid)/i;

// Identische Findings (gleicher typ + original + korrektur) entfernen.
// AI-Output enthält gelegentlich byte-gleiche Duplikate (insb. bei mehrfachem
// Vorkommen desselben Tokens). Da `original` für die Replace-Logik als
// Match-String dient, reicht ein Eintrag.
function dedupFehler(fehler) {
  const seen = new Set();
  return fehler.filter(f => {
    const k = `${f.typ ?? ''}|${f.original ?? ''}|${f.korrektur ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Subjektiv-stilistische Fehlertypen: exakt die Liste, für die der Prompt
// (SCHWERE-SCHWELLE-Block) eine Mengen-Obergrenze verhängt. Mechanische/objektive
// Fehler (rechtschreibung, grammatik inkl. Zeichensetzung, tempuswechsel,
// perspektivbruch, dialogformat) und Konsistenz-Befunde (namens-/figuren-/
// schauplatzmerkmal, anrede, begriffsinkonsistenz, autorenform, unbelegt) fehlen
// hier bewusst – sie werden NIE gekappt.
// CJS-Spiegel von STILISTISCHE_TYPEN in public/js/prompts/lektorat-typen.js (der
// Prompt-Text wird dort erzeugt); Drift ist durch
// tests/unit/lektorat-typen-drift.test.mjs gegated.
const STYLISTIC_TYPEN = new Set([
  'stil', 'satzbau', 'schwaches_verb', 'fuellwort', 'filterwort',
  'klischee', 'ki_geruch', 'show_vs_tell', 'passiv', 'pleonasmus', 'wiederholung',
  'hedging', 'amtsdeutsch',
]);

const DEFAULT_STYLISTIC_CAP = 10;

// Deterministischer Backstop zur Prompt-Regel „max ~N stilistische Findings".
// Modelle zählen und selbst-limitieren unzuverlässig – der Prompt bittet zwar um
// harte Priorisierung, aber wenn das Modell 40 schwache Stil-Findings zurückgibt,
// erzwingt dieser Handler-Filter die Grenze verlässlich. Objektive Fehler bleiben
// vollständig erhalten; nur die im STYLISTIC_TYPEN-Set gelisteten Typen werden
// nach Erreichen von `cap` verworfen. Reihenfolge bleibt erhalten (der Prompt hat
// nach Textposition sortiert).
function capStylisticFehler(fehler, cap = DEFAULT_STYLISTIC_CAP) {
  if (!Array.isArray(fehler)) return fehler;
  let kept = 0;
  return fehler.filter(f => {
    if (!STYLISTIC_TYPEN.has(f?.typ)) return true;   // objektiv/Konsistenz → nie kappen
    if (kept < cap) { kept++; return true; }
    return false;
  });
}

// Cap aus app_settings (Admin-tunebar), Default 10 – analog ai.lektorat_batch_concurrency.
// Derselbe Wert steht als Mengen-Obergrenze im Prompt (promptOpts.stylisticCap): dort
// priorisiert das Modell nach Schwere, dieser Backstop schneidet nur nach Textposition.
// Laufen beide auseinander, kappt der Backstop die guten Funde am Seitenende.
function stylisticCap() {
  const n = parseInt(appSettings.get('ai.lektorat_stylistic_cap'), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STYLISTIC_CAP;
}

// Lauf-Parameter, die den Output formen, aber in keinem Prompt-String stecken: die
// Stil-Obergrenze und die Pass-Aufteilung (Split an/aus, Zahl der Objektiv-Läufe,
// Konsens-Schwelle). Gehören in die Cache-Signatur, sonst liefert der Cache nach
// einer Umstellung das Ergebnis der alten Konfiguration.
function _runSig(local) {
  const split = !local && splitEnabled();
  return { sc: stylisticCap(), sp: split ? `${objektivRuns()}/${consensusThreshold()}` : 0 };
}

function validateLektoratFehler(fehler, locale, validTypen) {
  const isCH = locale === 'de-CH';
  return fehler
    // `kontext` ist Legacy-Feld aus PROMPTS_VERSION <=15: nirgends gerendert,
    // AI halluzinierte oft (nicht-substring von `original`). Defensiv strippen,
    // damit alte Cache-Rows und vereinzelte AI-Antworten kein totes Feld mitschleppen.
    .map(f => { const { kontext, ...rest } = f; return { ...rest, typ: rest.typ?.toLowerCase?.() }; })
    .filter(f => validTypen.has(f.typ))
    // Vorschlag == Original (1:1, nach trim) ist kein Fehler – für alle Typen skippen
    .filter(f => !f.korrektur || f.korrektur.trim() !== f.original?.trim())
    // stil braucht zusätzlich eine nicht-leere Korrektur
    .filter(f => f.typ !== 'stil' || !!f.korrektur?.trim())
    // Einträge deren Erklärung verrät, dass es kein echter Fehler ist
    .filter(f => !NON_ERROR_RE.test(f.erklaerung || ''))
    // de-CH: Einträge filtern, deren einziger Unterschied ss↔ß ist
    .filter(f => {
      if (!isCH || !f.original || !f.korrektur) return true;
      return f.original.replace(/ß/g, 'ss') !== f.korrektur.replace(/ß/g, 'ss');
    })
    // de-CH: verbleibende Korrekturen bereinigen – ß→ss
    .map(f => {
      if (isCH && f.korrektur) f.korrektur = f.korrektur.replace(/ß/g, 'ss');
      return f;
    });
}

// Vollständige Nachbearbeitung eines rohen fehler-Arrays. Einziger Chokepoint für
// frische und gecachte Ergebnisse (lektorat-page.js#checkOnePage).
// `validTypen` ist das Typ-Set des Buchtyp-Profils – Findings mit profilfremdem
// Typ werden verworfen. Greift auch auf dem Cache-Pfad: eine Buchtyp-Umstellung
// soll narrativ geprägte Alt-Findings nicht durchlassen.
// `neighbour` = { text, excerpts } der Seite und ihrer Kontext-Auszüge.
function finalizeFehler(fehler, locale, validTypen, neighbour = null) {
  const valid = validateLektoratFehler(fehler, locale, validTypen);
  const own = neighbour ? dropNeighbourFindings(valid, neighbour.text, neighbour.excerpts) : valid;
  return capStylisticFehler(dedupFehler(own), stylisticCap());
}

module.exports = {
  NON_ERROR_RE, STYLISTIC_TYPEN,
  dedupFehler, capStylisticFehler, stylisticCap, _runSig,
  validateLektoratFehler, finalizeFehler,
};
