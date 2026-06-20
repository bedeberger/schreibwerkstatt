// Figuren-Werkstatt: Vorwärts-Entwicklung von Figuren als Mindmap.
// Zwei Job-Typen: Brainstorm (Sub-Ideen für einen Knoten) und Consistency
// (Konflikte gegen Buchwelt + bestehende Figuren/Orte).
//
// Severity-Vokabular für Consistency: kritisch/stark/mittel/schwach/niedrig —
// matcht .severity-tag--* in DESIGN.md (Frontend rendert diese Skala).

import { _obj, _str } from './schema-utils.js';

const SEVERITY_ENUM = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// ── Brainstorm ──────────────────────────────────────────────────────────────
// User wählt einen Mindmap-Knoten (z.B. "Steckbrief > Hintergrund") und bekommt
// 3–7 Sub-Ideen, die zur Figur und zum Buchkontext passen.

function _figurenLines(figuren) {
  return (figuren || []).slice(0, 50)
    .map(f => `- ${f.name}${f.typ ? ` [${f.typ}]` : ''}${f.beschreibung ? `: ${f.beschreibung.slice(0, 120)}` : ''}`)
    .join('\n');
}

function _orteLines(orte) {
  return (orte || []).slice(0, 50)
    .map(o => `- ${o.name}${o.typ ? ` [${o.typ}]` : ''}${o.beschreibung ? `: ${o.beschreibung.slice(0, 120)}` : ''}`)
    .join('\n');
}

// Beziehungsgeflecht des Buchs: "Anna –[Schwester]→ Tom: …". Schärft die
// Konflikt-Erkennung ("Doppelung von Rolle/Funktion") und die Abgrenzung
// gegen bereits etablierte Beziehungsmuster.
function _beziehungenLines(beziehungen) {
  return (beziehungen || []).slice(0, 60)
    .map(b => `- ${b.fromName} –[${b.typ}]→ ${b.toName}${b.beschreibung ? `: ${b.beschreibung.slice(0, 120)}` : ''}`)
    .join('\n');
}

// „Geschriebene Realität" der Quell-Figur: Szenen + Ereignisse aus dem Buch.
// Nur für Consistency relevant (Abgleich Mindmap-Plan ↔ bereits Geschriebenes);
// leer, wenn die Figur ein reiner Neu-Draft ohne Buch-Import ist.
function _auftritteSeg(auftritte) {
  if (!auftritte) return '';
  const szLines = (auftritte.szenen || []).slice(0, 40)
    .filter(s => s && typeof s.titel === 'string' && s.titel.trim())
    .map(s => `- ${s.titel.trim()}${s.wertung ? ` [${s.wertung}]` : ''}${s.kommentar ? `: ${s.kommentar.slice(0, 120)}` : ''}`);
  const evLines = (auftritte.ereignisse || []).slice(0, 40)
    .filter(e => e && typeof e.ereignis === 'string' && e.ereignis.trim())
    .map(e => `- ${e.datum_label ? `${e.datum_label}: ` : ''}${e.ereignis.trim()}${e.bedeutung ? ` (${e.bedeutung.slice(0, 120)})` : ''}`);
  if (!szLines.length && !evLines.length) return '';
  let seg = '\nSO KOMMT DIE FIGUR IM BUCH BISHER VOR (geschriebene Realität — Mindmap dagegen abgleichen):\n';
  if (szLines.length) seg += `Szenen:\n${szLines.join('\n')}\n`;
  if (evLines.length) seg += `Ereignisse:\n${evLines.join('\n')}\n`;
  return seg;
}

export function buildBrainstormPrompt(figurName, archetype, knotenPfad, mindmapJson, buchKontext, bestehendeFiguren = [], bestehendeOrte = [], existingChildren = [], beziehungen = []) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const archSeg = archetype ? ` (Archetyp: ${archetype})` : '';
  const figLines = _figurenLines(bestehendeFiguren);
  const figSeg = figLines ? `\nBESTEHENDE FIGUREN IM BUCH (zur Abgrenzung, keine Doppelung):\n${figLines}\n` : '';
  const bezLines = _beziehungenLines(beziehungen);
  const bezSeg = bezLines ? `\nBESTEHENDES BEZIEHUNGSGEFLECHT IM BUCH (etablierte Rollen/Muster nicht doppeln):\n${bezLines}\n` : '';
  const ortLines = _orteLines(bestehendeOrte);
  const ortSeg = ortLines ? `\nBESTEHENDE ORTE IM BUCH (Setting, Schauplätze):\n${ortLines}\n` : '';
  const childList = (existingChildren || []).filter(c => typeof c === 'string' && c.trim());
  const childSeg = childList.length
    ? `\nVORHANDENE SUB-KNOTEN AM ZIEL-KNOTEN (NICHT wiederholen):\n${childList.map(c => `- ${c}`).join('\n')}\n`
    : '';
  return `Du entwickelst eine Romanfigur weiter. Die Autorin arbeitet am Knoten "${knotenPfad}" einer Figuren-Mindmap und braucht 3–7 prägnante Sub-Ideen.

FIGUR: ${figurName}${archSeg}
${ctxSeg}${figSeg}${bezSeg}${ortSeg}
AKTUELLE MINDMAP (JSON):
${JSON.stringify(mindmapJson)}

ZIEL-KNOTEN: "${knotenPfad}"
${childSeg}
Liefere 3–7 konkrete, voneinander unterscheidbare Vorschläge als Sub-Ideen für den Ziel-Knoten. Jede Idee:
- 2–8 Wörter im Label (kurz, einprägsam, Mindmap-tauglich)
- Knappe Begründung (1 Satz), warum sie zur Figur und zum Buchkontext passt
- Keine Wiederholung bestehender Knoten in der Mindmap (insbesondere der oben gelisteten Sub-Knoten)
- Keine Doppelung von Eigenschaften bestehender Figuren — Abgrenzung schärft Profil
- Schauplätze, falls erwähnt, müssen zu den oben gelisteten Orten passen oder klar neu sein

Antworte mit diesem JSON-Schema:
{
  "vorschlaege": [
    { "label": "kurze Idee", "begruendung": "1 Satz" }
  ]
}`;
}

