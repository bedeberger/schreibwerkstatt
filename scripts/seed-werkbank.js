#!/usr/bin/env node
'use strict';
// Werkbank-Testdaten fuer ein bestehendes Buch.
//
//   node scripts/seed-werkbank.js [book_id] [owner-email] [--force] [--no-timeline]
//
// Die Werkbank (docs/werkbank.md) hat KEINEN eigenen Index: sie liest Plot-,
// Motiv- und Figuren-Werkstatt zur Lesezeit zusammen. Damit sie etwas zu zeigen
// hat, muessen genau diese drei Beitraege existieren — und zwar so, dass alle
// drei Mess-Engines (lib/figure-arc.js, lib/plot-time-consistency.js,
// lib/motif-consistency.js) anschlagen. Das Skript legt sie an.
//
// Was entsteht (Standard: book_id 1000005 «Der Amoklauf», dev@local):
//   · 5 Akte, einer davon archiviert (Pflicht-Invariante «archivierte Akte
//     fallen aus den Spalten»).
//   · 18 Beats ueber die Akte, mit `zeit`, Intensitaet, Kapitelbezug und
//     Figuren-Links auf BEIDE Bruecken (Katalog-fig_id + Werkstatt-Draft).
//     Einer ist verworfen (darf in der Matrix nicht erscheinen), einer liegt im
//     archivierten Akt, vier sind undatiert («undatiert ist ungeprueft»).
//   · 5 Werkstatt-Figuren, vier davon per `source_figure_id` mit einer
//     Katalog-Figur verknuepft (Pflicht-Invariante «eine verknuepfte Figur ist
//     EINE Zeile»), mit ausgearbeiteten Mindmap-Kernen.
//   · Ist-Index der Kerne (`draft_figure_occurrences`) so verteilt, dass genau
//     die geplanten Luecken entstehen.
//   · 8 Motive mit 9 Beziehungen, Soll-Bruecken auf Figuren/Drafts/Kapitel und
//     ein Ist-Index (`motif_occurrences`), der die Kanten teils einloest und
//     teils widerlegt. Eines ist ein «Geist» (null Fundstellen).
//
// Erwartete Befunde danach (Werkbank → Befunde):
//   figur  bogenOhneBeleg (stark) · kernOhneText (mittel, mehrfach)
//   plot   beatVorGeburt (kritisch) · figurKindImBeat (mittel, 2×)
//          chronologieBruch (mittel) · zeitAusserhalbBuch (schwach)
//   motiv  geistNachbar (stark) · kontrastOhneBeruehrung (stark, 2×)
//          gleichlaufOhneDeckung (mittel) · nabeOhneSubstanz (mittel)
//          sollIstDivergenz (mittel)
//
// NICHT erreichbar bei diesem Buch: `kernNurPunktuell`, `wandelOhneEinloesung`
// und `abbruchImBogen` verlangen mindestens 6 Kapitel (ARC_MIN_CHAPTERS); «Der
// Amoklauf» hat 5. Dafuer muesste das Manuskript selbst wachsen — das ist keine
// Seed-Aufgabe.
//
// Idempotent: ein zweiter Lauf ohne --force bricht ab, mit --force raeumt er die
// Akte, Werkstatt-Figuren und Motive dieses Buchs (CASCADE nimmt Beats,
// Bruecken und beide Ist-Indizes mit) und legt sie neu an. Katalog-Figuren,
// Kapitel und Seiten werden NIE angefasst.

const { db } = require('../db/connection');
const { NOW_ISO_SQL } = require('../db/now');
const contentStore = require('../lib/content-store');
const plotDb = require('../db/plot');
const motifsDb = require('../db/motifs');
const draftDb = require('../db/draft-figures');
const occDb = require('../db/draft-figure-occurrences');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));
const BOOK_ID = parseInt(positional[0] || '1000005', 10);
const OWNER = positional[1] || 'dev@local';
const FORCE = flags.has('--force');
const SET_TIMELINE = !flags.has('--no-timeline');

