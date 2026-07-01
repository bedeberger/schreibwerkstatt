'use strict';
// Manuelle Output-Qualitäts-Eval für das Lektorat – NICHT Teil von `npm test`
// (macht echte KI-Calls, kostet Tokens, braucht einen konfigurierten Provider).
//
//   npm run eval:lektorat
//
// Baut für jeden Gold-Fall (eval/lektorat/gold.mjs) den echten Lektorat-Prompt,
// ruft callAI mit dem konfigurierten Provider (Claude/Ollama/OpenAI-compat) und
// bewertet die Findings gegen die kuratierten Erwartungen:
//   • RECALL   – Anteil der gepflanzten objektiven Fehler, die gefunden wurden.
//   • FALSE-POS – Findings, die einen als KORREKT markierten Satz anstreichen.
//
// So wird eine Prompt-Änderung messbar: vorher/nachher laufen lassen und die
// Recall-/FP-Zahlen vergleichen. Eine Handvoll Fälle ist keine Statistik, aber
// ein verlässlicher Regress-Wecker.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const ROOT = path.resolve(__dirname, '..');
  const appSettings = require('../lib/app-settings');
  const { callAI, parseJSON, resolveProvider } = require('../lib/ai');

  const provider = resolveProvider();
  if (provider === 'claude' && !appSettings.get('ai.claude.api_key')) {
    console.error('\n  Kein Claude-API-Key konfiguriert (ai.claude.api_key). Eval abgebrochen.');
    console.error('  Setze den Key im Admin oder wechsle den Provider (ai.provider).\n');
    process.exit(2);
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
  const prompts = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts.js')).href);
  prompts.configurePrompts(cfg, provider);
  const { GOLD_CASES } = await import(pathToFileURL(path.join(ROOT, 'eval', 'lektorat', 'gold.mjs')).href);

  const systemPrompt = prompts.SYSTEM_LEKTORAT;
  const schema = prompts.SCHEMA_LEKTORAT;

  // Überlappung: findet f.original den Ziel-String (in beide Richtungen, da
  // finding.original mal die ganze Phrase, mal nur ein Teilwort trifft).
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const overlaps = (original, target) => {
    const a = norm(original), b = norm(target);
    return !!a && !!b && (a.includes(b) || b.includes(a));
  };

  console.log(`\n  Lektorat-Eval · Provider: ${provider} · ${GOLD_CASES.length} Fälle\n`);

  let totCatch = 0, totFound = 0, totFP = 0, totFindings = 0;
  const rows = [];

  for (const c of GOLD_CASES) {
    const userPrompt = prompts.buildLektoratPrompt(c.text, { langCode: 'de' });
    let findings = [];
    let err = null;
    try {
      const res = await callAI(userPrompt, systemPrompt, null, null, null, provider, schema);
      const parsed = typeof res.text === 'string' ? parseJSON(res.text) : res.text;
      findings = Array.isArray(parsed?.fehler) ? parsed.fehler : [];
    } catch (e) {
      err = e.message;
    }

    const foundFlags = c.mustCatch.map(m => findings.some(f => overlaps(f.original, m.needle)));
    const found = foundFlags.filter(Boolean).length;
    const fps = findings.filter(f => (c.cleanSpans || []).some(span => overlaps(f.original, span)));

    totCatch += c.mustCatch.length;
    totFound += found;
    totFP += fps.length;
    totFindings += findings.length;

    rows.push({ c, found, foundFlags, fps, findings, err });
  }

  // Detail-Report
  for (const { c, found, foundFlags, fps, findings, err } of rows) {
    if (err) { console.log(`  ✖ ${c.id}: KI-Fehler – ${err}\n`); continue; }
    const recall = c.mustCatch.length ? `${found}/${c.mustCatch.length}` : '– (keine)';
    console.log(`  ${c.id}`);
    console.log(`     Recall: ${recall}   Findings gesamt: ${findings.length}   False-Positives: ${fps.length}`);
    c.mustCatch.forEach((m, i) => {
      console.log(`       ${foundFlags[i] ? '✔' : '✗ VERPASST'}  [${m.typ}] «${m.needle}»`);
    });
    fps.forEach(f => console.log(`       ⚠ FALSE-POS  [${f.typ}] «${f.original}»`));
    console.log('');
  }

  // Aggregat
  const recallPct = totCatch ? Math.round((totFound / totCatch) * 100) : 100;
  console.log('  ────────────────────────────────────────');
  console.log(`  GESAMT   Recall: ${totFound}/${totCatch} (${recallPct}%)   False-Positives: ${totFP}   Findings: ${totFindings}`);
  const ok = recallPct >= 80 && totFP === 0;
  console.log(`  Verdikt: ${ok ? '✔ gut' : '⚠ Aufmerksamkeit nötig'} (Ziel: Recall ≥ 80 %, 0 False-Positives)\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
