'use strict';
// Kennungen aus einem Quellen-PDF lesen (Job `source-pdf-draft`): DOI und ISBN
// aus den PDF-Metadaten und dem Text der ersten Seiten. Rein deterministisch —
// kein Modell, kein Netz. Den Register-Lookup mit der gefundenen Kennung macht
// der Job (lib/source-lookup.js).
//
// Die Kennung ist der billigste und sicherste Weg zu kanonischen Metadaten, aber
// eine Kennung auf der Titelseite ist nicht zwingend die EIGENE: Fachartikel
// nennen im Kopf gern den DOI eines Begleitartikels, ein Buch im Impressum die
// ISBN der Vorauflage oder der E-Book-Ausgabe. Darum liefert dieses Modul eine
// geordnete KANDIDATENLISTE, und der Job nimmt nur einen Registertreffer an,
// dessen Titel im PDF-Text tatsaechlich steht (`titleInText`).

const { normalizeDoi, normalizeIsbn, titleTokens } = require('./source-lookup');
const { parseIssuedDate } = require('./issued-date');

// Wie weit in den Text gesucht wird. Der DOI eines Aufsatzes steht im Kopf der
// ersten Seite; die ISBN eines Buchs im Impressum, das nach Schmutztitel und
// Titelei gern auf Seite vier bis sechs liegt. Weiter hinten beginnt das
// Literaturverzeichnis — dort stehen fast nur FREMDE Kennungen.
const DOI_HEAD_CHARS = 8000;
const ISBN_HEAD_CHARS = 20000;
// Titel-Probe: gegen diesen Textanfang wird der Registertitel geprueft.
const TITLE_HEAD_CHARS = 20000;
const MAX_CANDIDATES = 3;
// Anteil der Titel-Tokens, der im Textanfang vorkommen muss. Hoch, weil ein
// Titel auf der eigenen Titelseite woertlich steht; nicht 1, weil die
// Text-Extraktion Silbentrennungen und Ligaturen zerlegt.
const TITLE_IN_TEXT_MIN = 0.8;

const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>]+/g;
// „ISBN", „ISBN-13", „ISBN 978-…", „ISBN: 3-518-…". Die Ziffernfolge darf
// Bindestriche und Leerzeichen tragen; normalizeIsbn raeumt sie weg.
const ISBN_RE = /\bISBN(?:-1[03])?\s*:?\s*((?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dXx])/g;

/** Satzzeichen, die der Satz an einen DOI klebt: „(doi:10.1/x)." → „10.1/x". */
function _trimDoiTail(s) {
  let out = s.replace(/[.,;:]+$/, '');
  // Eine schliessende Klammer gehoert nur dazu, wenn der DOI sie auch oeffnet
  // (10.1002/(SICI)1097-…) — sonst ist sie die Klammer des Satzes.
  while (/[)\]}]$/.test(out)) {
    const close = out.slice(-1);
    const open = { ')': '(', ']': '[', '}': '{' }[close];
    if (out.split(open).length > out.split(close).length - 1) break;
    out = out.slice(0, -1).replace(/[.,;:]+$/, '');
  }
  return out;
}

/**
 * DOI-Kandidaten in Fundreihenfolge, normalisiert und ohne Dubletten.
 * @param {string[]} sources Texte in Prioritaet (Metadaten zuerst, dann Textanfang).
 */
