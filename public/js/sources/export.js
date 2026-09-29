// Verzeichnis-Export der Quellen-Karte: eine Auswahl von Quellen in ein
// Format zum Kopieren oder Herunterladen bringen.
//
// Reines Modul (kein DOM, kein Alpine, kein Netz) — Tests laden es direkt.
// Die Auswahl (welche Buecher, welche Schlagworte) trifft der Aufrufer
// (public/js/sources/export-panel.js), hier wird nur formatiert.
//
// Zwei Familien:
//   Lesefassungen   list · markdown · links — im Zitierstil des Aufrufers
//                   gesetzt (format.js ist die SSoT fuer den Eintragstext), je
//                   als Klartext UND HTML. Das HTML ist fuer die Zwischenablage:
//                   ein Rich-Text-Editor (Moodle, Word, Mail) uebernimmt es als
//                   Aufzaehlung mit Kursivsatz und klickbaren Links.
//   Austausch       bibtex · ris · csl-json — fuer Zotero, Citavi, LaTeX. Die
//                   Feldzuordnung spiegelt lib/bib-parse.js, damit ein Export
//                   durch den eigenen Import wieder dieselbe Quelle ergibt.
//                   Schlagworte gehen als keywords/KW/keyword mit.

import { formatFullRuns, runsToText, runsToHtml, sortEntries, assignYearSuffixes } from './format.js';
import { locatorUrl } from './format/runs.js';
import { escHtml } from '../utils/escape.js';

export const EXPORT_FORMATS = ['list', 'markdown', 'links', 'bibtex', 'ris', 'csl-json'];

/** Formate, die eine Lesefassung im Zitierstil sind (brauchen `style`/`lang`). */
export const STYLED_FORMATS = new Set(['list', 'markdown', 'links']);

const FILE_META = {
  list:       { ext: 'txt',  mime: 'text/plain' },
  markdown:   { ext: 'md',   mime: 'text/markdown' },
  links:      { ext: 'txt',  mime: 'text/plain' },
  bibtex:     { ext: 'bib',  mime: 'application/x-bibtex' },
  ris:        { ext: 'ris',  mime: 'application/x-research-info-systems' },
  'csl-json': { ext: 'json', mime: 'application/json' },
};

/** Dateiendung + MIME-Typ fuer den Download. */
export function exportFileMeta(format) {
  return FILE_META[format] || FILE_META.list;
}

// ── Lesefassungen ────────────────────────────────────────────────────────────

/** Sortierte Eintraege im Stil, mit Jahres-Buchstaben ueber die Auswahl.
 *  Im numerischen Stil zaehlt die Verzeichnis-Reihenfolge: ohne Buchtext gibt
 *  es keine Zitierreihenfolge, also wird alphabetisch sortiert und in dieser
 *  Folge nummeriert. */
function _entries(sources, { style, lang }) {
  const sorted = sortEntries(sources, { style: style === 'numeric' ? 'apa7' : style, lang });
  const suffixes = style === 'numeric' ? new Map() : assignYearSuffixes(sorted, { lang });
  return sorted.map((s, i) => {
    const runs = formatFullRuns(s, { style, lang, suffix: suffixes.get(s.id) || '' });
    const extra = _extraUrl(s);
    if (extra) runs.push({ text: ' ' }, { text: extra, url: true });
    return { src: s, runs, num: style === 'numeric' ? i + 1 : null };
  });
}

/** Die URL einer Quelle, die neben der DOI steht. Der Eintrag nennt nach
 *  Zitierregel nur die DOI (locatorUrl); fuer die Zwischenablage soll die
 *  Webadresse trotzdem mitkommen — das Buch-Verzeichnis bleibt bei der Regel. */
function _extraUrl(src) {
  const url = src.url ? String(src.url).trim() : '';
  return url && url !== locatorUrl(src) ? url : '';
}

