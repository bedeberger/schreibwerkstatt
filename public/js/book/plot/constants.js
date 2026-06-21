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
