// Gold-Set für die Lektorat-Output-Qualitäts-Eval (manuell via `npm run eval:lektorat`).
//
// Zweck: eine kleine, kuratierte Stichprobe, gegen die sich Prompt-Änderungen
// EMPIRISCH messen lassen, statt nach Gefühl zu tunen. Zwei Metriken pro Fall:
//
//   1. RECALL auf `mustCatch` – klar gepflanzte, objektive Fehler (Rechtschreibung,
//      Grammatik/Komma, Dialogformat), die das Modell finden MUSS. Ein Regress im
//      Prompt, der solche Fehler übersieht, senkt den Recall sofort messbar.
//   2. FALSE-POSITIVES auf `cleanSpans` – vollständig KORREKTE (Schweizer) Sätze,
//      die das Modell NICHT anstreichen darf. ss statt ß, Helvetismen und saubere
//      Prosa sind hier bewusst als Fallen gesetzt (Anti-Pedanterie-Kontrolle).
//
// Locale-Annahme: de-CH (Default). `mustCatch.needle` und `cleanSpans[]` sind
// VERBATIM-Teilstrings des jeweiligen `text` – der Scorer matcht per Substring-
// Überlappung mit finding.original (das lt. Prompt zeichengenau aus dem Text stammt).
//
// Pflege: gern erweitern (mehr Fälle = aussagekräftiger). mustCatch bewusst nur
// für ZWEIFELSFREIE Fehler – subjektive Stil-Findings gehören nicht ins Gold-Set,
// weil ihr Fehlen kein Regress ist.

export const GOLD_CASES = [
  {
    id: 'rechtschreibung-genitiv',
    text: 'Er ging zum Fluss, den er schon als Kind kannte. Warscheinlich würde er wegen dem Regen nicht lange bleiben. Trozdem stieg er ins kalte Wasser.',
    mustCatch: [
      { typ: 'rechtschreibung', needle: 'Warscheinlich' },  // → wahrscheinlich
      { typ: 'grammatik',       needle: 'wegen dem Regen' }, // → wegen des Regens (Genitiv)
      { typ: 'rechtschreibung', needle: 'Trozdem' },         // → Trotzdem
    ],
    cleanSpans: [
      'Er ging zum Fluss, den er schon als Kind kannte.',
    ],
  },
  {
    id: 'komma-dialogformat',
    text: 'Sie wusste dass er kommen würde. «Komm herein» sagte sie leise und lächelte.',
    mustCatch: [
      { typ: 'grammatik',    needle: 'wusste dass' },     // Komma vor «dass» fehlt
      { typ: 'dialogformat', needle: '«Komm herein» sagte' }, // Inquit-Komma fehlt
    ],
    cleanSpans: [],
  },
  {
    id: 'clean-swiss-keine-findings',
    text: 'Er ass sein Znüni auf der Strasse. Draussen war es kalt, und der Nebel hing tief über den Dächern. Sie grüsste ihn freundlich.',
    // Vollständig korrektes Schweizer Schriftdeutsch – hier darf NICHTS beanstandet
    // werden (ss statt ß, «Znüni»/«Strasse» sind keine Fehler, saubere Kommasetzung).
    mustCatch: [],
    cleanSpans: [
      'Er ass sein Znüni auf der Strasse.',
      'Draussen war es kalt, und der Nebel hing tief über den Dächern.',
      'Sie grüsste ihn freundlich.',
    ],
  },
];
