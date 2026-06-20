// Plot-Werkstatt (Beat-Board): planende KI-Assistenz für die Handlungsskizze.
// Zwei Job-Typen — beide rein planend/überwachend, NIE generativ in den Text:
//   - Brainstorm:   schlägt Beats (Handlungspunkte) für einen Akt vor.
//   - Consistency:  prüft den geplanten Plot gegen die Buchrealität
//                   (Kapitel + extrahierte Szenen + Figuren) und meldet
//                   Brüche, Lücken und „geplant vs. schon geschrieben"-Drift.
//
// Severity-Vokabular: kritisch/stark/mittel/schwach/niedrig — matcht
// .severity-tag--* in DESIGN.md (gleiche Skala wie die Figuren-Werkstatt).

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

const SEVERITY_ENUM = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

const STATUS_LABEL = {
  geplant: 'geplant',
  entwurf: 'Entwurf',
  im_buch: 'im Buch',
  verworfen: 'verworfen',
};

// ── Hilfen ───────────────────────────────────────────────────────────────────

// Kompakte Board-Übersicht: Akte als Spalten, Beats darunter mit Status + Kapitel.
// threadInfo (optional): Map id→{name, figur, kapitel}; existieren Stränge, wird je
// Beat der Strang annotiert. Vererbung (live): ein Beat ohne eigenes Kapitel erbt
// das Strang-Kapitel (als „(vom Strang)" markiert); die Strang-Hauptfigur gilt
// implizit als beteiligt (Regel-Hinweis im Prompt, hier nicht pro Beat wiederholt).
function _boardOutline(acts, beats, threadInfo = null) {
  return (acts || []).map(act => {
    const own = (beats || [])
      .filter(b => b.act_id === act.id)
      .map(b => {
        const st = STATUS_LABEL[b.status] || b.status;
        const info = threadInfo && b.thread_id != null ? threadInfo[b.thread_id] : null;
        const kap = b.chapter_name
          ? ` → Kapitel: ${b.chapter_name}`
          : (info && info.kapitel ? ` → Kapitel: ${info.kapitel} (vom Strang)` : '');
        const str = info ? ` {Strang: ${info.name}}` : '';
        return `  - ${b.titel} [${st}]${kap}${str}`;
      });
    // Hybrid-Akte: ein Akt kann GETEILT sein (alle Stränge) oder einem Strang
    // EIGEN gehören (thread_id). Eigene Akte ausweisen, damit die KI versteht,
    // dass dieser Strang eine unabhängige Aktstruktur hat (kein „fehlt"-Befund).
    const owner = act.thread_id != null && threadInfo ? threadInfo[act.thread_id] : null;
    const head = owner ? `AKT (eigener Akt von Strang „${owner.name}"): ${act.name}` : `AKT (geteilt): ${act.name}`;
    return `${head}\n${own.length ? own.join('\n') : '  (noch keine Beats)'}`;
  }).join('\n\n');
}

// Haben Stränge eine eigene Aktstruktur (Hybrid)? Dann lohnt der Erklär-Hinweis,
// dass geteilte und strang-eigene Akte nebeneinander existieren.
function _hasOwnActs(acts) {
  return (acts || []).some(a => a && a.thread_id != null);
}

// Handlungsstränge (Swimlanes) als Block: Name + optional gebundene Hauptfigur +
// gebundenes Kapitel. Beats der Lane erben Figur + Kapitel implizit.
function _straengeLines(threads) {
  return (threads || []).slice(0, 40)
    .map(t => {
      const fig = t.figur ? ` (Hauptfigur: ${t.figur})` : '';
      const kap = t.kapitel ? ` (Kapitel: ${t.kapitel})` : '';
      return `- ${t.name}${fig}${kap}`;
    })
    .join('\n');
}