// ── Mindmap-Bau ─────────────────────────────────────────────────────────────
// Gleiche Container-IDs wie routes/draft-figures.js#defaultMindmap; nur sie
// liest lib/draft-mindmap-extract.js. Die Kinder tragen Klartext (kein
// i18n-Marker), wie vom User angelegter Inhalt.
function mindmap(name, kerne) {
  const kids = (id) => (kerne[id] || []).map((topic, i) => ({ id: `${id}_${i + 1}`, topic }));
  return {
    meta: { name: 'figur-werkstatt', version: '1' },
    format: 'node_tree',
    data: {
      id: 'root', topic: name, children: [
        { id: 'steckbrief', topic: '__i18n:werkstatt.tree.steckbrief__', expanded: true, children: [
          { id: 'aussehen', topic: '__i18n:werkstatt.tree.aussehen__' },
          { id: 'persoenlichkeit', topic: '__i18n:werkstatt.tree.persoenlichkeit__' },
          { id: 'hintergrund', topic: '__i18n:werkstatt.tree.hintergrund__' },
          { id: 'beziehungen', topic: '__i18n:werkstatt.tree.beziehungen__' },
          { id: 'konflikt', topic: '__i18n:werkstatt.tree.konflikt__', children: kids('konflikt') },
          { id: 'bogen', topic: '__i18n:werkstatt.tree.bogen__', children: kids('bogen') },
          { id: 'musikgeschmack', topic: '__i18n:werkstatt.tree.musikgeschmack__' },
        ]},
        { id: 'stimme', topic: '__i18n:werkstatt.tree.stimme__', expanded: true, children: [
          { id: 'sprechweise', topic: '__i18n:werkstatt.tree.sprechweise__' },
          { id: 'phrasen', topic: '__i18n:werkstatt.tree.phrasen__' },
          { id: 'verben', topic: '__i18n:werkstatt.tree.verben__' },
        ]},
        { id: 'subtext', topic: '__i18n:werkstatt.tree.subtext__', expanded: true, children: [
          { id: 'want', topic: '__i18n:werkstatt.tree.want__', children: kids('want') },
          { id: 'need', topic: '__i18n:werkstatt.tree.need__', children: kids('need') },
          { id: 'wound', topic: '__i18n:werkstatt.tree.wound__', children: kids('wound') },
          { id: 'lie', topic: '__i18n:werkstatt.tree.lie__', children: kids('lie') },
        ]},
        { id: 'custom', topic: '__i18n:werkstatt.tree.custom__', children: [] },
      ],
    },
  };
}

// ── Inhalt ──────────────────────────────────────────────────────────────────

const AKTE = [
  { key: 'herkunft', name: 'I — Herkunft',              farbe: '#6b7fd7', archiviert: 0 },
  { key: 'abdrift',  name: 'II — Abdrift',              farbe: '#c0392b', archiviert: 0 },
  { key: 'tat',      name: 'III — Die Tat',             farbe: '#8e44ad', archiviert: 0 },
  { key: 'nachhall', name: 'IV — Nachhall',             farbe: '#16a085', archiviert: 0 },
  { key: 'archiv',   name: 'Archiv — verworfene Straenge', farbe: '#7f8c8d', archiviert: 1 },
];

// figKey → Katalog-fig_id (TEXT). Die vier verknuepften Figuren tauchen in der
// Matrix NICHT als eigene Zeile auf, sondern verschmelzen mit ihrem Draft.
const FIG = {
  stefan:    'fig_2',      // Stefan, geb. 1968
  robert:    'fig_7',      // Robert, geb. 1982
  samuel:    'fig_12',     // Samuel, geb. 1986
  renate:    'fig_2__2',   // Renate, geb. 1970
  gottfried: 'fig_8__2',   // Pfarrer Gottfried, ohne Geburtsjahr
  jonas:     'fig_48',     // Jonas, geb. 1984 — bleibt reine Katalog-Zeile
};

