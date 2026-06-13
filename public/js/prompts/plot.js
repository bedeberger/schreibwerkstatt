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
function _boardOutline(acts, beats) {
  return (acts || []).map(act => {
    const own = (beats || [])
      .filter(b => b.act_id === act.id)
      .map(b => {
        const st = STATUS_LABEL[b.status] || b.status;
        const kap = b.chapter_name ? ` → Kapitel: ${b.chapter_name}` : '';
        return `  - ${b.titel} [${st}]${kap}`;
      });
    return `AKT: ${act.name}\n${own.length ? own.join('\n') : '  (noch keine Beats)'}`;
  }).join('\n\n');
}

function _figurenLines(figuren) {
  return (figuren || []).slice(0, 60)
    .map(f => `- ${f.name}${f.typ ? ` [${f.typ}]` : ''}`)
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
  return (kapitel || []).slice(0, 120)
    .map((k, i) => `${i + 1}. ${k}`)
    .join('\n');
}

// Szenen als „Buchrealität": Titel — Kapitel — beteiligte Figuren.
function _szenenLines(szenen) {
  return (szenen || []).slice(0, 120)
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

export function buildPlotBrainstormPrompt(aktName, acts, beats, buchKontext, figuren = [], kapitel = [], werkstattFiguren = []) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const figLines = _figurenLines(figuren);
  const figSeg = figLines ? `\nFIGUREN-ENSEMBLE:\n${figLines}\n` : '';
  const wfLines = _werkstattFigurenLines(werkstattFiguren);
  const wfSeg = wfLines ? `\nFIGUREN-WERKSTATT (in Entwicklung, evtl. noch nicht im Manuskript — als Beat-Figuren nutzbar):\n${wfLines}\n` : '';
  const kapLines = _kapitelLines(kapitel);
  const kapSeg = kapLines ? `\nVORHANDENE KAPITEL (chronologisch):\n${kapLines}\n` : '';
  const existing = (beats || [])
    .filter(b => acts.find(a => a.id === b.act_id && a.name === aktName))
    .map(b => `- ${b.titel}`);
  const existSeg = existing.length
    ? `\nBEREITS VORHANDENE BEATS IN DIESEM AKT (NICHT wiederholen):\n${existing.join('\n')}\n`
    : '';

  return `Die Autorin skizziert die Handlung ihres Buches als Beat-Board und braucht 3–7 prägnante neue Beats (Handlungspunkte) für den Akt "${aktName}".

AKTUELLES BOARD:
${_boardOutline(acts, beats)}
${ctxSeg}${figSeg}${wfSeg}${kapSeg}${existSeg}
ZIEL-AKT: "${aktName}"

Liefere 3–7 konkrete, voneinander unterscheidbare Beat-Vorschläge für diesen Akt. Jeder Beat:
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

export function buildPlotConsistencyPrompt(acts, beats, kapitel = [], szenen = [], figuren = [], buchKontext = '', werkstattFiguren = []) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const kapLines = _kapitelLines(kapitel);
  const kapSeg = kapLines ? `\nKAPITEL DES BUCHS (chronologisch):\n${kapLines}\n` : '';
  const szLines = _szenenLines(szenen);
  const szSeg = szLines
    ? `\nIM BUCH VORHANDENE SZENEN (aus der Analyse, = „Buchrealität"):\n${szLines}\n`
    : '\nHINWEIS: Es liegen noch keine analysierten Szenen vor (Komplettanalyse evtl. nicht gelaufen). Prüfe den Plot dann primär gegen die Kapitelstruktur.\n';
  const figLines = _figurenLines(figuren);
  const figSeg = figLines ? `\nFIGUREN-ENSEMBLE:\n${figLines}\n` : '';
  const wfLines = _werkstattFigurenLines(werkstattFiguren);
  const wfSeg = wfLines ? `\nFIGUREN-WERKSTATT (geplante/in Entwicklung befindliche Figuren — Beats dürfen sie referenzieren, ohne dass sie schon im Manuskript stehen müssen):\n${wfLines}\n` : '';

  return `Du prüfst die GEPLANTE Handlung (Beat-Board) der Autorin auf Stimmigkeit — in sich und gegen die tatsächliche Buchrealität (Kapitel + analysierte Szenen). Sei schonungslos, aber konstruktiv.

GEPLANTES BEAT-BOARD:
${_boardOutline(acts, beats)}
${ctxSeg}${kapSeg}${szSeg}${figSeg}${wfSeg}
Status-Legende der Beats: geplant (noch nicht geschrieben) · Entwurf (in Arbeit) · im Buch (laut Plan schon geschrieben) · verworfen (ausgemustert).

Prüfe auf:
- Beats mit Status "im Buch", für die sich in den Szenen/Kapiteln KEINE Entsprechung finden lässt (Plan behauptet etwas, das nicht im Buch steht)
- Beats, die laut Szenen offenkundig schon geschrieben sind, aber noch auf "geplant" stehen (Status nachziehen)
- Chronologie-Brüche: die Reihenfolge der Beats (Akte → Beats) passt nicht zur Reihenfolge der verknüpften Kapitel
- Logische Brüche / Widersprüche innerhalb der Handlung (Kausalität, Motivation, Figurenlogik)
- Lücken: Kapitel mit Szenen, für die es keinen Beat gibt — oder dramaturgische Leerstellen (fehlender Wendepunkt, fehlende Auflösung eines Konflikts)
- Verworfene Beats, deren Inhalt trotzdem noch im Buch auftaucht

Schwere-Skala:
- "kritisch": logischer Bruch oder Plan-Realität-Widerspruch, der die Handlung zerstört
- "stark":   deutlicher Widerspruch, sollte aufgelöst werden
- "mittel":  Spannung/Drift zwischen Plan und Buch, Klärung empfohlen
- "schwach": leichte Reibung, Hinweis genügt
- "niedrig": kosmetisch / Status-Pflege

Nenne im Feld "beat" den Titel des betroffenen Beats — oder "—" für übergreifende Befunde (Lücken, fehlende Wendepunkte). Wenn alles stimmig ist, gib ein leeres "konflikte"-Array zurück und schreibe ein bestätigendes Fazit.

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
