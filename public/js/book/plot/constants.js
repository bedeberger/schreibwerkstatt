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

// Beat-Titel normalisieren für den Abgleich Befund ↔ Beat (gleiche Vertragsbasis
// wie der Consistency-Job, der den Beat nur per Titel-String referenziert). EINE
// Quelle für derived.js (Index/Match) und ai.js (Sprung) — divergierte sonst still.
export const normTitle = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Beat-Verankerung: Soll (status) gegen Ist (Fundstellen im Text) klassifizieren.
// Reine Funktion (kein Alpine-Kontext) → unit-testbar. Nur „im Buch"-Beats werden
// überhaupt verankert (siehe routes/jobs/beat-anchor.js) — geplante/verworfene
// haben kein Soll „im Text" und tragen darum nie ein Badge. Werte:
//   'confirmed'  im_buch + Fundstellen  → passt (grün)
//   'drift'      im_buch + 0 Fundstellen → Warnung: als eingearbeitet markiert,
//                aber im Text nicht auffindbar (rot)
//   'none'       geplant / verworfen    → kein Badge
// occCount = plot_beat_occurrences-Zahl des Beats (0 wenn nie/nicht verankert).
export function classifyBeatAnchor(status, occCount, verworfen) {
  if (verworfen || status !== 'im_buch') return 'none';
  return (occCount || 0) > 0 ? 'confirmed' : 'drift';
}
