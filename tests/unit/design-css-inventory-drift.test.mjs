// Drift guard: jede in public/index.html via <link> eingebundene CSS-Datei
// (css/…) MUSS im „CSS-File-Inventar" von DESIGN.md als (public/css/…)-Referenz
// stehen. Hält die harte Regel „UI-Patterns nur aus DESIGN.md" + das Inventar
// gegen index.html synchron — neue CSS-Datei eingehängt, aber nicht dokumentiert
// → CI rot.
//
// Reverse-Richtung wird NICHT geprüft: DESIGN.md dokumentiert bewusst auch
// Dateien, die nicht im SPA-Bundle hängen (share/-Module via share.html,
// landing.css). vendor/-Stylesheets sind ausgenommen (kein eigener Code).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const design = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8');

// Nur projekteigene CSS unter css/… (vendor/ ausgeschlossen).
const linked = [...html.matchAll(/<link[^>]+href="(css\/[^"]+\.css)"/g)].map((m) => m[1]);

test('jede CSS-<link>-Datei aus index.html steht im DESIGN.md-Inventar', () => {
  assert.ok(linked.length > 0, 'keine CSS-Links in index.html gefunden — Regex kaputt?');
  const missing = linked.filter((rel) => !design.includes(`(public/${rel})`));
  assert.deepEqual(
    missing,
    [],
    `Diese CSS-Dateien sind in index.html verlinkt, fehlen aber im „CSS-File-Inventar" von DESIGN.md:\n  - ${missing.join('\n  - ')}\n` +
      'Pro Datei eine Inventar-Zeile im passenden Abschnitt ergänzen.',
  );
});
