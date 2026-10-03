'use strict';
// Recherche-Board im Buch-Chat: dieselben Lese-Handler wie im Recherche-Chat
// (routes/jobs/research-chat-tools.js), damit Filter, Kappung und Ausgabeform
// nicht zwischen beiden Chats driften. Read-only — der Buch-Chat legt keine
// Fundstuecke an und sucht nicht im Web.

const { TOOLS: RESEARCH_TOOLS } = require('../research-chat-tools');

function tool_list_research_items(input, ctx) {
  return RESEARCH_TOOLS.list_research_items(input, ctx);
}

// `researchPassages: false`: der Buch-Chat hat kein search_research_passages —
// der Kappungs-Hinweis eines langen PDFs darf es nicht empfehlen.
function tool_read_research_item(input, ctx) {
  return RESEARCH_TOOLS.read_research_item(input, { ...ctx, researchPassages: false });
}

module.exports = { tool_list_research_items, tool_read_research_item };
