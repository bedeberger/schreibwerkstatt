// Plot-Werkstatt: abgeleitete (memoisierte) Read-Methoden — Facade über die
// thematischen Sub-Module unter derived/. Reine Compute aus Board-State, keine
// Server-Mutationen. Alle Methoden landen auf demselben Card-`this` (gemeinsamer
// _memo/_memos-Speicher), Cross-Referenzen laufen über `this.` modulübergreifend.
//
//   - board.js    — Beats/Stats, Figuren-Picker, Stränge/Swimlanes, Hybrid-Akte,
//                    Grid-Render-Plan, Live-Vererbung, Akt-Farben
//   - tension.js  — Spannungsbogen (global + pro Strang) + Figuren-Fokus
//   - coverage.js — Verworfen-Collapse, Konsistenz-Befund↔Beat, Kapitel-/Figuren-
//                    Coverage, Volltext-/Kapitel-/Figur-Filter

import { boardMethods } from './derived/board.js';
import { tensionMethods } from './derived/tension.js';
import { coverageMethods } from './derived/coverage.js';

export const derivedMethods = {
  ...boardMethods,
  ...tensionMethods,
  ...coverageMethods,
};