// draftKey → { name, archetype, quelle (fig_id oder null), kerne, ist }
// `ist` ist der Ist-Index: kern → Anzahl Fundstellen je Kapitel-Index (0-basiert
// in Lesereihenfolge). Ein fehlender Kern hat KEINE Fundstelle — genau daraus
// entstehen `kernOhneText` und `bogenOhneBeleg`.
const DRAFTS = [
  {
    key: 'stefan', name: 'Stefan', archetype: 'protagonist', quelle: FIG.stefan,
    notes: 'Der Vater aus Kapitel 1. Traegt den Buchbogen von der Herkunft bis zur Tat.',
    kerne: {
      want:     ['Dazugehoeren, ohne sich zu erklaeren', 'Den Verein als Ersatzfamilie halten'],
      need:     ['Sich der eigenen Wut stellen, statt sie zu verwalten'],
      wound:    ['Der Vater schlug nie — er schwieg', 'Die Mutter erklaerte das Schweigen zur Staerke'],
      lie:      ['Wer nichts sagt, verliert nichts'],
      bogen:    ['Vom stillen Mitlaeufer zum Ausloeser', 'Bricht das Schweigen zu spaet'],
      konflikt: ['Loyalitaet zum Verein gegen Loyalitaet zum Sohn'],
    },
    ist: {
      want:     [3, 2, 1, 2, 1], need: [1, 1, 2, 2, 3], wound: [4, 3, 1, 1, 1],
      lie:      [2, 2, 1, 1, 1], bogen: [1, 1, 2, 2, 2], konflikt: [2, 1, 1, 2, 1],
    },
  },
  {
    key: 'robert', name: 'Robert', archetype: 'antagonist', quelle: FIG.robert,
    notes: 'Geplanter Bogen ohne Beleg im Text — der Modellfall fuer die Bogen-Messung.',
    kerne: {
      want:     ['Gesehen werden, egal wofuer'],
      need:     ['Einen Menschen aushalten, der ihn kennt'],
      wound:    ['Die Mutter ging ohne Abschied'],
      lie:      ['Naehe ist der Anfang des Verlusts'],
      bogen:    ['Vom Rueckzug in die Tat und zurueck in die Reue'],
    },
    // lie und bogen bleiben ohne Fundstelle → kernOhneText + bogenOhneBeleg.
    ist: { want: [0, 2, 3, 2, 1], need: [0, 1, 2, 1, 1], wound: [1, 2, 2, 0, 0] },
  },
  {
    key: 'samuel', name: 'Samuel', archetype: 'protagonist', quelle: FIG.samuel,
    notes: 'Viel geplant, wenig geschrieben — drei Kerne ohne jede Spur.',
    kerne: {
      want:     ['Ordnung, die niemand stoert'],
      need:     ['Ein Gegenueber, das widerspricht'],
      wound:    ['Der elfte September im Wohnzimmer'],
      lie:      ['Die Welt ist ein System, das man durchschaut'],
      konflikt: ['Kontrolle gegen Kontrollverlust'],
    },
    // Nur `want` ist belegt → drei kernOhneText.
    ist: { want: [0, 0, 4, 2, 1] },
  },
  {
    key: 'gottfried', name: 'Pfarrer Gottfried', archetype: 'mentor', quelle: FIG.gottfried,
    notes: 'Noch gar nicht geschrieben — darf KEINEN Befund erzeugen (gesamt = 0).',
    kerne: {
      bogen:    ['Vom Amtstraeger zum Zeugen'],
      konflikt: ['Beichtgeheimnis gegen Warnpflicht'],
    },
    ist: {},
  },
  {
    key: 'renate', name: 'Renate', archetype: 'nebenfigur', quelle: FIG.renate,
    notes: 'Saubere Zeile: alles Geplante ist auch belegt.',
    kerne: {
      want:  ['Dass die Familie nach aussen intakt bleibt'],
      wound: ['Die eigene Mutter sprach nie ueber den Krieg'],
    },
    ist: { want: [2, 2, 1, 1, 2], wound: [3, 1, 1, 1, 1] },
  },
];

