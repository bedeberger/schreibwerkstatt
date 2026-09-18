'use strict';
// Recherche-Profil eines Buchs: Freitext-Steuerung + Domain-Eingrenzung fuer den
// Recherche-Chat (docs/recherche-chat.md).
//
// Warum am BUCH und nicht am User: „ich suche wissenschaftliche Literatur zu
// Kardiologie" ist eine Aussage ueber DIESE Arbeit, nicht ueber die Person —
// dieselbe Autorin recherchiert im naechsten Projekt Bauernkriege. Damit sitzt
// das Profil auf derselben Achse wie `buch_kontext` und `stilprofil`.
//
// Diese Datei ist die SSoT der Normalisierung: sie entscheidet, was als Domain
// gespeichert wird. Der Wert geht doppelt in den Call — als `allowed_domains`
// ans serverseitige `web_search`-Werkzeug UND als Klartext in den System-Prompt
// (das Modell muss wissen, dass es eingegrenzt ist, sonst deutet es die leere
// Trefferliste als „gibt es nicht").

// Freitext: ~1500 Zeichen sind eine knappe Seite — genug fuer Fachgebiet,
// bevorzugte Quellenarten und Zitierwuensche, zu wenig fuer ein zweites
// Stilprofil. Der Block steht in JEDEM Recherche-Call im Prompt.
const RESEARCH_PROFILE_MAX = 1500;
// Anthropics `allowed_domains` ist eine harte Eingrenzung: je mehr Domains,
// desto weniger grenzt sie ein. 20 ist reichlich fuer ein Fachgebiet.
const MAX_DOMAINS = 20;

/**
 * Eine Zeile der Domain-Eingabe zu einem Hostnamen normalisieren.
 * Nimmt alles, was ein Mensch hineinkopiert (ganze URL, `www.`-Form, Grossschrift)
 * und gibt den blanken Host zurueck — oder `null`, wenn daraus keiner wird.
 * Die Umwandlung laeuft ueber `URL`, damit IDN automatisch zu Punycode wird.
 */
function normalizeDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host;
  try { host = new URL(s).hostname; } catch { return null; }
  // `www.` weg: Anthropic matcht eine Domain samt Subdomains, die Vorsilbe
  // wuerde die Eingrenzung nur enger machen als gemeint.
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.') || host.length > 253) return null;
  // Eine nackte IP ist keine Recherche-Quelle, sondern ein Weg an der
  // Domain-Idee vorbei.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (/(^|\.)[-.]|-(\.|$)/.test(host)) return null;
  return host;
}

/** Eingabe (Textarea oder Array) zu einer deduplizierten, gedeckelten Hostliste. */
function normalizeDomains(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const out = [];
  for (const entry of raw) {
    const host = normalizeDomain(entry);
    if (host && !out.includes(host)) out.push(host);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

/** Hostliste in die Speicherform (eine Domain pro Zeile). Leer ⇒ NULL. */
function serializeDomains(list) {
  const arr = normalizeDomains(list);
  return arr.length ? arr.join('\n') : null;
}

/** Speicherform zurueck zur Hostliste. Toleriert Altbestand in einer Zeile. */
function parseDomains(stored) {
  if (!stored) return [];
  return normalizeDomains(stored);
}

/** Freitext normalisieren: getrimmt, gedeckelt, leer ⇒ NULL. */
function normalizeProfile(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  return text.slice(0, RESEARCH_PROFILE_MAX);
}

module.exports = {
  RESEARCH_PROFILE_MAX,
  MAX_DOMAINS,
  normalizeDomain,
  normalizeDomains,
  serializeDomains,
  parseDomains,
  normalizeProfile,
};
