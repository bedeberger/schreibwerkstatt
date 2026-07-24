// Geteilte Konstanten der Plot-Werkstatt — von mehreren Sub-Modulen konsumiert.

// Status = binäre Realisierungsachse (Idee ↔ eingearbeitet). „Verworfen" ist ein
// eigenes Flag (beat.verworfen 0/1), keine Status-Stufe.
export const STATUSES = ['geplant', 'im_buch'];

// Segmente der board-weiten Status-Verteilungsleiste: die zwei Status + die
// Verwerfen-Achse als drittes Segment (verworfene Beats, unabhängig vom Status).
export const DIST_SEGMENTS = ['geplant', 'im_buch', 'verworfen'];

// Akt-Farbpalette: Schlüssel referenzieren die theme-aware --palette-*-Tokens
// (tokens/colors.css, geteilt mit der Figuren-Palette). In plot_acts.farbe wird
// nur der Schlüssel gespeichert; actAccent() baut daraus die CSS-Variable und
// fällt bei unbekanntem/leerem Wert auf den Karten-Akzent zurück (kein Inline-Hue).
export const ACT_PALETTE = ['blue', 'green', 'amber', 'orange', 'red', 'wine', 'pink', 'purple', 'brown', 'gray'];

// Intensität → vertikale Position im Spannungsband (10–90 %, etwas Rand oben/unten).
export const _intensityBottomPct = (i) => 10 + ((i - 1) / 4) * 80;

// Kuratierte Typen der gerichteten Beat-zu-Beat-Beziehungen (from --typ--> to).
// `typ` ist serverseitig Freitext (analog figure_relations); dies ist die im
// Frontend angebotene Auswahl. Zwei Familien: Setup/Payoff (bereitet-vor/zahlt-ein)
// + Kausalität (fuehrt-zu/motiviert/blockiert/spiegelt). Labels via i18n
// (plot.relation.type.<typ>) — hier nur die stabilen Schlüssel + Reihenfolge.
export const BEAT_REL_TYPES = ['bereitet-vor', 'zahlt-ein', 'fuehrt-zu', 'motiviert', 'blockiert', 'spiegelt'];

// Beat-Titel normalisieren für den Abgleich Befund ↔ Beat (gleiche Vertragsbasis
// wie der Consistency-Job, der den Beat nur per Titel-String referenziert). EINE
// Quelle für derived.js (Index/Match) und ai.js (Sprung) — divergierte sonst still.
export const normTitle = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Beat-Verankerung: Soll (status) gegen Ist (Fundstellen im Text) klassifizieren.
// Reine Funktion (kein Alpine-Kontext) → unit-testbar. Verankert werden „im Buch"-
// UND „geplant"-Beats (siehe routes/jobs/beat-anchor.js) — für geplante aber nur
// Fundstellen oberhalb der hohen Promotion-Schwelle (plot.anchor.promote_min_score),
// damit das Board nicht mit schwachen Treffern geflutet wird. Verworfene Beats
// werden nie verankert. Werte:
//   'confirmed'  im_buch + Fundstellen  → passt (grün)
//   'drift'      im_buch + 0 Fundstellen → Warnung: als eingearbeitet markiert,
//                aber im Text nicht auffindbar (rot)
//   'promote'    geplant + Fundstellen  → offenbar schon geschrieben; Vorschlag,
//                den Beat auf „im Buch" zu setzen (amber)
//   'none'       geplant ohne Fundstellen / verworfen → kein Badge
// occCount = plot_beat_occurrences-Zahl des Beats (0 wenn nie/nicht verankert).
export function classifyBeatAnchor(status, occCount, verworfen) {
  if (verworfen) return 'none';
  const has = (occCount || 0) > 0;
  if (status === 'im_buch') return has ? 'confirmed' : 'drift';
  if (status === 'geplant') return has ? 'promote' : 'none';
  return 'none';
}
