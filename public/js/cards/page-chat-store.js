// Alpine.store('pageChat') — offene Seiten-Chat-Vorschläge als Inline-Marken der
// Leseansicht. Schreiber ist ausschliesslich der Seiten-Chat
// (chat/page-chat-marks.js#_publishChatMarks), Leser die Seitenansicht
// (book/page-view.js#updatePageView, in den Root gespreadet).
//
// Im Store statt in der Karte: die Vorschläge leben in `chatCard`
// (`chatMessages`), gerendert werden sie aber vom Root — und der Root kennt die
// Sub-Komponente nicht (`this.chatMessages` existiert dort nicht). Ein
// Root-Proxy wäre die verbotene zweite Wahrheit (docs/state-modell.md, Ebene 3).
//
// Feld-Bedeutung:
//   proposals — [{ msgIdx, vIdx, original, ersatz }] der letzten Assistant-
//               Nachricht, nur offene (nicht übernommen/verworfen/veraltet).
//               Immer reassignen, nie pushen.

export function registerPageChatStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('pageChat', {
    proposals: [],
  });
}
