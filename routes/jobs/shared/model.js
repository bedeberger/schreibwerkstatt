'use strict';

// Konfigurierter Modellname für den angegebenen Provider.
function _modelName(prov) {
  if (prov === 'ollama') return process.env.OLLAMA_MODEL || 'llama3.2';
  if (prov === 'llama')  return process.env.LLAMA_MODEL  || 'llama3.2';
  return process.env.MODEL_NAME || 'claude-sonnet-4-6';
}

module.exports = { _modelName };