export const SCHEMA_BRAINSTORM = _obj({
  vorschlaege: {
    type: 'array',
    items: _obj({ label: _str, begruendung: _str }),
  },
});

// ── Consistency-Check ───────────────────────────────────────────────────────
// Prüft Mindmap gegen Buch-Setting (Buchtyp/Freitext aus book_settings) +
// bestehende Figuren (Name+Rolle) + Orte (Name+Typ). Findet Widersprüche,
// Lücken und Klischees. Severity-Vokabular kompatibel zu .severity-tag--*.

export function buildConsistencyPrompt(figurName, archetype, mindmapJson, buchKontext, bestehendeFiguren, bestehendeOrte, beziehungen = [], eigeneAuftritte = null) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const archSeg = archetype ? ` (Archetyp: ${archetype})` : '';
  const figLines = _figurenLines(bestehendeFiguren);
  const ortLines = _orteLines(bestehendeOrte);
  const bezLines = _beziehungenLines(beziehungen);
  const figSeg = figLines ? `\nBESTEHENDE FIGUREN IM BUCH:\n${figLines}\n` : '';
  const bezSeg = bezLines ? `\nBESTEHENDES BEZIEHUNGSGEFLECHT IM BUCH:\n${bezLines}\n` : '';
  const ortSeg = ortLines ? `\nBESTEHENDE ORTE IM BUCH:\n${ortLines}\n` : '';
  const auftritteSeg = _auftritteSeg(eigeneAuftritte);
  const auftritteCheck = auftritteSeg
    ? '\n- Widersprüche zwischen Mindmap-Plan und dem, was im Buch bereits über die Figur geschrieben steht (Szenen/Ereignisse oben)'
    : '';

  return `Du prüfst eine in Entwicklung befindliche Romanfigur auf Stimmigkeit mit der Buchwelt. Die Autorin arbeitet die Figur als Mindmap aus; deine Aufgabe ist es, Widersprüche, Lücken und Klischees zu benennen — schonungslos, aber konstruktiv.

FIGUR: ${figurName}${archSeg}
${ctxSeg}${figSeg}${bezSeg}${ortSeg}${auftritteSeg}
FIGUR-MINDMAP (JSON):
${JSON.stringify(mindmapJson)}

Prüfe auf:
- Widersprüche innerhalb der Mindmap (z.B. Hintergrund passt nicht zur Stimme)
- Konflikte mit Buchkontext (z.B. Beruf passt nicht zum Setting/Epoche)
- Konflikte mit bestehenden Figuren (z.B. Doppelung von Rolle/Funktion, namentliche Verwechslungsgefahr)
- Konflikte mit Schauplätzen (z.B. Wohnort existiert nicht)${auftritteCheck}
- Klischees und blasse Stellen, die mehr Substanz brauchen
- Fehlende Aspekte, die für eine glaubwürdige Figur unverzichtbar wären

Schwere-Skala:
- "kritisch": logischer Bruch, zerstört Glaubwürdigkeit
- "stark":   deutlicher Widerspruch, sollte aufgelöst werden
- "mittel":  Spannung zwischen Aspekten, Klärung empfohlen
- "schwach": leichte Reibung, Hinweis genügt
- "niedrig": kosmetisch, Stilfrage

Wenn alles stimmig ist, gib ein leeres "konflikte"-Array zurück und schreibe ein bestätigendes Fazit.

Antworte mit diesem JSON-Schema:
{
  "konflikte": [
    { "feld": "Name des Mindmap-Knotens oder Aspekts", "schwere": "kritisch|stark|mittel|schwach|niedrig", "problem": "kurze Beschreibung des Konflikts", "vorschlag": "konkreter Lösungsvorschlag" }
  ],
  "fazit": "1–3 Sätze Gesamteinschätzung"
}`;
}

export const SCHEMA_CONSISTENCY = _obj({
  konflikte: {
    type: 'array',
    items: _obj({
      feld: _str,
      schwere: { type: 'string', enum: SEVERITY_ENUM },
      problem: _str,
      vorschlag: _str,
    }),
  },
  fazit: _str,
});

export const WERKSTATT_SEVERITY_ENUM = SEVERITY_ENUM;
