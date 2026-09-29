// Die drei Zitierstile als Voll-Eintrag (Verzeichniszeile).
//
// Jeder Stil baut eine Liste von Teilen (jeweils Run-Arrays) und laesst
// joinParts/terminate die Punktuation setzen. So bleibt pro Stil genau eine
// Formatier-Stelle, und Klartext- wie HTML-Ausgabe entstehen aus demselben
// Ergebnis (siehe runs.js).
//
// csl_type wird auf fuenf Satzfamilien reduziert, weil sich die Stilregeln genau
// daran unterscheiden — nicht an den zwoelf Typen einzeln:
//   article  → Zeitschriftenaufsatz (container + volume/issue/pages)
//   newspaper → Zeitungs-/Magazinartikel (container + volles Erscheinungsdatum)
//   chapter  → Beitrag in Sammelband (Herausgeber + container + pages)
//   website  → Online-Ressource (container + url + Abrufdatum)
//   bookish  → alles uebrige (place/publisher); thesis/report/legal/interview/
//              film/dataset laufen bewusst hier mit. Typspezifische Zusaetze
//              (APA-Klammern wie "[Doctoral dissertation]") sind v1 nicht drin.
//
// Das volle Erscheinungsdatum (`issued_date`) setzen nur `newspaper` und
// `website` — beim Fachaufsatz nennen alle drei Stile nur das Jahr, auch wenn
// ein Import ein Datum mitgebracht hat.

import {
  txt, it, urlRun, joinParts, terminate, quoted, pageLabel, enDashRange, locatorUrl,
} from './runs.js';
import {
  apaAuthorList, chicagoAuthorList, numericAuthorList,
  apaEditorList, editedByList,
  apaEditorHead, chicagoEditorHead, numericEditorHead,
} from './persons.js';
import { parseIssuedDate, issuedParts } from '../issued-date.js';

function family(cslType) {
  if (cslType === 'article') return 'article';
  if (cslType === 'newspaper') return 'newspaper';
  if (cslType === 'chapter') return 'chapter';
  if (cslType === 'website') return 'website';
  return 'bookish';
}

function _title(src, labels) {
  const t = src.title ? String(src.title).trim() : '';
  return t || labels.noTitle;
}

function _year(src, labels) {
  const y = src.year ? String(src.year).trim() : '';
  return y || labels.noYear;
}

