#!/usr/bin/env node
'use strict';
// PreToolUse-Hook (Edit|Write|MultiEdit): prueft den zu schreibenden Text gegen
// mehrere harte CLAUDE.md-Regeln, BEVOR die Aenderung landet.
//   • Inline-Styles in public/**/*.html  → BLOCK (Regel "Styles nur in public/css/")
//   • datetime('now') in db/routes/lib    → WARN  (WHERE-Vergleich ist erlaubt)
//   • natives <select>/<input type=number> in Partials → WARN (combobox/numInput-Pflicht,
//                                                              dok. Ausnahmen moeglich)
//   • Roh-SQL-WRITE (INSERT/UPDATE/DELETE) auf pages/chapters/books ausserhalb
//     lib/content-store/ → WARN (Regel "Content-Store-Facade als einziger Eintrittspunkt";
//     sync.js + dev-seed.js sind ausgenommen, Lese-JOINs sind erlaubt)
//   • toLocaleDateString/toLocaleTimeString/Intl.DateTimeFormat ohne tzOpts()/timeZone
//     in public/js → WARN (Regel "Frontend-Datums-Display nur via tzOpts()"; reine
//     Zahlen-toLocaleString sind bewusst NICHT erfasst)
// Geprueft wird nur der NEU geschriebene Text (Write.content / Edit.new_string /
// MultiEdit.edits[].new_string), nicht der Bestand. Block via Exit 2 + stderr;
// Warnungen non-blocking via additionalContext. Die WARN-Regeln sind bewusst kein
// harter Gate: der Bestand hat legitime Ausnahmen (Metadaten-Writes, Kalender-Labels),
// ein CI-grep waere sofort rot — hier reicht der Frueh-Hinweis pro Aenderung.

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
  const isPublicJs = /\/public\/js\/.+\.js$/.test(p);
  // Content-Store-Facade-Regel gilt fuer Route-/Job-/Lib-Handler, NICHT fuer die
  // Facade selbst (lib/content-store/), den WordPress-Sync-Layer (sync.js) oder
  // das Dev-Seeding (dev-seed.js) — dort ist Roh-SQL auf diesen Tabellen legitim.
  const isContentWriteScope = /\/(?:routes|lib)\/.+\.js$/.test(p)
    && !/\/lib\/content-store\//.test(p)
    && !/\/routes\/sync\.js$/.test(p)
    && !/\/lib\/dev-seed\.js$/.test(p);

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

  // Roh-SQL-WRITE auf Buchinhalts-Tabellen ausserhalb der Content-Store-Facade.
  // Nur Schreib-Statements (INSERT/UPDATE/DELETE) — Lese-JOINs auf page_name /
  // chapter_name fuer Anzeige-Zwecke sind erlaubt und daher hier nicht erfasst.
  if (isContentWriteScope
      && /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(?:pages|chapters|books)\b/i.test(text)) {
    warns.push('Roh-SQL-Write auf pages/chapters/books ausserhalb lib/content-store/: '
      + 'Buchinhalt (Body/Struktur) laeuft ueber require(\'lib/content-store\') (Regel "Content-Store-Facade als einziger Eintrittspunkt"). '
      + 'Reine Metadaten-Writes (z.B. books.owner_email) sind ein legitimer Grenzfall — dann bewusst so lassen.');
  }

  // Datums-/Uhrzeit-Display ohne tzOpts()/timeZone. Bewusst nur die Date-only-APIs
  // (toLocaleDateString/-TimeString) + Intl.DateTimeFormat — reine Zahlen-
  // toLocaleString({ minimumFractionDigits }) sind laut Regel ausgenommen und
  // wuerden sonst massenhaft falsch anschlagen.
  if (isPublicJs) {
    const dateCall = /(?:toLocale(?:Date|Time)String\s*\(|Intl\.DateTimeFormat\s*\()/;
    const offending = text.split('\n').some((line) =>
      dateCall.test(line) && !/tzOpts/.test(line) && !/timeZone/.test(line));
    if (offending) {
      warns.push('Datums-/Uhrzeit-Display ohne tzOpts(): toLocaleDateString/-TimeString bzw. Intl.DateTimeFormat '
        + 'immer mit tzOpts(opts) aus public/js/utils.js wrappen (mergt timeZone: appTimezone) — sonst zeigt die '
        + 'Anzeige die Browser-TZ statt app.timezone. Explizites timeZone (z.B. TZ-agnostische Kalender-Labels) ist ausgenommen.');
    }
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
