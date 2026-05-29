'use strict';
// Integration: Komplettanalyse-Pipeline schreibt strukturierte Event-Felder
// in `figure_events` durch.
//
// Schreibpfad: routes/jobs/komplett/phases.js → db.figures#updateFigurenEvents.
// Die Pipeline akzeptiert AI-Output mit `datum_year/month/day`, `datum_ende_*`,
// `subtyp`, `datum_label`, `story_tag`. Fallback `lib/datum-parse#parseDatum`
// greift nur, wenn das AI-Output strukturierte Felder leer lässt.
//
// Whitelist gegen Halluzination: `subtyp` ausserhalb der Whitelist → 'sonstiges'.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
});

function seedBook(bookId) {
  ctx.dbSeed.setBook({
    chapters: [{ id: 4100, book_id: bookId, name: 'Kapitel Eins' }],
    pages: [{ id: 4200, book_id: bookId, chapter_id: 4100, name: 'Seite Eins', updated_at: '2026-01-01' }],
    pageBodies: { 4200: '<p>' + 'Anna heiratete 1850 in Bern. '.repeat(40) + '</p>' },
  });
}

// AI-Output mit Mix aus strukturierten, Spannen-, Label-only-, Unknown- und
// invalid-subtyp-Events. Claude-Single-Pass A1 (Figuren-Stammdaten +
// assignments) trägt die Lebensereignisse; B (Orte/Szenen) separat.
function figurenStammWithEvents() {
  return {
    figuren: [{
      id: 'fig_anna', name: 'Anna', kurzname: 'Anna', typ: 'protagonist',
      beschreibung: 'Hauptfigur', sozialschicht: 'mitte', praesenz: 'zentral',
      kapitel: [{ name: 'Kapitel Eins', haeufigkeit: 1 }],
      eigenschaften: [], schluesselzitate: [],
    }],
    assignments: [{
      figur_name: 'Anna',
      lebensereignisse: [
        // 1) Strukturiertes Punkt-Event mit gültigem Subtyp
        {
          datum: '12. Mai 1850',
          datum_label: '12. Mai 1850',
          datum_year: 1850, datum_month: 5, datum_day: 12,
          subtyp: 'hochzeit',
          ereignis: 'Hochzeit in Bern',
          bedeutung: 'Wendepunkt im Leben',
          typ: 'persoenlich',
          kapitel: 'Kapitel Eins', seite: 'Seite Eins',
        },
        // 2) Spannen-Event (datum_ende_year gesetzt)
        {
          datum: '1851–1853',
          datum_label: '1851–1853',
          datum_year: 1851, datum_ende_year: 1853,
          subtyp: 'reise',
          ereignis: 'Reise durch Europa',
          bedeutung: '',
          typ: 'persoenlich',
          kapitel: 'Kapitel Eins',
        },
        // 3) Label-only-Event: strukturierte Felder fehlen, Parser muss Year aus "1860" ziehen
        {
          datum: '1860',
          datum_label: '1860',
          subtyp: 'tod',
          ereignis: 'Tod der Mutter',
          typ: 'persoenlich',
          kapitel: 'Kapitel Eins',
        },
        // 4) Unknown-Date-Event: kein Year, kein parsebares Label → unbekannt-Bucket
        {
          datum_label: 'vor der Reise',
          subtyp: 'sonstiges',
          ereignis: 'unbekannter Vorfall',
          typ: 'persoenlich',
          kapitel: 'Kapitel Eins',
        },
        // 5) Invalid-Subtyp: Whitelist-Default = 'sonstiges'
        {
          datum_year: 1870,
          datum_label: '1870',
          subtyp: 'schwurbel-fantasie',
          ereignis: 'Etwas Seltsames',
          typ: 'persoenlich',
          kapitel: 'Kapitel Eins',
        },
      ],
    }],
  };
}

// Claude-Single-Pass B: Orte/Szenen (KEINE figuren). Für die Event-Tests
// irrelevant, aber die Pipeline ruft den Pass trotzdem auf.
function ortePassResponse() {
  return {
    orte: [],
    songs: [],
    fakten: [],
    szenen: [{
      seite: 'Seite Eins', kapitel: 'Kapitel Eins', titel: 'Annas Hochzeit',
      wertung: 'stark', kommentar: '',
      figuren_namen: ['Anna'], orte_namen: [],
    }],
  };
}

function kontinuitaetResponse() {
  return { zusammenfassung: 'Stimmig.', probleme: [] };
}

// Zeitstrahl-Konsolidierung (Phase 6) fasst >=5 Events via AI zusammen.
// Für diese Tests interessiert nur `figure_events` (direkt aus Phase 1). Wir
// reichen die Events unverändert zurück — Konsolidierung wird Noop.
function zeitstrahlPassthroughHandler() {
  return ({ prompt }) => {
    // Im Prompt steht meist eine JSON-artige Liste — wir geben einfach eine
    // leere Konsolidierung zurück. saveZeitstrahlEvents schreibt damit nur
    // nach zeitstrahl_events; figure_events bleibt unberührt.
    return { ereignisse: [] };
  };
}