// Run → HTML mit klickbarer Adresse. format.js#runsToHtml setzt Adressen als
// Text (das Buch-Verzeichnis verlinkt nicht); fuer die Zwischenablage ist der
// Link der halbe Nutzen.
function _runsToLinkedHtml(runs) {
  return runs.map(r => {
    if (r.url && /^https?:\/\//i.test(r.text)) {
      const u = escHtml(r.text);
      return `<a href="${u}">${u}</a>`;
    }
    return runsToHtml([r]);
  }).join('');
}

// Markdown: Kursiv als *…*; Sternchen/Unterstriche im Feldtext escapen, sonst
// kippt ein Titel wie „*Ungeduld*" die Formatierung der ganzen Zeile.
function _mdEscape(s) {
  return String(s).replace(/([\\*_`[\]])/g, '\\$1');
}
function _runsToMarkdown(runs) {
  return runs.map(r => {
    if (r.url) return `<${r.text}>`;
    const t = _mdEscape(r.text);
    return r.italic ? `*${t}*` : t;
  }).join('');
}

function _numPrefix(e) {
  return e.num ? `[${e.num}] ` : '';
}

function _list(sources, opts) {
  const entries = _entries(sources, opts);
  const text = entries.map(e => `${_numPrefix(e)}${runsToText(e.runs)}`).join('\n');
  const tag = opts.style === 'numeric' ? 'ol' : 'ul';
  const html = entries.length
    ? `<${tag}>${entries.map(e => `<li>${_runsToLinkedHtml(e.runs)}</li>`).join('')}</${tag}>`
    : '';
  return { text, html };
}

function _markdown(sources, opts) {
  const entries = _entries(sources, opts);
  const text = entries
    .map(e => (e.num ? `${e.num}. ` : '- ') + _runsToMarkdown(e.runs))
    .join('\n');
  return { text, html: _list(sources, opts).html };
}

/** Linksammlung: nur Quellen mit Adresse (DOI vor URL, wie im Verzeichnis;
 *  eine abweichende URL folgt als zweiter Link). Beschriftung ist der Titel, dahinter Urheber und Jahr als Kontext. */
function _links(sources, opts) {
  const entries = _entries(sources, opts).filter(e => locatorUrl(e.src));
  const label = (s) => String(s.title || '').trim() || runsToText(formatFullRuns(s, opts));
  const context = (s) => {
    const persons = (s.authors?.length ? s.authors : s.editors) || [];
    const who = persons.map(p => p.literal || p.family).filter(Boolean).slice(0, 2).join(', ')
      + (persons.length > 2 ? ' et al.' : '');
    const year = s.year ? String(s.year).trim() : '';
    return [who, year].filter(Boolean).join(', ');
  };
  const text = entries.map(e => {
    const ctx = context(e.src);
    const extra = _extraUrl(e.src);
    return `- ${label(e.src)}${ctx ? ` (${ctx})` : ''}: ${locatorUrl(e.src)}${extra ? ` · ${extra}` : ''}`;
  }).join('\n');
  const html = entries.length
    ? `<ul>${entries.map(e => {
      const u = escHtml(locatorUrl(e.src));
      const ctx = context(e.src);
      const extra = escHtml(_extraUrl(e.src));
      return `<li><a href="${u}">${escHtml(label(e.src))}</a>${ctx ? ` (${escHtml(ctx)})` : ''}`
        + `${extra ? ` · <a href="${extra}">${extra}</a>` : ''}</li>`;
    }).join('')}</ul>`
    : '';
  return { text, html, skipped: sources.length - entries.length };
}

// ── Austauschformate ─────────────────────────────────────────────────────────

// csl_type → Eintragstyp. Umkehrung von BIBTEX_TYPES/RIS_TYPES in
// lib/bib-parse.js: je Gattung der Typ, den der Import wieder auf dieselbe
// Gattung abbildet.
const BIBTEX_TYPE = {
  // newspaper → @article + entrysubtype (biblatex); der Import liest den Subtyp.
  book: 'book', chapter: 'incollection', article: 'article', newspaper: 'article', website: 'online',
  thesis: 'thesis', report: 'report', legal: 'legal', interview: 'misc',
  film: 'movie', dataset: 'dataset', other: 'misc',
};
const RIS_TYPE = {
  book: 'BOOK', chapter: 'CHAP', article: 'JOUR', newspaper: 'NEWS', website: 'ELEC',
  thesis: 'THES', report: 'RPRT', legal: 'LEGAL', interview: 'GEN',
  film: 'MPCT', dataset: 'DATA', other: 'GEN',
};
const CSL_JSON_TYPE = {
  book: 'book', chapter: 'chapter', article: 'article-journal', newspaper: 'article-newspaper', website: 'webpage',
  thesis: 'thesis', report: 'report', legal: 'legislation', interview: 'interview',
  film: 'motion_picture', dataset: 'dataset', other: 'document',
};

function _personBib(p) {
  if (p.literal) return `{${p.literal}}`;
  return p.given ? `${p.family}, ${p.given}` : p.family;
}

// BibTeX-Wert in Klammern. Klammern im Text muessen balanciert bleiben — eine
// einzelne `}` beendete das Feld vorzeitig; sie wird darum entfernt statt
// escapet (`\}` versteht nicht jeder Parser).
function _bibValue(v) {
  const s = String(v).replace(/[\r\n]+/g, ' ').trim();
  let depth = 0;
  let out = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') { if (depth === 0) continue; depth--; }
    out += ch;
  }
  return `{${out}${'}'.repeat(depth)}}`;
}

function _slug(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 24);
}

/** Zitierschluessel fuer den Export: der eigene, sonst Nachname+Jahr(+Suffix).
 *  Eindeutig innerhalb der Datei — BibTeX verweigert doppelte Schluessel. */
function _citekeys(sources) {
  const used = new Set();
  const out = new Map();
  for (const s of sources) {
    const p = (s.authors?.[0] || s.editors?.[0]) || {};
    const year = String(s.year || '').match(/\d{4}/)?.[0] || '';
    const base = s.citekey || `${_slug(p.family || p.literal || s.title) || 'quelle'}${year}`;
    let key = base;
    for (let i = 0; used.has(key.toLowerCase()); i++) {
      key = i < 26 ? `${base}${String.fromCharCode(97 + i)}` : `${base}-${i + 1}`;
    }
    used.add(key.toLowerCase());
    out.set(s.id, key);
  }
  return out;
}

function _bibtex(sources) {
  const keys = _citekeys(sources);
  const blocks = sources.map(s => {
    const f = [];
    const add = (name, v) => { if (v != null && String(v).trim() !== '') f.push([name, v]); };
    if (s.authors?.length) add('author', s.authors.map(_personBib).join(' and '));
    if (s.editors?.length) add('editor', s.editors.map(_personBib).join(' and '));
    if (s.csl_type === 'newspaper') add('entrysubtype', 'newspaper');
    add('title', s.title);
    add(s.csl_type === 'article' || s.csl_type === 'newspaper' ? 'journal' : 'booktitle', s.container_title);
    add(s.csl_type === 'thesis' ? 'school' : 'publisher', s.publisher);
    add('address', s.place);
    add('year', s.year);
    add('date', s.issued_date);
    add('edition', s.edition);
    add('volume', s.volume);
    add('number', s.issue);
    add('pages', s.pages);
    add('doi', s.doi);
    add('isbn', s.isbn);
    add('issn', s.issn);
    add('url', s.url);
    add('urldate', s.accessed_at);
    add('note', s.note);
    add('keywords', (s.tags || []).join(', '));
    const body = f.map(([k, v]) => `  ${k} = ${_bibValue(v)}`).join(',\n');
    return `@${BIBTEX_TYPE[s.csl_type] || 'misc'}{${keys.get(s.id)},\n${body}\n}`;
  });
  return blocks.join('\n\n');
}

function _personRis(p) {
  if (p.literal) return p.literal;
  return p.given ? `${p.family}, ${p.given}` : p.family;
}

function _ris(sources) {
  const keys = _citekeys(sources);
  const records = sources.map(s => {
    const lines = [];
    const add = (tag, v) => {
      if (v == null || String(v).trim() === '') return;
      lines.push(`${tag}  - ${String(v).replace(/[\r\n]+/g, ' ').trim()}`);
    };
    add('TY', RIS_TYPE[s.csl_type] || 'GEN');
    add('ID', keys.get(s.id));
    for (const p of s.authors || []) add('AU', _personRis(p));
    for (const p of s.editors || []) add('ED', _personRis(p));
    add('TI', s.title);
    add(s.csl_type === 'article' || s.csl_type === 'newspaper' ? 'JO' : 'T2', s.container_title);
    add('PB', s.publisher);
    add('CY', s.place);
    add('PY', s.year);
    // RIS-Datumsform „2024/03/12/" — so schreiben Zotero und EndNote das Feld.
    if (s.issued_date) add('DA', `${String(s.issued_date).replace(/-/g, '/')}/`);
    add('ET', s.edition);
    add('VL', s.volume);
    add('IS', s.issue);
    const [sp, ep] = String(s.pages || '').split(/\s*[-–]\s*/);
    add('SP', sp);
    add('EP', ep);
    add('DO', s.doi);
    add('SN', s.isbn || s.issn);
    add('UR', s.url);
    add('Y2', s.accessed_at);
    add('N1', s.note);
    for (const t of s.tags || []) add('KW', t);
    lines.push('ER  - ');
    return lines.join('\n');
  });
  return records.join('\n\n');
}

function _cslPerson(p) {
  if (p.literal) return { literal: p.literal };
  return p.given ? { family: p.family, given: p.given } : { family: p.family };
}

function _cslDate(v) {
  const m = String(v || '').match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return v ? { literal: String(v) } : undefined;
  return { 'date-parts': [[m[1], m[2], m[3]].filter(Boolean).map(Number)] };
}

function _cslJson(sources) {
  const keys = _citekeys(sources);
  const items = sources.map(s => {
    const item = { id: keys.get(s.id), type: CSL_JSON_TYPE[s.csl_type] || 'document' };
    const set = (k, v) => { if (v != null && String(v).trim() !== '') item[k] = v; };
    if (s.authors?.length) item.author = s.authors.map(_cslPerson);
    if (s.editors?.length) item.editor = s.editors.map(_cslPerson);
    set('title', s.title);
    set('container-title', s.container_title);
    set('publisher', s.publisher);
    set('publisher-place', s.place);
    if (s.issued_date || s.year) item.issued = _cslDate(s.issued_date || s.year);
    set('edition', s.edition);
    set('volume', s.volume);
    set('issue', s.issue);
    set('page', s.pages);
    set('DOI', s.doi);
    set('ISBN', s.isbn);
    set('ISSN', s.issn);
    set('URL', s.url);
    if (s.accessed_at) item.accessed = _cslDate(s.accessed_at);
    set('note', s.note);
    if (s.tags?.length) item.keyword = s.tags.join(', ');
    return item;
  });
  return JSON.stringify(items, null, 2);
}

// ── Einstieg ─────────────────────────────────────────────────────────────────

/** Quellen in ein Exportformat bringen.
 *  @returns {{ text: string, html: string, count: number, skipped: number }}
 *    `html` nur bei den Lesefassungen (sonst ''), `skipped` = Quellen, die das
 *    Format nicht fassen kann (Linksammlung: ohne Adresse). */
export function exportSources(sources, { format = 'list', style = 'apa7', lang = 'de' } = {}) {
  const list = Array.isArray(sources) ? sources.filter(Boolean) : [];
  const opts = { style, lang };
  let out;
  switch (format) {
    case 'markdown': out = _markdown(list, opts); break;
    case 'links':    out = _links(list, opts); break;
    case 'bibtex':   out = { text: _bibtex(sortEntries(list, { lang })), html: '' }; break;
    case 'ris':      out = { text: _ris(sortEntries(list, { lang })), html: '' }; break;
    case 'csl-json': out = { text: _cslJson(sortEntries(list, { lang })), html: '' }; break;
    default:         out = _list(list, opts);
  }
  const skipped = out.skipped || 0;
  return { text: out.text, html: out.html || '', count: list.length - skipped, skipped };
}
