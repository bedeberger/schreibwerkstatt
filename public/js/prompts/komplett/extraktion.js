// Komplett-Vollextraktion (Facade): Schema- + System-Prompt-Builder und die
// User-Message-Prompts pro Pass. Interne Aufteilung in das gleichnamige extraktion/-Subfolder:
//   system   – kombiniertes/Split-Schema + gecachte System-Prompt-Builder (buildSystemKomplett*)
//   messages – User-Message-Prompts pro Pass (Vollextraktion, Gap-, Coverage-, Targeted-Pässe)
export {
  buildSystemKomplett,
  buildSystemKomplettFiguren,
  buildSystemKomplettFigurenStamm,
  buildSystemKomplettOrteSzenen,
  buildSystemKomplettFakten,
  buildSystemKomplettEvents,
} from './extraktion/system.js';

export {
  buildExtraktionKomplettChapterPrompt,
  buildExtraktionFigurenPassPrompt,
  buildExtraktionFigurenStammPrompt,
  buildExtraktionEventsPassPrompt,
  buildExtraktionOrtePassPrompt,
  buildExtraktionFaktenPassPrompt,
  buildFigurenStammGapPrompt,
  buildOrteGapPrompt,
  buildFaktenGapPrompt,
  buildSzenenGapPrompt,
  buildChunkGapPrompt,
  buildCoverageAuditPrompt,
  buildTargetedFigurenPrompt,
  buildTargetedOrtePrompt,
  buildTargetedSzenenPrompt,
  buildNameResolutionPrompt,
} from './extraktion/messages.js';