function findDoiCandidates(sources) {
  const out = [];
  for (const raw of Array.isArray(sources) ? sources : []) {
    const s = String(raw ?? '');
    for (const m of s.matchAll(DOI_RE)) {
      const doi = normalizeDoi(_trimDoiTail(m[0]));
      // DOIs sind case-insensitiv; der Vergleich auch.
      if (doi && !out.some(d => d.toLowerCase() === doi.toLowerCase())) out.push(doi);
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

/** Pruefziffer. normalizeIsbn prueft nur die Form — beim Freitext-Scan faellt
 *  sonst jede zehnstellige Telefonnummer hinter „ISBN" durch. */
function isbnChecksumOk(isbn) {
  if (/^\d{9}[\dX]$/.test(isbn)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const d = isbn[i] === 'X' ? 10 : Number(isbn[i]);
      sum += d * (10 - i);
    }
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(isbn)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(isbn[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  return false;
}

/** ISBN-Kandidaten aus dem Textanfang, normalisiert, pruefziffer-gueltig. */
function findIsbnCandidates(text) {
  const out = [];
  const s = String(text ?? '').slice(0, ISBN_HEAD_CHARS);
  for (const m of s.matchAll(ISBN_RE)) {
    const isbn = normalizeIsbn(m[1]);
    if (isbn && isbnChecksumOk(isbn) && !out.includes(isbn)) out.push(isbn);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * Steht dieser Titel im PDF? Anteil der Titel-Tokens im Token-Set des
 * Textanfangs. Ein Registertreffer, dessen Titel nicht im Dokument steht,
 * beschreibt ein anderes Werk — dann lieber die naechste Kennung versuchen.
 */
function titleInText(title, text) {
  const want = titleTokens(title);
  if (!want.size) return false;
  const have = titleTokens(String(text ?? '').slice(0, TITLE_HEAD_CHARS));
  let hit = 0;
  for (const t of want) if (have.has(t)) hit++;
  return hit / want.size >= TITLE_IN_TEXT_MIN;
}

/**
 * Metadaten-Texte eines PDFs in Suchreihenfolge fuer findDoiCandidates.
 * `info` ist das Info-Dictionary (Title/Subject/Keywords, manche Verlage legen
 * einen eigenen `doi`-Schluessel an), `xmp` das rohe XMP-Paket (prism:doi,
 * dc:identifier).
 */
function metaSearchStrings(info, xmp) {
  const out = [];
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info)) {
      if (typeof v === 'string' && /doi|subject|keywords|identifier/i.test(k)) out.push(v);
    }
  }
  if (typeof xmp === 'string' && xmp) out.push(xmp);
  return out;
}

// ── Adresse eines gedruckten Web-Artikels ────────────────────────────────────
// Ein aus dem Browser gedrucktes PDF traegt die Seitenadresse in der Kopf- oder
// Fusszeile JEDER Seite. Genau das ist das Signal: eine URL, die mehrfach
// vorkommt, oder die einzige URL ganz am Anfang bzw. Ende des Texts (einseitiger
// Druck). Eine Adresse aus dem Fliesstext — ein Link auf eine Studie, die
// Lizenz, das Impressum — ist nicht die Adresse des Dokuments selbst.
const URL_RE = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
const URL_EDGE_CHARS = 300;

function _cleanUrl(u) {
  const out = u.replace(/[.,;:!?)\]}>]+$/, '');
  // Vom Browser gekuerzte Adresse („…/artikel-ueber-die-st…") ist keine Adresse.
  if (/…$|\.\.\.$/.test(out)) return null;
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(out)) return null; // DOI-Pfad hat Vorrang
  return out.length > 12 ? out : null;
}

/** Adresse des Dokuments aus Kopf-/Fusszeilen, oder null. */
function findPrintedUrl(text) {
  const s = String(text ?? '');
  const counts = new Map();
  const first = new Map();
  for (const m of s.matchAll(URL_RE)) {
    const u = _cleanUrl(m[0]);
    if (!u) continue;
    counts.set(u, (counts.get(u) || 0) + 1);
    if (!first.has(u)) first.set(u, m.index);
  }
  let best = null;
  for (const [u, n] of counts) {
    if (n < 2) continue;
    if (!best || n > counts.get(best) || (n === counts.get(best) && first.get(u) < first.get(best))) best = u;
  }
  if (best) return best;
  const edge = [...counts.keys()].filter(u => first.get(u) < URL_EDGE_CHARS
    || first.get(u) > s.length - URL_EDGE_CHARS);
  return edge.length === 1 ? edge[0] : null;
}

/** PDF-Datum (`D:20240312140500+01'00'`) → `YYYY-MM-DD`, sonst null. Beim
 *  Browser-Druck ist das Erstellungsdatum der Tag, an dem die Seite abgerufen
 *  wurde — genauer als „heute", wenn das PDF erst Wochen spaeter hochkommt. */
function pdfDateToIso(raw) {
  const m = /^(?:D:)?(\d{4})(\d{2})(\d{2})/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const iso = parseIssuedDate(`${m[1]}-${m[2]}-${m[3]}`);
  return iso && iso.length === 10 ? iso : null;
}

module.exports = {
  DOI_HEAD_CHARS, ISBN_HEAD_CHARS, TITLE_HEAD_CHARS, TITLE_IN_TEXT_MIN,
  findDoiCandidates, findIsbnCandidates, isbnChecksumOk, titleInText, metaSearchStrings,
  findPrintedUrl, pdfDateToIso,
};
