'use strict';
// Verfügbarkeit des Recherche-Chats für einen User — EINE Quelle für drei Stellen:
//   /config                       → `researchChat.enabled` (Panel sichtbar ja/nein)
//   POST /jobs/research-chat      → Vorab-Prüfung, BEVOR die User-Nachricht gespeichert wird
//   runResearchChatJob#validate   → nochmals beim Lauf (Setting/Provider kann sich
//                                   zwischen POST und Queue-Start ändern)
//
// Der Chat ist Claude-only (Web-Suche gibt es nur über Anthropics serverseitiges
// `web_search`), braucht einen API-Key und hat einen Admin-Kill-Switch.
// Siehe docs/recherche-chat.md („Claude-only — warum").

const appSettings = require('./app-settings');
const { resolveProvider } = require('./ai');
const { aiApiKey } = require('./ai/profile');

/**
 * @param {string|null} userEmail
 * @returns {null | { status: number, error_code: string, i18nKey: string }}
 *   null = verfügbar. Sonst der Grund (HTTP-Status + Client-Code + Job-Fehler-Key).
 */
function researchChatGate(userEmail) {
  if (appSettings.get('research_chat.enabled') === false) {
    return { status: 403, error_code: 'RESEARCH_CHAT_DISABLED', i18nKey: 'job.error.researchChatDisabled' };
  }
  if (resolveProvider({ userEmail }) !== 'claude') {
    return { status: 400, error_code: 'RESEARCH_CHAT_CLAUDE_ONLY', i18nKey: 'job.error.researchChatClaudeOnly' };
  }
  // Key des Users (eigener Zugang / Profil), sonst der Instanz-Key — dieselbe
  // Aufloesung, die der Call selbst nimmt.
  if (!String(aiApiKey('claude', { userEmail }) || '').trim()) {
    return { status: 403, error_code: 'RESEARCH_CHAT_DISABLED', i18nKey: 'job.error.researchChatDisabled' };
  }
  return null;
}

module.exports = { researchChatGate };
