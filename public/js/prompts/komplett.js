// Komplett-Pipeline-Prompts (Facade): Vollextraktion (Figuren/Orte/Fakten/Szenen/
// Lebensereignisse), Konsolidierungen (Figuren-Basis, Soziogramm, Orte, Songs, Zeitstrahl),
// Kontinuitätsprüfung. Interne Aufteilung in das gleichnamige komplett/-Subfolder:
//   schema-strings  – geteilte Schema-Text- und Regel-Bausteine
//   figuren         – Figuren-Konsolidierung, Beziehungen, Soziogramm
//   extraktion      – Vollextraktion-Schemas + System-/User-Prompts pro Pass
//   konsolidierung  – Zeitstrahl/Songs/Orte-Konsolidierung
//   kontinuitaet    – Kontinuitätsprüfung (Disambig, Fakten, Check, Single-Pass)
//   schemas         – dynamische + statische JSON-Schemas (_rebuildKomplettSchemas)

export { figurenBasisRules } from './komplett/schema-strings.js';

export {
  buildFiguresBasisConsolidationPrompt,
  buildKapiteluebergreifendeBeziehungenPrompt,
  buildFigurenBeziehungenExtraktionPrompt,
  buildSoziogrammConsolidationPrompt,
} from './komplett/figuren.js';

export {
  buildSystemKomplett,
  buildSystemKomplettFiguren,
  buildSystemKomplettFigurenStamm,
  buildSystemKomplettOrteSzenen,
  buildSystemKomplettFakten,
  buildExtraktionKomplettChapterPrompt,
  buildExtraktionFigurenPassPrompt,
  buildExtraktionFigurenStammPrompt,
  buildExtraktionOrtePassPrompt,
  buildExtraktionFaktenPassPrompt,
  buildFigurenStammGapPrompt,
  buildOrteGapPrompt,
} from './komplett/extraktion.js';

export {
  buildZeitstrahlConsolidationPrompt,
  buildSongsConsolidationPrompt,
  buildLocationsConsolidationPrompt,
} from './komplett/konsolidierung.js';

export {
  buildKontinuitaetChapterFactsPrompt,
  buildKontinuitaetCheckPrompt,
  buildKontinuitaetVerifyPrompt,
  buildKontinuitaetSinglePassPrompt,
} from './komplett/kontinuitaet.js';

export {
  _rebuildKomplettSchemas,
  SCHEMA_KOMPLETT_EXTRAKTION,
  SCHEMA_KOMPLETT_FIGUREN_PASS,
  SCHEMA_KOMPLETT_FIGUREN_STAMM,
  SCHEMA_KOMPLETT_ORTE_PASS,
  SCHEMA_KOMPLETT_FAKTEN_PASS,
  SCHEMA_FIGUREN_KONSOL,
  SCHEMA_BEZIEHUNGEN,
  SCHEMA_ORTE_KONSOL,
  SCHEMA_SONGS_KONSOL,
  SCHEMA_SOZIOGRAMM_KONSOL,
  SCHEMA_ZEITSTRAHL,
  SCHEMA_KONTINUITAET_FAKTEN,
  SCHEMA_KONTINUITAET_PROBLEME,
  SCHEMA_KONTINUITAET_VERIFY,
} from './komplett/schemas.js';
