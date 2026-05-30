'use strict';
// Facade fuer Buch-Chat-Tools. Buendelt Submodule zu einem TOOLS-Dispatcher.
// Jede Tool-Funktion nimmt (input, ctx) und gibt ein JSON-serialisierbares Objekt zurueck.
// ctx = { bookId, userEmail, userToken, jobSignal, logger }
// Uebersicht aller Tools + Vertrag: docs/buchchat-tools.md

const { _truncateResult } = require('./shared');
const catalog = require('./tools-catalog');
const timeline = require('./tools-timeline');
const text = require('./tools-text');
const figures = require('./tools-figures');
const analysis = require('./tools-analysis');
const revisions = require('./tools-revisions');
const werkstatt = require('./tools-werkstatt');
const { validateFinalAnswerCitations } = require('./citations');

const TOOLS = {
  list_chapters:          catalog.tool_list_chapters,
  list_figures:           catalog.tool_list_figures,
  list_revisions:         catalog.tool_list_revisions,
  list_ideen:             catalog.tool_list_ideen,
  list_locations:         catalog.tool_list_locations,
  get_location_profile:   catalog.tool_get_location_profile,
  list_scenes:            catalog.tool_list_scenes,
  list_songs:             catalog.tool_list_songs,
  list_world_facts:       catalog.tool_list_world_facts,
  get_book_settings:      catalog.tool_get_book_settings,

  list_continuity_issues: timeline.tool_list_continuity_issues,
  get_timeline:           timeline.tool_get_timeline,

  count_pronouns:         figures.tool_count_pronouns,
  get_figure_mentions:    figures.tool_get_figure_mentions,
  get_figure_relations:   figures.tool_get_figure_relations,
  get_figure_profile:     figures.tool_get_figure_profile,

  search_passages:        text.tool_search_passages,
  get_pages:              text.tool_get_pages,
  get_chapter_text:       text.tool_get_chapter_text,
  quote_passage:          text.tool_quote_passage,
  quote_match:            text.tool_quote_match,
  get_dialogue:           text.tool_get_dialogue,
  find_first_last_mention: text.tool_find_first_last_mention,

  get_reviews:            analysis.tool_get_reviews,
  get_lektorat_hotspots:  analysis.tool_get_lektorat_hotspots,
  get_lektorat_findings:  analysis.tool_get_lektorat_findings,
  get_stil_metrics:       analysis.tool_get_stil_metrics,
  find_repetitions:       analysis.tool_find_repetitions,

  diff_page_revisions:    revisions.tool_diff_page_revisions,

  list_werkstatt_drafts:  werkstatt.tool_list_werkstatt_drafts,
  get_werkstatt_draft:    werkstatt.tool_get_werkstatt_draft,
};

async function executeTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  return _truncateResult(result);
}

module.exports = { executeTool, TOOLS, validateFinalAnswerCitations };
