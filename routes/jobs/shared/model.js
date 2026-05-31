'use strict';

const appSettings = require('../../../lib/app-settings');

// Konfigurierter Modellname für den angegebenen Provider.
function _modelName(prov) {
  if (prov === 'ollama') return appSettings.get('ai.ollama.model') || 'llama3.2';
  if (prov === 'openai-compat') return appSettings.get('ai.openai-compat.model') || 'llama3.2';
  return appSettings.get('ai.claude.model') || 'claude-sonnet-4-6';
}

module.exports = { _modelName };
