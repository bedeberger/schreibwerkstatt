#!/usr/bin/env node
'use strict';
// PreToolUse-Hook (Edit|Write|MultiEdit): prueft den zu schreibenden Text gegen
// drei harte CLAUDE.md-Regeln, BEVOR die Aenderung landet.
//   • Inline-Styles in public/**/*.html  → BLOCK (Regel "Styles nur in public/css/")
//   • datetime('now') in db/routes/lib    → WARN  (WHERE-Vergleich ist erlaubt)
//   • natives <select>/<input type=number> in Partials → WARN (combobox/numInput-Pflicht,
//                                                              dok. Ausnahmen moeglich)
// Geprueft wird nur der NEU geschriebene Text (Write.content / Edit.new_string /
// MultiEdit.edits[].new_string), nicht der Bestand. Block via Exit 2 + stderr;
// Warnungen non-blocking via additionalContext.

const path = require('node:path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }
  const ti = payload.tool_input || {};
  const fp = ti.file_path || '';
  if (!fp) process.exit(0);
  const p = fp.split(path.sep).join('/');

  // Neu geschriebenen Text einsammeln
  let text = '';
  if (typeof ti.content === 'string') text += ti.content + '\n';
  if (typeof ti.new_string === 'string') text += ti.new_string + '\n';
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) if (e && typeof e.new_string === 'string') text += e.new_string + '\n';
  }
  if (!text.trim()) process.exit(0);

  const isPublicHtml = /\/public\/.+\.html$/.test(p);
  const isPartial = /\/public\/partials\/.+\.html$/.test(p);
  const isServerCode = /\/(?:db|routes|lib)\/.+\.js$/.test(p);

  const blocks = [];
  const warns = [];

  if (isPublicHtml) {
    // Inline-style-Attribut (Alpine :style / x-bind:style sind erlaubt → Lookbehind)
    if (/(?<![:\-])\bstyle\s*=\s*["']/.test(text) || /<style[\s>]/i.test(text)) {
      blocks.push(
        'Inline-Styles in HTML sind verboten (CLAUDE.md "Styles nur in public/css/"). ' +
        'Kein style="…"-Attribut und kein <style>-Block — CSS gehoert in public/css/ (Akzent via --card-accent, ' +
        'dynamische Werte via CSS-Custom-Prop, z.B. :style="{ \'--progress\': x + \'%\' }").',
      );
    }
  }

  if (isPartial) {
    if (/<select[\s>]/i.test(text)) {
      warns.push('Natives <select> in einem Partial: Regel verlangt Alpine.data(\'combobox\'). Nur mit zwingendem Grund (z.B. nativer Mobile-Picker) belassen.');
    }
    if (/<input[^>]*\btype\s*=\s*["']number["']/i.test(text)) {
      warns.push('Natives <input type="number">: Regel verlangt Alpine.data(\'numInput\') (de-CH-Formatierung). Bitte umstellen.');
    }
  }

  if (isServerCode && /datetime\(\s*['"]now['"]\s*\)/i.test(text)) {
    warns.push('datetime(\'now\') gefunden: in INSERT/UPDATE + Schema-Defaults verboten → ${NOW_ISO_SQL} aus db/now.js verwenden. Nur in reinen WHERE-Vergleichen (datetime(col) < datetime(\'now\')) erlaubt.');
  }

  if (blocks.length) {
    process.stderr.write('[style-guard] Aenderung blockiert:\n- ' + blocks.join('\n- ') +
      (warns.length ? '\nAusserdem: ' + warns.join(' | ') : '') + '\n');
    process.exit(2);
  }

  if (warns.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: '[style-guard] Hinweis: ' + warns.join(' | '),
      },
    }));
  }
  process.exit(0);
});