// Motive. `istKapitel` = Kapitel-Indizes (0-basiert) mit ihrer Fundstellenzahl,
// `sollKapitel` = die vom Autor gezogene Soll-Bruecke. Die Zahlen sind so
// gewaehlt, dass genau die dokumentierten Motiv-Befunde entstehen.
const MOTIVE = [
  { key: 'vater',      name: 'Der abwesende Vater',   farbe: '#c0392b', terms: ['Vater', 'abwesend', 'Schweigen des Vaters'],
    ist: [3, 3, 2, 2, 2], figuren: [FIG.stefan, FIG.robert], drafts: ['stefan', 'robert'] },
  { key: 'waffe',      name: 'Waffe als Sprache',     farbe: '#7f8c8d', terms: ['Waffe', 'Gewehr', 'Schuss'],
    ist: [0, 0, 0, 4, 3], figuren: [FIG.jonas], drafts: ['robert'] },
  { key: 'verein',     name: 'Vereinsleben als Fassade', farbe: '#27ae60', terms: ['Verein', 'Vorstand', 'Jahresversammlung'],
    ist: [3, 3, 0, 0, 0], figuren: [FIG.stefan], drafts: ['stefan'] },
  { key: 'einsamkeit', name: 'Digitale Einsamkeit',   farbe: '#2980b9', terms: ['Computer', 'Forum', 'Bildschirm'],
    ist: [0, 0, 4, 4, 0], drafts: ['samuel'] },
  { key: 'erbschuld',  name: 'Erbschuld',             farbe: '#8e44ad', terms: ['Erbschuld', 'Schuld der Vaeter'],
    ist: [0, 0, 3, 0, 0], drafts: ['stefan'] },
  { key: 'zorn',       name: 'Der stille Zorn',       farbe: '#d35400', terms: ['Zorn', 'Wut', 'Schweigen'],
    ist: [3, 2, 2, 2, 2], figuren: [FIG.stefan], drafts: ['stefan', 'samuel'] },
  // Soll zeigt auf die Kapitel 4+5, gefunden wird es nur in Kapitel 2 → sollIstDivergenz.
  { key: 'ordnung',    name: 'Die Ordnung der Dinge', farbe: '#16a085', terms: ['Ordnung', 'Reihenfolge', 'Plan'],
    ist: [0, 4, 0, 0, 0], sollKapitel: [3, 4], drafts: ['samuel'] },
  // Geist: null Fundstellen, aber eine Kante zeigt darauf → geistNachbar.
  { key: 'zweitesleben', name: 'Das zweite Leben',    farbe: '#95a5a6', terms: ['zweites Leben', 'Doppelleben'],
    ist: [0, 0, 0, 0, 0], drafts: ['robert'] },
];

const MOTIV_KANTEN = [
  { from: 'vater',      to: 'zorn',         typ: 'verstaerkt' },     // deckt sich → kein Befund
  { from: 'vater',      to: 'verein',       typ: 'spiegelt' },       // deckt sich → kein Befund
  { from: 'vater',      to: 'erbschuld',    typ: 'bedingt' },        // deckt sich → kein Befund
  { from: 'waffe',      to: 'verein',       typ: 'kontrastiert' },   // kein gemeinsames Kapitel → stark
  { from: 'einsamkeit', to: 'ordnung',      typ: 'bedingt' },        // Ueberschneidung 0 → mittel
  { from: 'erbschuld',  to: 'zweitesleben', typ: 'verstaerkt' },     // Geist-Nachbar → stark
  { from: 'erbschuld',  to: 'waffe',        typ: 'bricht' },         // kein gemeinsames Kapitel → stark
  { from: 'zorn',       to: 'einsamkeit',   typ: 'verdraengt' },     // beruehrt sich → kein Befund
  { from: 'waffe',      to: 'einsamkeit',   typ: 'verstaerkt' },     // Deckung 0.5 → kein Befund
];

