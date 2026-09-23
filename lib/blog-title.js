'use strict';
// Titel-Regeln fuer beide Blog-Syncs (WordPress + HubSpot) — EINE Stelle, damit
// Push, Pull und Konflikt-Aufloesung denselben Titel meinen.
//
// Zwei Quellen fuer den Titel eines Beitrags:
//   1. Titel-Werkstatt (`page_headline.titel`) — gesetzt, gewinnt sie immer
//      (lib/headline-render.js: „der Titel ERSETZT den Seitennamen").
//   2. Sonst der Seitenname OHNE den app-internen Datums-Praefix
//      `YYYY-MM-DD: ` — der ist Ordnung im Buchorganizer, nicht Schlagzeile.
//
// Zurueck (Pull) gilt dieselbe Zuordnung: hat die Seite einen Werkstatt-Titel,
// landet ein in WordPress geaenderter Titel dort — sonst ueberschriebe der
// naechste Push ihn stumm mit dem alten. Ohne Werkstatt-Titel landet er im
// Seitennamen, und dessen Datums-Praefix bleibt stehen.

const { decodeEntities } = require('./html-text');

const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:\s*:\s*([\s\S]*))?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `"2025-01-02: Titel"` → `{ date: '2025-01-02', rest: 'Titel' }`; ohne Praefix `date: null`. */
function splitDatePrefix(name) {
  const raw = String(name || '').trim();
  const m = DATE_PREFIX_RE.exec(raw);
  if (!m) return { date: null, rest: raw };
  return { date: m[1], rest: String(m[2] || '').trim() };
}

/** Titel, der das Haus verlaesst: Werkstatt-Titel, sonst Seitenname ohne Datum. '' = keiner. */
function outgoingTitle(pageName, hl) {
  const t = String(hl?.titel || '').trim();
  return t || splitDatePrefix(pageName).rest;
}

/** Klartext eines WP-Titel-Objekts. `raw` (context=edit) ist unkodiert;
 *  `rendered` traegt wptexturize-Entities (`&#8217;`, `&amp;`) und muss
 *  dekodiert werden, sonst stehen sie woertlich im Seitennamen. */
function wpTitleText(title) {
  if (!title) return '';
  if (typeof title === 'string') return decodeEntities(title.replace(/<[^>]+>/g, '')).trim();
  if (typeof title.raw === 'string') return title.raw.trim();
  return decodeEntities(String(title.rendered || '').replace(/<[^>]+>/g, '')).trim();
}

/** Seitenname fuer einen neu angelegten Beitrag: `YYYY-MM-DD: Titel` (Datum aus dem Post). */
function importedPageName(title, day, fallback) {
  const t = String(title || '').trim() || String(fallback || '').trim();
  const d = String(day || '').slice(0, 10);
  return DAY_RE.test(d) ? (t ? `${d}: ${t}` : d) : t;
}

/**
 * Plan, was ein vom Remote gelesener Titel lokal aendert.
 * Liefert `{ name?, headlinePatch }` — `name` nur, wenn der Seitenname sich
 * aendert; `headlinePatch` ist ein Teil-PUT fuer db/headline#setHeadline.
 *
 * Bestehender Datums-Praefix bleibt: er ist lokale Ordnung und soll nicht bei
 * jedem Pull auf das (UTC-)Datum des Posts springen.
 */
function planPulledTitle({ currentName, hl, remoteTitle, postDay }) {
  const title = String(remoteTitle || '').trim();
  const out = { headlinePatch: {} };
  if (!title) return out;
  if (String(hl?.titel || '').trim()) {
    if (title !== hl.titel.trim()) out.headlinePatch.titel = title;
    return out;
  }
  const { date, rest } = splitDatePrefix(currentName);
  if (rest === title) return out;
  const next = date ? `${date}: ${title}` : importedPageName(title, postDay, currentName);
  if (next !== String(currentName || '').trim()) out.name = next;
  return out;
}

module.exports = {
  splitDatePrefix, outgoingTitle, wpTitleText, importedPageName, planPulledTitle,
};
