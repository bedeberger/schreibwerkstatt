// Facade: Figuren-Werkstatt-Methoden, kombiniert nach Domäne.
// Sub-Module:
//   - mindmap.js     — jsMind-Lifecycle, Topic-i18n-Marker, Fullscreen
//   - crud.js        — Draft-CRUD, Dirty-Tracking, Reset
//   - import.js      — Import bestehender Buch-Figur als Draft
//   - jobs.js        — KI-Brainstorm + Konsistenz-Check (Job-Polling)
//   - runs.js        — KI-Lauf-Historie (persistierte Brainstorm/Consistency-Runs)
//   - context-menu.js — Rechtsklick-Menü auf Mindmap-Knoten

import { mindmapMethods, resolveTopic, resolveMindmapForDisplay } from './figur-werkstatt/mindmap.js';
import { crudMethods } from './figur-werkstatt/crud.js';
import { importMethods } from './figur-werkstatt/import.js';
import { jobsMethods } from './figur-werkstatt/jobs.js';
import { runsMethods } from './figur-werkstatt/runs.js';
import { contextMenuMethods } from './figur-werkstatt/context-menu.js';

export const figurWerkstattMethods = {
  ...crudMethods,
  ...importMethods,
  ...mindmapMethods,
  ...jobsMethods,
  ...runsMethods,
  ...contextMenuMethods,
};

export { resolveTopic, resolveMindmapForDisplay };