// Beats. `akt` = Akt-Key, `figuren`/`drafts` = die zwei Bruecken, `zeit` als
// Freitext (die Messung zieht das Jahr selbst heraus), `kapitel` = Index.
const BEATS = [
  { akt: 'herkunft', titel: 'Das Haus am Hang',              zeit: 'Fruehling 1972', kapitel: 0, intensitaet: 2, status: 'im_buch', figuren: [FIG.stefan], drafts: ['stefan'], motive: ['vater'] },
  { akt: 'herkunft', titel: 'Der erste Schlag, der keiner war', zeit: '1976',       kapitel: 0, intensitaet: 3, status: 'im_buch', figuren: [FIG.stefan], drafts: ['stefan'], motive: ['vater', 'zorn'] },
  { akt: 'herkunft', titel: 'Das Vereinsleben',              zeit: 'Sommer 1982',   kapitel: 0, intensitaet: 2, status: 'im_buch', figuren: [FIG.stefan, FIG.renate], drafts: ['stefan', 'renate'], motive: ['verein'] },
  { akt: 'herkunft', titel: 'Der Bruch mit dem Verein',      zeit: '1984',          kapitel: 1, intensitaet: 4, status: 'im_buch', figuren: [FIG.stefan], drafts: ['stefan'], motive: ['verein', 'zorn'] },

  { akt: 'abdrift',  titel: 'Samuels Kindheit',              zeit: '1985',          kapitel: 2, intensitaet: 2, status: 'geplant', figuren: [FIG.samuel], drafts: ['samuel'], motive: ['einsamkeit'] },
  { akt: 'abdrift',  titel: 'Die erste Wohnung',             zeit: '1994',          kapitel: 1, intensitaet: 2, status: 'im_buch', figuren: [FIG.stefan], drafts: ['stefan'] },
  { akt: 'abdrift',  titel: 'Robert verlaesst die Schule',   zeit: '1998',          kapitel: 3, intensitaet: 3, status: 'im_buch', figuren: [FIG.robert], drafts: ['robert'], motive: ['vater'] },
  { akt: 'abdrift',  titel: 'Das Tagebuch',                  zeit: 'Winter 1999',   kapitel: 2, intensitaet: 3, status: 'im_buch', figuren: [FIG.samuel], drafts: ['samuel'], motive: ['einsamkeit', 'ordnung'] },

  { akt: 'tat',      titel: 'Der elfte September',           zeit: '2001',          kapitel: 2, intensitaet: 4, status: 'im_buch', figuren: [FIG.samuel], drafts: ['samuel'], motive: ['ordnung'] },
  { akt: 'tat',      titel: 'Der Plan',                      zeit: '2002',          kapitel: 3, intensitaet: 5, status: 'geplant', figuren: [FIG.robert, FIG.jonas], drafts: ['robert'], motive: ['waffe'] },
  { akt: 'tat',      titel: 'Das erste Attentat',            zeit: 'Herbst 2003',   kapitel: 3, intensitaet: 5, status: 'im_buch', figuren: [FIG.robert], drafts: ['robert'], motive: ['waffe', 'zorn'] },
  { akt: 'tat',      titel: 'Rueckblende: der Sommer 1989',  zeit: '1989',          kapitel: 1, intensitaet: 3, status: 'geplant', figuren: [FIG.stefan], drafts: ['stefan'] },
  { akt: 'tat',      titel: 'Der zweite Taeter',             zeit: '1995',          kapitel: 3, intensitaet: 3, status: 'geplant', verworfen: 1, figuren: [FIG.jonas], drafts: ['robert'] },

  { akt: 'nachhall', titel: 'Die Ermittlung',                zeit: '2004',          kapitel: 4, intensitaet: 3, status: 'geplant', figuren: [FIG.gottfried], drafts: ['gottfried'] },
  { akt: 'nachhall', titel: 'Die Mutter spricht',            zeit: null,            kapitel: 4, intensitaet: 3, status: 'geplant', figuren: [FIG.renate], drafts: ['renate'], motive: ['vater'] },
  { akt: 'nachhall', titel: 'Der Chronist beginnt',          zeit: null,            kapitel: 4, intensitaet: 2, status: 'geplant', drafts: ['stefan'] },
  { akt: 'nachhall', titel: 'Was bleibt',                    zeit: null,            kapitel: 4, intensitaet: 1, status: 'geplant', figuren: [FIG.stefan, FIG.renate], drafts: ['stefan', 'renate'], motive: ['zorn'] },

  { akt: 'archiv',   titel: 'Die Parallelhandlung in Basel', zeit: null,            kapitel: null, intensitaet: 2, status: 'geplant', figuren: [FIG.jonas] },
];