test('Komplettanalyse: AI-Events landen mit strukturierten Feldern + Subtyp in figure_events', async () => {
  const BOOK_ID = 70;
  seedBook(BOOK_ID);

  // A1: Figuren-Stammdaten + assignments (Events), KEIN orte.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'),
    figurenStammWithEvents(),
  );
  // B: Orte/Szenen, KEINE figuren.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'),
    ortePassResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('ereignisse'),
    zeitstrahlPassthroughHandler(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Testbuch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  const rows = ctx.dbSchema.db.prepare(`
    SELECT fe.ereignis, fe.subtyp, fe.typ,
           fe.datum_label,
           fe.datum_year, fe.datum_month, fe.datum_day,
           fe.datum_ende_year, fe.datum_ende_month, fe.datum_ende_day,
           fe.story_tag, fe.manually_edited
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    WHERE f.book_id = ? AND f.user_email = ?
  `).all(BOOK_ID, 'tester@test.dev');

  assert.equal(rows.length, 5, `expected 5 events, got ${rows.length}`);

  // Lookup nach Ereignis-Name — die Pipeline reorderet Events intern
  // (remap.js sortiert noch via parseInt(datum) für Stabilität), Position
  // ist daher kein verlässlicher Anker.
  const byName = Object.fromEntries(rows.map(r => [r.ereignis, r]));

  // 1) Strukturiertes Punkt-Event
  const ev1 = byName['Hochzeit in Bern'];
  assert.ok(ev1, 'Event "Hochzeit in Bern" gespeichert');
  assert.equal(ev1.subtyp, 'hochzeit');
  assert.equal(ev1.datum_year, 1850);
  assert.equal(ev1.datum_month, 5);
  assert.equal(ev1.datum_day, 12);
  assert.equal(ev1.datum_ende_year, null);
  assert.equal(ev1.manually_edited, 0, 'frisch importierte Events sind nicht manuell editiert');

  // 2) Spannen-Event
  const ev2 = byName['Reise durch Europa'];
  assert.ok(ev2, 'Event "Reise durch Europa" gespeichert');
  assert.equal(ev2.subtyp, 'reise');
  assert.equal(ev2.datum_year, 1851);
  assert.equal(ev2.datum_ende_year, 1853, 'Spannen-Ende muss durchgereicht werden');

  // 3) Label-only-Event: Parser muss Year aus Label ziehen
  const ev3 = byName['Tod der Mutter'];
  assert.ok(ev3, 'Event "Tod der Mutter" gespeichert');
  assert.equal(ev3.subtyp, 'tod');
  assert.equal(ev3.datum_year, 1860, 'Parser-Fallback aus datum_label "1860"');

  // 4) Unknown-Date-Event landet im unbekannt-Bucket (alle Datumsfelder NULL)
  const ev4 = byName['unbekannter Vorfall'];
  assert.ok(ev4, 'Event "unbekannter Vorfall" gespeichert');
  assert.equal(ev4.subtyp, 'sonstiges');
  assert.equal(ev4.datum_year, null);
  assert.equal(ev4.datum_month, null);
  assert.equal(ev4.datum_day, null);
  assert.equal(ev4.story_tag, null);
  assert.equal(ev4.datum_label, 'vor der Reise', 'Original-Label bleibt für Anzeige erhalten');

  // 5) Invalid-Subtyp → Whitelist-Default 'sonstiges'
  const ev5 = byName['Etwas Seltsames'];
  assert.ok(ev5, 'Event "Etwas Seltsames" gespeichert');
  assert.equal(ev5.subtyp, 'sonstiges', 'unbekannter Subtyp wird auf sonstiges normalisiert');
  assert.equal(ev5.datum_year, 1870);
});

test('Komplettanalyse: figure_events ORDER BY platziert Unknown-Bucket ans Ende', async () => {
  const BOOK_ID = 71;
  seedBook(BOOK_ID);

  // A1: Figuren-Stammdaten + assignments (Events), KEIN orte.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('figuren') && e.schemaKeys.includes('assignments') && !e.schemaKeys.includes('orte'),
    figurenStammWithEvents(),
  );
  // B: Orte/Szenen, KEINE figuren.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('orte') && e.schemaKeys.includes('szenen') && !e.schemaKeys.includes('figuren'),
    ortePassResponse(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.length === 1 && e.schemaKeys.includes('ereignisse'),
    zeitstrahlPassthroughHandler(),
  );
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('zusammenfassung') && e.schemaKeys.includes('probleme'),
    kontinuitaetResponse(),
  );

  const jobId = ctx.shared.createJob('komplett-analyse', BOOK_ID, 'tester@test.dev', 'job.label.komplett');
  ctx.shared.enqueueJob(jobId, () =>
    ctx.komplett.runKomplettAnalyseJob(jobId, BOOK_ID, 'Testbuch', 'tester@test.dev', { id: 'tok', pw: 'pw' }, 'claude'),
  );
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);

  // Read-Pfad analog routes/figures.js#GET /zeitstrahl/:book_id — strukturierte Sortierung.
  const sortedRows = ctx.dbSchema.db.prepare(`
    SELECT fe.ereignis, fe.datum_year
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY
      COALESCE(fe.datum_year,  9999),
      COALESCE(fe.datum_month, 99),
      COALESCE(fe.datum_day,   99),
      COALESCE(fe.story_tag,   99999),
      fe.sort_order
  `).all(BOOK_ID, 'tester@test.dev');

  const orderedNames = sortedRows.map(r => r.ereignis);
  assert.deepEqual(orderedNames, [
    'Hochzeit in Bern',     // 1850
    'Reise durch Europa',   // 1851
    'Tod der Mutter',       // 1860 (parser)
    'Etwas Seltsames',      // 1870
    'unbekannter Vorfall',  // NULL → ans Ende
  ]);
});
