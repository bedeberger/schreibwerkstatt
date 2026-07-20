// Figuren-Werkstatt: der Consistency-Check erdet die Mindmap-Prüfung an echten
// Manuskript-Textstellen (semantische Suche). Der Prompt-Builder muss die Belege +
// den Abgleich-Prüfpunkt einbetten — und ohne Belege unverändert bleiben.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildConsistencyPrompt } from '../../public/js/prompts/figur-werkstatt.js';

const MM = { data: { id: 'root', topic: 'Mara', children: [] } };
const TB = [
  { page_id: 12, snippet: 'Mara lachte selten und misstraute jedem Fremden.' },
  { page_id: 40, snippet: 'Sie öffnete sich zögernd gegenüber dem alten Fischer.' },
];

test('mit Textbelegen: Prosa-Block + Abgleich-Prüfpunkt erscheinen', () => {
  const p = buildConsistencyPrompt('Mara', 'protagonist', MM, '', [], [], [], null, [], TB);
  assert.match(p, /SO IST DIE FIGUR IM MANUSKRIPT GESCHRIEBEN/);
  assert.match(p, /Mindmap-Plan vs\. geschriebene Figur/);
  assert.match(p, /Mara lachte selten/);          // Wortlaut zitiert
  assert.match(p, /kein Beweis/);                   // Ähnlichkeits-Caveat
  assert.match(p, /KEINE Stelle, ist das KEIN Fehler/); // Unwritten-Guard
});

test('ohne Textbelege: kein Block, kein Prüfpunkt (Rückwärtskompat)', () => {
  const p = buildConsistencyPrompt('Mara', 'protagonist', MM, '', [], []);
  assert.doesNotMatch(p, /SO IST DIE FIGUR IM MANUSKRIPT GESCHRIEBEN/);
  assert.doesNotMatch(p, /Mindmap-Plan vs\. geschriebene Figur/);
});

test('leeres Textbeleg-Array wird wie „ohne" behandelt', () => {
  const p = buildConsistencyPrompt('Mara', 'protagonist', MM, '', [], [], [], null, [], []);
  assert.doesNotMatch(p, /SO IST DIE FIGUR IM MANUSKRIPT GESCHRIEBEN/);
});