const SNIPPETS = [
  'Er sagte nichts, und das Schweigen war die Antwort.',
  'Im Vorstand galt das als Haltung.',
  'Der Bildschirm war das einzige Licht im Zimmer.',
  'Sie sprach ueber das Wetter, solange es ging.',
  'Niemand im Dorf nannte es beim Namen.',
];

// ── Ausfuehrung ─────────────────────────────────────────────────────────────

function pagesByChapter(tree) {
  // Kapitel in Lesereihenfolge (depth-first), je mit ihren Seiten-IDs — dieselbe
  // Ordnung, gegen die die Werkbank ihre Befunde rechnet.
  const out = [];
  (function walk(chapters) {
    for (const c of chapters || []) {
      out.push({ id: c.id, name: c.name, pages: (c.pages || []).map(p => p.id) });
      walk(c.subchapters);
    }
  })(tree?.chapters);
  return out;
}

// n Fundstellen im Kapitel `ch` verteilen — Seiten der Reihe nach, Score klar
// ueber beiden Floors (motif.scan.min_score 0.45 / werkstatt.anchor.min_score 0.35).
function occRows(ch, n, seed) {
  const rows = [];
  if (!ch || !ch.pages.length) return rows;
  for (let i = 0; i < n; i++) {
    const pageId = ch.pages[(i * 2 + seed) % ch.pages.length];
    rows.push({
      kind: 'page', pageId,
      score: Number((0.58 + ((i + seed) % 5) * 0.07).toFixed(2)),
      snippet: SNIPPETS[(i + seed) % SNIPPETS.length],
      source: i % 4 === 3 ? 'trigger' : 'semantic',
    });
  }
  // Woertliche Treffer tragen keinen Score (Exakt-Match) — wie im echten Scan.
  for (const r of rows) if (r.source === 'trigger') r.score = null;
  return rows;
}

const wipe = db.transaction((bookId, owner) => {
  db.prepare('DELETE FROM plot_acts   WHERE book_id = ? AND user_email = ?').run(bookId, owner);
  db.prepare('DELETE FROM plot_beats  WHERE book_id = ? AND user_email = ?').run(bookId, owner);
  db.prepare('DELETE FROM draft_figures WHERE book_id = ? AND user_email = ?').run(bookId, owner);
  db.prepare('DELETE FROM motifs      WHERE book_id = ? AND user_email = ?').run(bookId, owner);
});