// Englische Ordnungszahl fuer Auflagen ("2nd ed." statt "2 ed."). Nur fuer
// reine Zahlen; alles andere (z.B. "Zweite, ueberarbeitete") bleibt wie getippt.
function _ordinalEn(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

function _edition(src, labels) {
  const raw = src.edition ? String(src.edition).trim() : '';
  if (!raw) return '';
  const num = /^(\d+)\.?$/.exec(raw);
  if (!num) return raw;                       // Freitext-Auflage unveraendert
  const n = parseInt(num[1], 10);
  return labels.lang === 'en'
    ? `${_ordinalEn(n)} ${labels.editionSuffix}`
    : `${n}. ${labels.editionSuffix}`;
}

// "Leipzig: Kurt Wolff" — fehlt eines von beiden, bleibt das andere allein.
function _placePublisher(src) {
  const place = src.place ? String(src.place).trim() : '';
  const publisher = src.publisher ? String(src.publisher).trim() : '';
  if (place && publisher) return `${place}: ${publisher}`;
  return publisher || place;
}

// Erscheinungsdatum mit Monat (ein blosses Jahr steckt schon in `year`).
// Die Eingabe kann aus der Live-Vorschau noch roh sein („12.3.2024").
function _issued(src, fam) {
  if (fam !== 'newspaper' && fam !== 'website') return null;
  const p = issuedParts(parseIssuedDate(src.issued_date));
  return p?.month ? p : null;
}

/** „12. März 2024" / „March 12, 2024" (ohne Tag: „März 2024"). */
function _longDate(p, labels) {
  if (!p) return '';
  const month = labels.months[p.month - 1];
  if (labels.lang === 'en') return p.day ? `${month} ${p.day}, ${p.year}` : `${month} ${p.year}`;
  return p.day ? `${p.day}. ${month} ${p.year}` : `${month} ${p.year}`;
}

/** APA-Klammer hinter dem Jahr: „(2024, 12. März)" / „(2024, March 12)". */
function _apaMonthDay(p, labels) {
  if (!p) return '';
  const month = labels.months[p.month - 1];
  if (!p.day) return month;
  return labels.lang === 'en' ? `${month} ${p.day}` : `${p.day}. ${month}`;
}

function _accessed(src, labels) {
  const a = src.accessed_at ? String(src.accessed_at).trim() : '';
  return a ? `${labels.accessed} ${a}` : '';
}

// ── APA 7 ────────────────────────────────────────────────────────────────────
// Kopf ist immer "<Urheber>. (<Jahr>)." — ohne Urheber ruecken Titel und Jahr
// vor (APA: title-first-Eintrag). `place` wird bewusst ignoriert: APA 7 hat den
// Verlagsort abgeschafft.
function apa7(src, labels) {
  const fam = family(src.csl_type);
  const authors = apaAuthorList(src.authors, labels);
  const head = authors || apaEditorHead(src.editors, labels);
  const md = _apaMonthDay(_issued(src, fam), labels);
  const year = `(${_year(src, labels)}${md ? `, ${md}` : ''})`;
  const title = _title(src, labels);
  const edition = _edition(src, labels);
  const url = locatorUrl(src);
  const parts = [];

  if (head) { parts.push(txt(head)); parts.push(txt(year)); }

  if (fam === 'article') {
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(txt(title));
    // Zeitschriftenname UND Bandzahl kursiv, Heftnummer und Seiten aufrecht.
    const journal = joinParts([
      it(src.container_title),
      joinParts([it(src.volume), txt(src.issue ? `(${src.issue})` : '')], ''),
    ], ', ');
    parts.push(joinParts([journal, txt(enDashRange(src.pages))], ', '));
  } else if (fam === 'newspaper') {
    // APA 7: Titel aufrecht, Zeitung kursiv, Seite(n) dahinter — das Datum
    // steht schon in der Klammer.
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(txt(title));
    parts.push(joinParts([it(src.container_title), txt(enDashRange(src.pages))], ', '));
  } else if (fam === 'chapter') {
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(txt(title));
    const eds = apaEditorList(src.editors, labels);
    const container = joinParts([
      it(src.container_title),
      txt(src.pages ? `(${pageLabel(src.pages, labels)})` : ''),
    ], ' ');
    parts.push(joinParts([txt(`${labels.inWord}${eds ? ` ${eds},` : ''}`), container], ' '));
    parts.push(txt(src.publisher));
  } else {
    // bookish + website: Titel kursiv, Auflage in Klammern dahinter.
    const titled = joinParts([it(title), txt(edition ? `(${edition})` : '')], ' ');
    if (!head) { parts.push(titled); parts.push(txt(year)); }
    else parts.push(titled);
    parts.push(fam === 'website' ? txt(src.container_title) : txt(src.publisher));
  }

  parts.push(txt(_accessed(src, labels)));
  parts.push(urlRun(url));
  return terminate(joinParts(parts, '. '));
}

// ── Chicago Author-Date ──────────────────────────────────────────────────────
// Jahr steht ohne Klammer direkt hinter dem Urheber; Aufsatz-/Kapiteltitel in
// Anfuehrungszeichen der Buchsprache, Werk-/Zeitschriftentitel kursiv.
function chicagoAd(src, labels) {
  const fam = family(src.csl_type);
  const authors = chicagoAuthorList(src.authors, labels);
  const head = authors || chicagoEditorHead(src.editors, labels);
  const year = _year(src, labels);
  const title = _title(src, labels);
  const edition = _edition(src, labels);
  const url = locatorUrl(src);
  // CMOS Author-Date: Jahr hinter dem Urheber, volles Datum hinter der Zeitung
  // bzw. Website („New York Times, March 8, 2017").
  const longDate = _longDate(_issued(src, fam), labels);
  const parts = [];

  if (head) { parts.push(txt(head)); parts.push(txt(year)); }

  if (fam === 'newspaper') {
    if (!head) { parts.push(quoted(title, labels)); parts.push(txt(year)); }
    else parts.push(quoted(title, labels));
    parts.push(joinParts([it(src.container_title), txt(longDate), txt(enDashRange(src.pages))], ', '));
  } else if (fam === 'article') {
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(quoted(title, labels));
    // "Zeitschrift 12 (3): 45–67"
    const vol = joinParts([it(src.container_title), txt(src.volume)], ' ');
    const issue = joinParts([vol, txt(src.issue ? `(${src.issue})` : '')], ' ');
    parts.push(joinParts([issue, txt(enDashRange(src.pages))], ': '));
  } else if (fam === 'chapter') {
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(quoted(title, labels));
    parts.push(joinParts([
      joinParts([txt(labels.inWord), it(src.container_title)], ' '),
      txt(editedByList(src.editors, labels)),
      txt(enDashRange(src.pages)),
    ], ', '));
    parts.push(txt(_placePublisher(src)));
  } else if (fam === 'website') {
    if (!head) { parts.push(quoted(title, labels)); parts.push(txt(year)); }
    else parts.push(quoted(title, labels));
    parts.push(joinParts([it(src.container_title), txt(longDate)], ', '));
  } else {
    const titled = joinParts([it(title), txt(edition)], '. ');
    if (!head) { parts.push(titled); parts.push(txt(year)); }
    else parts.push(titled);
    parts.push(txt(_placePublisher(src)));
  }

  parts.push(txt(_accessed(src, labels)));
  parts.push(urlRun(url));
  return terminate(joinParts(parts, '. '));
}

// ── Numerisch ────────────────────────────────────────────────────────────────
// Deutsche Verzeichniskonvention: "Nachname, Vorname: Titel. Ort: Verlag, Jahr."
// Die Nummer selbst gehoert nicht in den Eintrag — sie kommt aus der
// Erstzitat-Reihenfolge und wird vom Renderer als eigene Spalte gesetzt.
function numeric(src, labels) {
  const fam = family(src.csl_type);
  const authors = numericAuthorList(src.authors, labels);
  const head = authors || numericEditorHead(src.editors, labels);
  const year = _year(src, labels);
  const title = _title(src, labels);
  const edition = _edition(src, labels);
  const url = locatorUrl(src);
  // Zeitung/Web: das volle Datum ersetzt das Jahr („In: NZZ, 12. März 2024, S. 5").
  const dated = _longDate(_issued(src, fam), labels) || year;
  const parts = [];

  if (fam === 'newspaper') {
    parts.push(joinParts([txt(head ? `${head}:` : ''), txt(title)], ' '));
    parts.push(joinParts([
      joinParts([txt(`${labels.inWord}:`), it(src.container_title)], ' '),
      txt(dated),
      txt(pageLabel(src.pages, labels)),
    ], ', '));
  } else if (fam === 'article') {
    parts.push(joinParts([txt(head ? `${head}:` : ''), txt(title)], ' '));
    const vol = joinParts([it(src.container_title), txt(src.volume)], ' ');
    const issue = joinParts([vol, txt(src.issue ? `(${src.issue})` : '')], ' ');
    parts.push(joinParts([
      joinParts([txt(`${labels.inWord}:`), issue], ' '),
      txt(pageLabel(src.pages, labels)),
      txt(year),
    ], ', '));
  } else if (fam === 'chapter') {
    parts.push(joinParts([txt(head ? `${head}:` : ''), txt(title)], ' '));
    parts.push(joinParts([
      joinParts([txt(`${labels.inWord}:`), it(src.container_title)], ' '),
      txt(editedByList(src.editors, labels)),
      txt(pageLabel(src.pages, labels)),
    ], ', '));
    parts.push(joinParts([txt(_placePublisher(src)), txt(year)], ', '));
  } else if (fam === 'website') {
    parts.push(joinParts([txt(head ? `${head}:` : ''), it(title)], ' '));
    parts.push(joinParts([txt(src.container_title), txt(dated)], ', '));
  } else {
    parts.push(joinParts([txt(head ? `${head}:` : ''), it(title)], ' '));
    parts.push(txt(edition));
    parts.push(joinParts([txt(_placePublisher(src)), txt(year)], ', '));
  }

  parts.push(txt(_accessed(src, labels)));
  parts.push(urlRun(url));
  return terminate(joinParts(parts, '. '));
}

export const STYLE_BUILDERS = {
  'apa7': apa7,
  'chicago-ad': chicagoAd,
  'numeric': numeric,
};
