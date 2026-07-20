// Motiv-Werkstatt — Facade der Fachmethoden (Themen & Motive als Konstellation).
// Re-exportiert die nach Domäne aufgeteilten Sub-Module als ein Methods-Objekt,
// das in die Sub-Komponente public/js/cards/motiv-card.js gespreadet wird.

import { lifecycleMethods } from './motiv/lifecycle.js';
import { crudMethods } from './motiv/crud.js';
import { graphMethods } from './motiv/graph.js';
import { scanMethods } from './motiv/scan.js';
import { brainstormMethods } from './motiv/brainstorm.js';

export const motivMethods = {
  ...lifecycleMethods,
  ...crudMethods,
  ...graphMethods,
  ...scanMethods,
  ...brainstormMethods,
};