// Lookup id→{name, figur, kapitel} aus der Stränge-Liste (Board-Annotation inkl.
// Kapitel-Vererbung).
function _threadInfoMap(threads) {
  const map = {};
  for (const t of (threads || [])) if (t && t.id != null) map[t.id] = { name: t.name, figur: t.figur || null, kapitel: t.kapitel || null };
  return map;
}

// Hat irgendein Strang eine gebundene Hauptfigur oder ein Kapitel? Dann lohnt der
// Vererbungs-Hinweis im Prompt.
function _hasThreadInheritance(threads) {
  return (threads || []).some(t => t && (t.figur || t.kapitel));
}

function _trunc(s, max = 280) {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Beziehungen einer Figur (Soziogramm): „Partner (Typ)". `mit` ist bereits ein
// aufgelöster Name (der Job übersetzt die fig_id vor dem Prompt-Bau).
function _relLine(beziehungen) {
  const rels = (beziehungen || []).filter(b => b && b.mit).slice(0, 12);
  if (!rels.length) return '';
  return `\n  Beziehungen: ${rels.map(b => `${b.mit}${b.typ ? ` (${b.typ})` : ''}`).join('; ')}`;
}

// Lebensereignisse einer Figur (Figuren-Zeitstrahl): „Datum: Ereignis [Kapitel]".
function _eventsLine(lebensereignisse) {
  const evs = (lebensereignisse || []).filter(e => e && e.ereignis).slice(0, 10);
  if (!evs.length) return '';
  return `\n  Ereignisse: ${evs.map(e => `${e.datum ? `${e.datum}: ` : ''}${e.ereignis}${e.kapitel ? ` [${e.kapitel}]` : ''}`).join(' · ')}`;
}

// Detaillierter Figuren-Block für BEIDE Jobs: Name + Kurzname, Rollen-Meta
// (Typ/Beruf/Geschlecht), Tags, gekürzte Beschreibung und — sofern vorhanden —
// Beziehungen (Soziogramm) + Lebensereignisse (Zeitstrahl). So kann die KI Beats
// auf konkrete Figurenprofile, ihr Beziehungsgeflecht und ihre Chronologie
// zuschneiden statt nur auf Namen.
function _figurenLinesDetail(figuren) {
  return (figuren || []).slice(0, 120)
    .map(f => {
      const meta = [f.typ, f.beruf, f.geschlecht].filter(Boolean).join(', ');
      const head = `- ${f.name}${f.kurzname ? ` („${f.kurzname}")` : ''}${meta ? ` [${meta}]` : ''}`;
      const besch = f.beschreibung ? `\n  ${_trunc(f.beschreibung)}` : '';
      const tags = (f.tags || []).length ? `\n  Tags: ${f.tags.join(', ')}` : '';
      return `${head}${besch}${tags}${_relLine(f.beziehungen)}${_eventsLine(f.lebensereignisse)}`;
    })
    .join('\n');
}

// Schauplätze des Buchs: Name + Typ/Stimmung + gekürzte Beschreibung.
function _orteLines(orte) {
  return (orte || []).slice(0, 60)
    .map(o => {
      const meta = [o.typ, o.stimmung].filter(Boolean).join(', ');
      const besch = o.beschreibung ? `: ${_trunc(o.beschreibung, 160)}` : '';
      return `- ${o.name}${meta ? ` [${meta}]` : ''}${besch}`;
    })
    .join('\n');
}

// Buchweiter Figuren-Zeitstrahl (figure_events, chronologisch): „Datum — Ereignis
// (Figur) [Kapitel]". Grundlage für Chronologie-Prüfungen im Consistency-Check.
function _zeitstrahlLines(zeitstrahl) {
  return (zeitstrahl || []).slice(0, 200)
    .map(e => {
      const d = e.datum ? `${e.datum} — ` : '';
      const fig = e.figur ? ` (${e.figur})` : '';
      const kap = e.kapitel ? ` [${e.kapitel}]` : '';
      return `- ${d}${e.ereignis}${fig}${kap}`;
    })
    .join('\n');
}

// Bekannte (offene) Kontinuitäts-Befunde aus dem letzten Continuity-Check.
function _kontinuitaetLines(issues) {
  return (issues || []).slice(0, 40)
    .map(i => {
      const sev = i.schwere ? `[${i.schwere}] ` : '';
      const figs = (i.figuren || []).length ? ` (Figuren: ${i.figuren.join(', ')})` : '';
      const kap = (i.kapitel || []).length ? ` [${i.kapitel.join(', ')}]` : '';
      const emp = i.empfehlung ? `\n  Empfehlung: ${i.empfehlung}` : '';
      return `- ${sev}${i.beschreibung}${figs}${kap}${emp}`;
    })
    .join('\n');
}

// Werkstatt-Figuren (Figuren-Werkstatt-Drafts): in Entwicklung, evtl. noch nicht
// im Manuskript. Name + optionaler Archetyp.
function _werkstattFigurenLines(figuren) {
  return (figuren || []).slice(0, 60)
    .map(f => `- ${f.name}${f.archetype ? ` [${f.archetype}]` : ''}`)
    .join('\n');
}

function _kapitelLines(kapitel) {
  return (kapitel || []).slice(0, 200)
    .map((k, i) => `${i + 1}. ${k}`)
    .join('\n');
}

// Szenen als „Buchrealität": Titel — Kapitel — beteiligte Figuren.
function _szenenLines(szenen) {
  return (szenen || []).slice(0, 150)
    .map(s => {
      const kap = s.kapitel ? ` — ${s.kapitel}` : '';
      const figs = (s.figuren || []).length ? ` (${s.figuren.join(', ')})` : '';
      return `- ${s.titel}${kap}${figs}`;
    })
    .join('\n');
}

// ── System-Prompt ────────────────────────────────────────────────────────────
// Self-contained (keine Locale-Config-Abhängigkeit): Rolle + JSON-Only-Pflicht.

export function buildPlotSystemPrompt() {
  return `Du bist ein erfahrener Dramaturg und Lektor. Du hilfst der Autorin, die HANDLUNG (Plot) ihres Buches zu PLANEN und zu strukturieren — als Beat-Board aus Akten (Spalten) und Beats (einzelnen Handlungspunkten).

WICHTIG: Du planst und prüfst nur die STRUKTUR. Du schreibst NIEMALS Fliesstext, Szenen oder Prosa ins Manuskript. Deine Beats sind kurze, strukturelle Stichpunkte — keine ausformulierten Textpassagen.${_jsonOnly()}`;
}

// ── Brainstorm ──────────────────────────────────────────────────────────────
// Schlägt 3–7 Beats für einen bestimmten Akt vor, passend zum bisherigen Board,
// Buchkontext und Figuren-Ensemble.

export function buildPlotBrainstormPrompt(aktName, acts, beats, buchKontext, figuren = [], kapitel = [], werkstattFiguren = [], threads = [], threadInfo = null, orte = [], zeitstrahl = []) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const figLines = _figurenLinesDetail(figuren);
  const figSeg = figLines ? `\nFIGUREN-ENSEMBLE:\n${figLines}\n` : '';
  const wfLines = _werkstattFigurenLines(werkstattFiguren);
  const wfSeg = wfLines ? `\nFIGUREN-WERKSTATT (in Entwicklung, evtl. noch nicht im Manuskript — als Beat-Figuren nutzbar):\n${wfLines}\n` : '';
  const kapLines = _kapitelLines(kapitel);
  const kapSeg = kapLines ? `\nVORHANDENE KAPITEL (chronologisch):\n${kapLines}\n` : '';
  const orteLines = _orteLines(orte);
  const orteSeg = orteLines ? `\nSCHAUPLÄTZE (Orte des Buchs):\n${orteLines}\n` : '';
  const zeitLines = _zeitstrahlLines(zeitstrahl);
  const zeitSeg = zeitLines ? `\nZEITSTRAHL (chronologische Ereignisse der Figuren):\n${zeitLines}\n` : '';
  const strLines = _straengeLines(threads);
  const inheritNote = _hasThreadInheritance(threads)
    ? '\nVERERBUNG: Ein Beat in einem Strang beteiligt IMPLIZIT dessen Hauptfigur; hat er kein eigenes Kapitel, gilt das Kapitel des Strangs. Behandle das als gesetzt, auch wenn es nicht pro Beat wiederholt wird.\n'
    : '';
  const strSeg = strLines ? `\nHANDLUNGSSTRÄNGE (Swimlanes — parallele Erzähllinien, oft je Hauptfigur):\n${strLines}\n${inheritNote}` : '';

  // Zielzelle: bei gesetztem Strang sind „bereits vorhandene Beats" die der Zelle
  // (Akt × Strang); sonst akt-weit.
  const existing = (beats || [])
    .filter(b => acts.find(a => a.id === b.act_id && a.name === aktName))
    .filter(b => !threadInfo || (b.thread_id ?? null) === (threadInfo.id ?? null))
    .map(b => `- ${b.titel}`);
  const existSeg = existing.length
    ? `\nBEREITS VORHANDENE BEATS ${threadInfo ? 'IN DIESER ZELLE' : 'IN DIESEM AKT'} (NICHT wiederholen):\n${existing.join('\n')}\n`
    : '';

  const threadGoal = threadInfo
    ? `\nZIEL-STRANG: "${threadInfo.name}"${threadInfo.figur ? ` (Hauptfigur: ${threadInfo.figur})` : ''}${threadInfo.kapitel ? ` (Kapitel: ${threadInfo.kapitel})` : ''}\nDie Beats sollen GENAU diesen Erzählstrang vorantreiben${threadInfo.figur ? ` und ${threadInfo.figur} ins Zentrum stellen` : ''}${threadInfo.kapitel ? ` (sie spielen im Kapitel „${threadInfo.kapitel}", sofern nicht anders nötig)` : ''} — nicht die anderen Stränge.\n`
    : '';

  return `Die Autorin skizziert die Handlung ihres Buches als Beat-Board und braucht 3–7 prägnante neue Beats (Handlungspunkte) für den Akt "${aktName}"${threadInfo ? ` im Strang "${threadInfo.name}"` : ''}.

AKTUELLES BOARD:
${_boardOutline(acts, beats, _threadInfoMap(threads))}
${ctxSeg}${figSeg}${wfSeg}${kapSeg}${orteSeg}${zeitSeg}${strSeg}${threadGoal}${existSeg}
ZIEL-AKT: "${aktName}"

Liefere 3–7 konkrete, voneinander unterscheidbare Beat-Vorschläge für diesen Akt${threadInfo ? ' + Strang' : ''}. Jeder Beat:
- 3–10 Wörter im Label (kurz, dramaturgisch konkret: Wendepunkt, Konflikt, Entscheidung, Enthüllung — kein vager Themen-Begriff)
- Knappe Begründung (1 Satz), warum der Beat an dieser Stelle die Handlung trägt und zum Ensemble passt
- Baut auf den vorhandenen Beats auf und treibt die Spannungskurve voran
- Keine Wiederholung bestehender Beats
- Keine ausformulierte Prosa — nur die strukturelle Idee

Antworte mit diesem JSON-Schema:
{
  "vorschlaege": [
    { "label": "kurzer Beat", "begruendung": "1 Satz" }
  ]
}`;
}

export const SCHEMA_PLOT_BRAINSTORM = _obj({
  vorschlaege: {
    type: 'array',
    items: _obj({ label: _str, begruendung: _str }),
  },
});

// ── Consistency-Check ─────────────────────────────────────────────────────────
// Prüft den geplanten Plot gegen die Buchrealität: extrahierte Szenen + Kapitel +
// Figuren. Findet Brüche, Lücken und „geplant vs. schon geschrieben"-Drift.

export function buildPlotConsistencyPrompt(acts, beats, kapitel = [], szenen = [], figuren = [], buchKontext = '', werkstattFiguren = [], threads = [], orte = [], zeitstrahl = [], kontinuitaet = []) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const kapLines = _kapitelLines(kapitel);
  const kapSeg = kapLines ? `\nKAPITEL DES BUCHS (chronologisch):\n${kapLines}\n` : '';
  const szLines = _szenenLines(szenen);
  const szSeg = szLines
    ? `\nIM BUCH VORHANDENE SZENEN (aus der Analyse, = „Buchrealität"):\n${szLines}\n`
    : '\nHINWEIS: Es liegen noch keine analysierten Szenen vor (Komplettanalyse evtl. nicht gelaufen). Prüfe den Plot dann primär gegen die Kapitelstruktur.\n';
  const figLines = _figurenLinesDetail(figuren);
  const figSeg = figLines ? `\nFIGUREN-ENSEMBLE:\n${figLines}\n` : '';
  const orteLines = _orteLines(orte);
  const orteSeg = orteLines ? `\nSCHAUPLÄTZE (Orte des Buchs):\n${orteLines}\n` : '';
  const zeitLines = _zeitstrahlLines(zeitstrahl);
  const zeitSeg = zeitLines ? `\nZEITSTRAHL (chronologische Ereignisse der Figuren, = Buchrealität):\n${zeitLines}\n` : '';
  const kontiLines = _kontinuitaetLines(kontinuitaet);
  const kontiSeg = kontiLines ? `\nBEKANNTE KONTINUITÄTS-BEFUNDE (offen, aus dem letzten Continuity-Check — beziehe sie ein, dopple sie aber nicht):\n${kontiLines}\n` : '';
  const wfLines = _werkstattFigurenLines(werkstattFiguren);
  const wfSeg = wfLines ? `\nFIGUREN-WERKSTATT (geplante/in Entwicklung befindliche Figuren — Beats dürfen sie referenzieren, ohne dass sie schon im Manuskript stehen müssen):\n${wfLines}\n` : '';
  const strLines = _straengeLines(threads);
  const inheritNote = _hasThreadInheritance(threads)
    ? '\nVERERBUNG: Ein Beat in einem Strang beteiligt IMPLIZIT dessen Hauptfigur; hat er kein eigenes Kapitel, gilt das Kapitel des Strangs (im Board als „(vom Strang)" markiert). Beanstande einen Beat NICHT als „Figur fehlt"/„Kapitel fehlt", wenn der Strang sie liefert.\n'
    : '';
  const strSeg = strLines ? `\nHANDLUNGSSTRÄNGE (Swimlanes — parallele Erzähllinien, oft je Hauptfigur; im Board hinter den Beats als {Strang: …} annotiert):\n${strLines}\n${inheritNote}` : '';
  const hybridNote = _hasOwnActs(acts)
    ? '\nHYBRID-AKTE: Manche Stränge haben eine EIGENE Aktstruktur (im Board als „eigener Akt von Strang …" gekennzeichnet), andere teilen sich die geteilten Akte. Ein Strang mit eigenen Akten plant absichtlich unabhängig — beanstande NICHT, dass er die geteilten Akte „überspringt". Prüfe seinen dramaturgischen Bogen INNERHALB seiner eigenen Akte.\n'
    : '';
  // Zeitstrahl-spezifischer Prüfpunkt nur, wenn ein Figuren-Zeitstrahl vorliegt.
  const zeitChecks = zeitLines
    ? `
- Chronologie gegen Zeitstrahl: Widerspricht die Beat-Reihenfolge der zeitlichen Abfolge der Figuren-Ereignisse (Vorgriffe, Rückblenden ohne Kennzeichnung, unmögliche Gleichzeitigkeit)?`
    : '';
  // Strang-spezifische Prüfpunkte nur ergänzen, wenn überhaupt Stränge existieren.
  const strChecks = strLines
    ? `
- Pro Strang ein vollständiger Bogen: Hat jeder Handlungsstrang (besonders je Hauptfigur) Setup, Eskalation und Auflösung — oder bricht eine Erzähllinie ohne Abschluss ab?
- Strang-Balance: Wird ein Strang über lange Strecken (Akte) gar nicht bedient, während ein anderer dominiert? POV-/Aufmerksamkeits-Lücken benennen.
- Verweben: Treffen/kreuzen sich die Stränge an sinnvollen Stellen, oder laufen sie beziehungslos nebeneinander her?`
    : '';

  return `Du prüfst die GEPLANTE Handlung (Beat-Board) der Autorin auf Stimmigkeit — in sich und gegen die tatsächliche Buchrealität (Kapitel + analysierte Szenen). Sei schonungslos, aber konstruktiv.

GEPLANTES BEAT-BOARD:
${_boardOutline(acts, beats, _threadInfoMap(threads))}
${ctxSeg}${kapSeg}${szSeg}${figSeg}${wfSeg}${orteSeg}${zeitSeg}${kontiSeg}${strSeg}${hybridNote}
Status-Legende der Beats: geplant (noch nicht geschrieben) · Entwurf (in Arbeit) · im Buch (laut Plan schon geschrieben) · verworfen (ausgemustert).

Prüfe auf:
- Beats mit Status "im Buch", für die sich in den Szenen/Kapiteln KEINE Entsprechung finden lässt (Plan behauptet etwas, das nicht im Buch steht)
- Beats, die laut Szenen offenkundig schon geschrieben sind, aber noch auf "geplant" stehen (Status nachziehen)
- Chronologie-Brüche: die Reihenfolge der Beats (Akte → Beats) passt nicht zur Reihenfolge der verknüpften Kapitel
- Logische Brüche / Widersprüche innerhalb der Handlung (Kausalität, Motivation, Figurenlogik)
- Lücken: Kapitel mit Szenen, für die es keinen Beat gibt — oder dramaturgische Leerstellen (fehlender Wendepunkt, fehlende Auflösung eines Konflikts)
- Verworfene Beats, deren Inhalt trotzdem noch im Buch auftaucht${zeitChecks}${strChecks}

Schwere-Skala:
- "kritisch": logischer Bruch oder Plan-Realität-Widerspruch, der die Handlung zerstört
- "stark":   deutlicher Widerspruch, sollte aufgelöst werden
- "mittel":  Spannung/Drift zwischen Plan und Buch, Klärung empfohlen
- "schwach": leichte Reibung, Hinweis genügt
- "niedrig": kosmetisch / Status-Pflege

Nenne im Feld "beat" den Titel des betroffenen Beats — oder "—" für übergreifende Befunde (Lücken, fehlende Wendepunkte). Wenn alles stimmig ist, gib ein leeres "konflikte"-Array zurück und schreibe ein bestätigendes Fazit.

Priorisiere nach Schwere und melde die wichtigsten Befunde (höchstens ~25) — keine redundanten oder rein kosmetischen Dopplungen. Halte "problem" und "vorschlag" knapp (je 1–2 Sätze).

Antworte mit diesem JSON-Schema:
{
  "konflikte": [
    { "beat": "Titel des Beats oder —", "schwere": "kritisch|stark|mittel|schwach|niedrig", "problem": "kurze Beschreibung", "vorschlag": "konkreter Lösungsvorschlag" }
  ],
  "fazit": "1–3 Sätze Gesamteinschätzung"
}`;
}

export const SCHEMA_PLOT_CONSISTENCY = _obj({
  konflikte: {
    type: 'array',
    items: _obj({
      beat: _str,
      schwere: { type: 'string', enum: SEVERITY_ENUM },
      problem: _str,
      vorschlag: _str,
    }),
  },
  fazit: _str,
});

export const PLOT_SEVERITY_ENUM = SEVERITY_ENUM;
