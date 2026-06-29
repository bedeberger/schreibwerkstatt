#!/usr/bin/env node
'use strict';
// PostToolUse-Hook (Edit|Write|MultiEdit): prueft nach jeder Aenderung an einer
// Locale-Datei (public/js/i18n/{de,en}.json), dass (a) beide JSON-Dateien
// weiterhin parsebar sind — fangt den "curly quote → JSON-Parse-Crash der ganzen
// SPA"-Fall sofort ab — und (b) der Key-Satz beider Locales deckungsgleich ist
// (Regel: jeder String in DE und EN). Reiner Reminder/Warner, blockt nichts.

const fs = require('node:fs');
const path = require('node:path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let fp = '';
  try {
    fp = (JSON.parse(raw || '{}').tool_input || {}).file_path || '';
  } catch {
    process.exit(0);
  }
  const p = fp.split(path.sep).join('/');
  if (!/\/public\/js\/i18n\/(?:de|en)\.json$/.test(p)) process.exit(0);

  const root = path.resolve(__dirname, '..', '..');
  const files = {
    de: path.join(root, 'public', 'js', 'i18n', 'de.json'),
    en: path.join(root, 'public', 'js', 'i18n', 'en.json'),
  };

  const parsed = {};
  const out = [];
  for (const [loc, file] of Object.entries(files)) {
    try {
      parsed[loc] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      out.push(`${loc}.json laesst sich NICHT parsen: ${e.message}`);
      out.push('  → die SPA crasht beim Laden dieser Locale. Sofort fixen (haeufig: straight " statt „…" in DE-Strings).');
    }
  }

  if (parsed.de && parsed.en) {
    const deKeys = new Set(Object.keys(parsed.de));
    const enKeys = new Set(Object.keys(parsed.en));
    const missingInEn = [...deKeys].filter((k) => !enKeys.has(k));
    const missingInDe = [...enKeys].filter((k) => !deKeys.has(k));
    const fmt = (arr) => arr.slice(0, 12).join(', ') + (arr.length > 12 ? ` … (+${arr.length - 12})` : '');
    if (missingInEn.length) out.push(`Keys nur in DE, fehlen in EN (${missingInEn.length}): ${fmt(missingInEn)}`);
    if (missingInDe.length) out.push(`Keys nur in EN, fehlen in DE (${missingInDe.length}): ${fmt(missingInDe)}`);
  }

  if (out.length) {
    console.log('[i18n-check] ' + out.join('\n'));
  }
  process.exit(0);
});
