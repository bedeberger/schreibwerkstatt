// Guard-Test für die Action-Icon-Library (DESIGN.md → „Action-Icon-Library").
//
// Verbindliche Frontend-Invariante: Aktions-Buttons nutzen Sprite-Icons
// (<svg class="icon"><use href="/icons.svg#…"/></svg>), keine „klassischen"
// Unicode-Glyphen als Icon (×, ✕, ↑, ↓, ‹, › …). Dieser Test fällt rot, sobald
// ein neues Feature ein Glyph-Icon oder einen leeren .icon-btn einführt — so
// bleibt die Frontend-Erfahrung einheitlich, ohne dass es jemand manuell prüft.
//
// NICHT geprüft (bewusst): Text-Labels auf primären Formular-Aktionen
// (z.B. „Speichern" im Settings-Footer). Die behalten ihr Label — Icon-only
// gilt nur für Toolbars, Header-Action-Cluster, Close- und Inline-Aktionen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PARTIALS_DIR = fileURLToPath(new URL('../../public/partials', import.meta.url));
const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

// Glyphen, die als Icon-Ersatz verboten sind (Sprite statt Unicode).
// `›`/`‹` sind hier NICHT enthalten: sie leben ausschliesslich als
// visuell versteckter Fallback in `.history-chevron`-SPANs (kein Button),
// und dieser Test scannt nur <button>-Inhalte.
const FORBIDDEN_GLYPHS = new Set([
  '×', '✕', '✖', '⨯', '↑', '↓', '←', '→', '«', '»',
  '⤢', '⛶', '▾', '▴', '▸', '◂', '＋', '−',
]);
const FORBIDDEN_ENTITIES = [/&#x2715;/i, /&#215;/i, /&#xd7;/i, /&times;/i, /&#x2191;/i, /&#x2193;/i];

function sources() {
  const files = readdirSync(PARTIALS_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => [`partials/${f}`, readFileSync(`${PARTIALS_DIR}/${f}`, 'utf8')]);
  files.push(['index.html', readFileSync(INDEX_HTML, 'utf8')]);
  return files;
}

// Buttons verschachteln sich nicht → nicht-gieriges Matching reicht.
function buttons(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map(m => ({ attrs: m[1], inner: m[2], raw: m[0] }));
}

function visibleText(inner) {
  return inner.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
}

test('Buttons: keine Unicode-Glyphen als Icon-Inhalt (klassische Buttons)', () => {
  const offenders = [];
  for (const [file, html] of sources()) {
    for (const b of buttons(html)) {
      if (FORBIDDEN_ENTITIES.some(re => re.test(b.inner))) {
        offenders.push(`${file}: Glyph-Entity in Button → Sprite-Icon nutzen: ${b.raw.slice(0, 90)}`);
        continue;
      }
      const txt = visibleText(b.inner);
      if (txt && [...txt].every(ch => FORBIDDEN_GLYPHS.has(ch))) {
        offenders.push(`${file}: Glyph-Icon "${txt}" → <svg class="icon"><use href="/icons.svg#…"/></svg>`);
      }
    }
  }
  assert.equal(
    offenders.length, 0,
    `Klassische Glyph-Buttons gefunden (DESIGN.md → Action-Icon-Library):\n${offenders.join('\n')}`,
  );
});

test('Buttons: jeder .icon-btn enthält ein Sprite-Icon (<svg class="icon"><use…>)', () => {
  const offenders = [];
  for (const [file, html] of sources()) {
    for (const b of buttons(html)) {
      if (!/\bclass="[^"]*\bicon-btn\b/.test(b.attrs)) continue;
      const hasSvgIcon = /<svg\b[^>]*\bclass="[^"]*\bicon\b/.test(b.inner) && /<use\b/.test(b.inner);
      if (!hasSvgIcon) {
        offenders.push(`${file}: .icon-btn ohne <svg class="icon"><use…>: <button${b.attrs.slice(0, 80)}>`);
      }
    }
  }
  assert.equal(
    offenders.length, 0,
    `.icon-btn ohne Sprite-Icon (DESIGN.md → Action-Icon-Library):\n${offenders.join('\n')}`,
  );
});
