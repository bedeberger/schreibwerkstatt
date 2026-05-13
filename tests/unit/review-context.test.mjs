// Tests für Phase-3-Augmentation der Buchreview:
//  - _buildKomplettContextBlock: liefert leeren String ohne Daten, formatiert
//    Figuren/Beziehungen/Continuity/Zeitstrahl/Mikro mit erwarteten Markern.
//  - buildBookReviewSinglePassPrompt: injiziert den Kontext-Block, wenn
//    komplettContext gesetzt ist; lässt ihn weg, wenn alle Buckets leer.
import test from 'node:test';
import assert from 'node:assert/strict';

const promptsUrl = new URL('../../public/js/prompts/review.js', import.meta.url).href;

async function freshReview() {
  return import(`${promptsUrl}?t=${Date.now()}_${Math.random()}`);
}

test('Buchreview-Prompt: ohne komplettContext kein Strukturdaten-Block', async () => {
  const { buildBookReviewSinglePassPrompt } = await freshReview();
  const out = buildBookReviewSinglePassPrompt('Mein Buch', 1, 'Text', {});
  assert.doesNotMatch(out, /STRUKTURDATEN AUS DER KOMPLETTANALYSE/);
});

test('Buchreview-Prompt: leerer komplettContext (alle Buckets leer) → kein Block', async () => {
  const { buildBookReviewSinglePassPrompt } = await freshReview();
  const out = buildBookReviewSinglePassPrompt('Mein Buch', 1, 'Text', {
    komplettContext: { figuren: [], beziehungen: [], continuityIssues: [], zeitstrahl: [], mikro: null },
  });
  assert.doesNotMatch(out, /STRUKTURDATEN AUS DER KOMPLETTANALYSE/);
});