async function main() {
  const book = db.prepare('SELECT book_id, name, owner_email FROM books WHERE book_id = ?').get(BOOK_ID);
  if (!book) throw new Error(`Buch ${BOOK_ID} gibt es nicht.`);

  const bestand = {
    akte:   db.prepare('SELECT COUNT(*) n FROM plot_acts    WHERE book_id = ? AND user_email = ?').get(BOOK_ID, OWNER).n,
    drafts: db.prepare('SELECT COUNT(*) n FROM draft_figures WHERE book_id = ? AND user_email = ?').get(BOOK_ID, OWNER).n,
    motive: db.prepare('SELECT COUNT(*) n FROM motifs       WHERE book_id = ? AND user_email = ?').get(BOOK_ID, OWNER).n,
  };
  if ((bestand.akte || bestand.drafts || bestand.motive) && !FORCE) {
    console.error(`Abbruch: «${book.name}» hat bereits ${bestand.akte} Akte, ${bestand.drafts} Werkstatt-Figuren, ${bestand.motive} Motive.`);
    console.error('Mit --force werden genau diese drei Bestaende ersetzt (Kapitel, Seiten und Katalog-Figuren bleiben unangetastet).');
    process.exit(1);
  }
  if (FORCE) wipe(BOOK_ID, OWNER);

  const kapitel = pagesByChapter(await contentStore.bookTree(BOOK_ID, null));
  if (kapitel.length < 5) throw new Error(`Buch ${BOOK_ID} hat nur ${kapitel.length} Kapitel — das Seed erwartet mindestens 5.`);

  // 1. Werkstatt-Figuren + ihr Ist-Index.
  const figIntId = db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ? AND user_email IS ?');
  const draftIds = {};
  let occCount = 0;
  for (const d of DRAFTS) {
    const src = d.quelle ? figIntId.get(BOOK_ID, d.quelle, OWNER) : null;
    if (d.quelle && !src) console.warn(`  ! Katalog-Figur ${d.quelle} nicht gefunden — «${d.name}» bleibt unverknuepft.`);
    const created = draftDb.createDraftFigure(BOOK_ID, OWNER, {
      name: d.name, archetype: d.archetype, mindmap: mindmap(d.name, d.kerne),
      notes: d.notes, sourceFigureId: src ? src.id : null,
    });
    draftIds[d.key] = created.id;
    for (const [kern, verteilung] of Object.entries(d.ist)) {
      const rows = [];
      verteilung.forEach((n, chIdx) => { if (n > 0) rows.push(...occRows(kapitel[chIdx], n, chIdx + 1)); });
      if (rows.length) { occDb.replaceKernOccurrences(created.id, BOOK_ID, kern, rows); occCount += rows.length; }
    }
  }

  // 2. Motive: Katalog, Soll-Bruecken, Ist-Index, Kanten.
  const motifIds = {};
  let motifOcc = 0;
  for (const [i, m] of MOTIVE.entries()) {
    const created = motifsDb.createMotif(BOOK_ID, OWNER, {
      name: m.name, beschreibung: `Seed-Motiv fuer die Werkbank: ${m.name}.`,
      triggerTerms: m.terms, farbe: m.farbe, position: i,
    });
    motifIds[m.key] = created.id;
    const figIds = motifsDb.resolveFigureIds(BOOK_ID, m.figuren || []);
    if (figIds.length) motifsDb.setMotifFigures(created.id, figIds);
    const dIds = (m.drafts || []).map(k => draftIds[k]).filter(Boolean);
    if (dIds.length) motifsDb.setMotifDraftFigures(created.id, dIds);
    // Soll-Kapitel: ohne eigene Angabe dieselben, in denen das Motiv auch
    // gefunden wird (kein Befund); mit Angabe die abweichenden.
    const soll = (m.sollKapitel || m.ist.map((n, idx) => (n > 0 ? idx : -1)).filter(idx => idx >= 0))
      .map(idx => kapitel[idx]?.id).filter(Boolean);
    if (soll.length) motifsDb.setMotifChapters(created.id, soll);
    const rows = [];
    m.ist.forEach((n, chIdx) => { if (n > 0) rows.push(...occRows(kapitel[chIdx], n, chIdx + 2)); });
    if (rows.length) { motifsDb.replaceOccurrences(created.id, BOOK_ID, rows); motifOcc += rows.length; }
  }
  for (const k of MOTIV_KANTEN) motifsDb.createRelation(motifIds[k.from], motifIds[k.to], k.typ);

  // 3. Akte + Beats.
  const aktIds = {};
  for (const [i, a] of AKTE.entries()) {
    const created = plotDb.createAct(BOOK_ID, OWNER, { name: a.name, farbe: a.farbe, position: i, archiviert: a.archiviert });
    aktIds[a.key] = created.id;
  }
  const proAkt = {};
  for (const b of BEATS) {
    proAkt[b.akt] = (proAkt[b.akt] || 0) + 1;
    plotDb.createBeat(BOOK_ID, aktIds[b.akt], OWNER, {
      titel: b.titel,
      beschreibung: `Seed-Beat der Werkbank-Testdaten (${b.akt}).`,
      status: b.status || 'geplant',
      verworfen: b.verworfen ? 1 : 0,
      chapterId: b.kapitel != null ? kapitel[b.kapitel].id : null,
      intensitaet: b.intensitaet ?? null,
      zeit: b.zeit || null,
      sortOrder: proAkt[b.akt],
      figureIds: plotDb.resolveFigureIds(BOOK_ID, OWNER, b.figuren || []),
      draftFigureIds: plotDb.resolveDraftFigureIds(BOOK_ID, OWNER, (b.drafts || []).map(k => draftIds[k]).filter(Boolean)),
      motifIds: plotDb.resolveMotifIds(BOOK_ID, OWNER, (b.motive || []).map(k => motifIds[k]).filter(Boolean)),
    });
  }

  // 4. Echte Zeitlinie einschalten — ohne sie liefert lib/figure-years.js kein
  //    Geburtsjahr, und die Alters-Befunde der Zeit-Messung koennen gar nicht
  //    entstehen (nur der Chronologie-Teil). Abschaltbar via --no-timeline.
  let zeitlinie = 'unveraendert';
  if (SET_TIMELINE) {
    const row = db.prepare('SELECT zeitlinie_real FROM book_settings WHERE book_id = ?').get(BOOK_ID);
    if (!row) console.warn('  ! Keine book_settings-Zeile — Zeitlinie nicht gesetzt.');
    else if (row.zeitlinie_real) zeitlinie = 'war schon an';
    else {
      db.prepare(`UPDATE book_settings SET zeitlinie_real = 1, updated_at = ${NOW_ISO_SQL} WHERE book_id = ?`).run(BOOK_ID);
      zeitlinie = 'eingeschaltet (vorher aus)';
    }
  }

  console.log(`✓ Werkbank-Testdaten fuer «${book.name}» (book_id=${BOOK_ID}, ${OWNER})`);
  console.log(`  ${AKTE.length} Akte (1 archiviert) · ${BEATS.length} Beats (1 verworfen, 4 undatiert)`);
  console.log(`  ${DRAFTS.length} Werkstatt-Figuren (${DRAFTS.filter(d => d.quelle).length} verknuepft) · ${occCount} Kern-Fundstellen`);
  console.log(`  ${MOTIVE.length} Motive (1 ohne Fundstelle) · ${MOTIV_KANTEN.length} Beziehungen · ${motifOcc} Motiv-Fundstellen`);
  console.log(`  book_settings.zeitlinie_real: ${zeitlinie}`);
  console.log(`\nIn der App: Buch waehlen → Karte «Werkbank» (#book/${BOOK_ID}/werkbank) → Reiter «Befunde».`);
}

main().catch(e => {
  console.error('Seed fehlgeschlagen:', e.message);
  console.error(e.stack);
  process.exit(1);
});