test('Buchreview-Prompt: Figuren-Bucket → "Figurenkartei (Stamm…)"-Block', async () => {
  const { buildBookReviewSinglePassPrompt } = await freshReview();
  const out = buildBookReviewSinglePassPrompt('Mein Buch', 1, 'Text', {
    komplettContext: {
      figuren: [
        { name: 'Anna', kurzname: 'Anni', typ: 'hauptfigur', geschlecht: 'weiblich', beruf: 'Lehrerin', beschreibung: 'Hauptfigur des Buchs.' },
      ],
      beziehungen: [], continuityIssues: [], zeitstrahl: [], mikro: null,
    },
  });
  assert.match(out, /STRUKTURDATEN AUS DER KOMPLETTANALYSE/);
  assert.match(out, /Figurenkartei \(Stamm/);
  assert.match(out, /Anna «Anni» \(hauptfigur, weiblich, Lehrerin\)/);
  assert.match(out, /Hauptfigur des Buchs\./);
});

test('Buchreview-Prompt: Beziehungen → "Soziogramm"-Block mit Pfeil-Format', async () => {
  const { buildBookReviewSinglePassPrompt } = await freshReview();
  const out = buildBookReviewSinglePassPrompt('Mein Buch', 1, 'Text', {
    komplettContext: {
      figuren: [], continuityIssues: [], zeitstrahl: [], mikro: null,
      beziehungen: [{ von: 'Anna', zu: 'Berta', typ: 'Schwester', beschreibung: 'enges Vertrauensverhältnis' }],
    },
  });
  assert.match(out, /Soziogramm/);
  assert.match(out, /Anna → Berta: Schwester – enges Vertrauensverhältnis/);
});

test('Buchreview-Prompt: Continuity-Issues → "Kontinuitäts-Befunde"-Block mit Kapitel + Figuren', async () => {
  const { buildBookReviewSinglePassPrompt } = await freshReview();
  const out = buildBookReviewSinglePassPrompt('Mein Buch', 1, 'Text', {
    komplettContext: {
      figuren: [], beziehungen: [], zeitstrahl: [], mikro: null,
      continuityIssues: [{
        schwere: 'kritisch', typ: 'figurenmerkmal',
        beschreibung: 'Anna ist in Kap. 1 Lehrerin, in Kap. 5 Ärztin.',
        kapitel: ['Kapitel 1', 'Kapitel 5'],
        figuren: ['Anna'],
      }],
    },
  });
  assert.match(out, /Kontinuitäts-Befunde aus der letzten Komplettanalyse/);
  assert.match(out, /kritisch \| figurenmerkmal \[Kapitel 1 \/ Kapitel 5\]/);
  assert.match(out, /\(Figuren: Anna\)/);
});

test('Buchreview-Prompt: Zeitstrahl → "Globaler Zeitstrahl"-Block', async () => {
  const { buildBookReviewSinglePassPrompt } = await freshReview();
  const out = buildBookReviewSinglePassPrompt('Mein Buch', 1, 'Text', {
    komplettContext: {
      figuren: [], beziehungen: [], continuityIssues: [], mikro: null,
      zeitstrahl: [{ datum: '1925', ereignis: 'Anna zieht nach Bern', typ: 'persoenlich', kapitel: 'Kapitel 2' }],
    },
  });
  assert.match(out, /Globaler Zeitstrahl/);
  assert.match(out, /1925 \(persoenlich\) \[Kapitel 2\]: Anna zieht nach Bern/);
});

test('Buchreview-Prompt: Mikro-Aggregat → Statistik + mikro_befund-Schema-Feld', async () => {
  const { buildBookReviewSinglePassPrompt } = await freshReview();
  const out = buildBookReviewSinglePassPrompt('Mein Buch', 1, 'Text', {
    komplettContext: {
      figuren: [], beziehungen: [], continuityIssues: [], zeitstrahl: [],
      mikro: {
        pagesChecked: 50, pagesWithFindings: 30, totalFindings: 120,
        topTypen: [{ typ: 'wiederholung', count: 40 }, { typ: 'klischee', count: 20 }],
        topKapitel: [{ chapter_id: 7, chapter_name: 'Kapitel 7', findings: 30, pages: 6 }],
      },
    },
  });
  assert.match(out, /Mikro-Lektorats-Statistik/);
  assert.match(out, /Seiten geprüft: 50, davon mit Findings: 30, Gesamtzahl Findings: 120/);
  assert.match(out, /Verteilung nach Typ: wiederholung: 40, klischee: 20/);
  assert.match(out, /Kapitel 7: 30 Findings auf 6 Seiten/);
  // Schema-Feld mikro_befund muss im Prompt-Beispiel-JSON auftauchen
  assert.match(out, /"mikro_befund":/);
});

test('Multi-Pass-Prompt: komplettContext-Block landet zwischen Schwerpunkt und Kapitelanalysen', async () => {
  const { buildBookReviewMultiPassPrompt } = await freshReview();
  const out = buildBookReviewMultiPassPrompt('Mein Buch', [
    { name: 'Kap 1', pageCount: 5, themen: 'A', stil: 'B', qualitaet: 'C', dramaturgie_kurz: 'D', figuren_kurz: 'E', pacing_kurz: 'F', staerken: ['s1'], schwaechen: ['w1'] },
  ], 5, {
    komplettContext: {
      figuren: [{ name: 'Anna', kurzname: null, typ: null, geschlecht: null, beruf: null, beschreibung: '' }],
      beziehungen: [], continuityIssues: [], zeitstrahl: [], mikro: null,
    },
  });
  const idxStruct = out.indexOf('STRUKTURDATEN AUS DER KOMPLETTANALYSE');
  const idxKapitel = out.indexOf('Kapitelanalysen:');
  assert.ok(idxStruct > 0, 'Strukturdaten-Block muss vorhanden sein');
  assert.ok(idxKapitel > 0, 'Kapitelanalysen-Block muss vorhanden sein');
  assert.ok(idxStruct < idxKapitel, 'Strukturdaten müssen VOR den Kapitelanalysen stehen');
});

test('SCHEMA_REVIEW: enthält mikro_befund als string-Feld', async () => {
  const m = await freshReview();
  const props = m.SCHEMA_REVIEW?.properties;
  assert.ok(props, 'SCHEMA_REVIEW.properties fehlt');
  assert.ok(props.mikro_befund, 'mikro_befund-Property fehlt');
  assert.equal(props.mikro_befund.type, 'string');
});

test('SCHEMA_REVIEW: empfehlungen-items mit prio/kategorie-Enums', async () => {
  const m = await freshReview();
  const items = m.SCHEMA_REVIEW?.properties?.empfehlungen?.items;
  assert.ok(items, 'empfehlungen.items fehlt');
  assert.deepEqual(items.properties.prio.enum, ['hoch', 'mittel', 'niedrig']);
  assert.ok(items.properties.kategorie.enum.includes('plot'));
  assert.ok(items.properties.kategorie.enum.includes('mikro'));
});
