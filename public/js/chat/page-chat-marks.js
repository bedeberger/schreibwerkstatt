// Seiten-Chat: Zustand der Vorschläge gegen die aktuelle Seite (veraltet /
// rückgängig-fähig / Wort-Diff), Inline-Marken der Leseansicht und das
// Hinzeigen auf eine Stelle (Hover/Klick auf einen Vorschlag). In `chatCard`
// gespreadet (über chat.js); `this` ist die Karte.

import { countInHtml } from '../utils.js';
import { stripLektoratMarks } from '../editor/shared/html-clean.js';
import { collectMatches, createHighlightPair } from '../editor/shared/text-find.js';
import { wordDiff } from './word-diff.js';

// CSS-Custom-Highlight (kein DOM-Eingriff — landet nie im gespeicherten HTML).
// Nur der „current"-Name wird gemalt; Stil in css/editor/notebook/lektorat.css.
const locateHighlight = createHighlightPair('chat-proposal-match', 'chat-proposal-focus');

const VIEW_SEL = '.page-content-view:not(.page-content-view--editing):not(.revision-viewer__content)';

/** HTML, gegen das Vorschläge geprüft werden: im Notebook-Edit-Modus der
 *  Live-Editor (dort landet ein Übernehmen), sonst der gespeicherte Stand. */
export function pageChatHtml(root) {
  if (root?.editMode && !root.focusActive) {
    const el = root._getEditEl?.();
    if (el) return stripLektoratMarks(el.innerHTML);
  }
  return root?.originalHtml || '';
}

/** Offene Vorschläge der letzten Assistant-Nachricht als Inline-Marken.
 *  Nur die letzte: sonst mischen sich frische Vorschläge mit denen aus der
 *  Historie; ältere bleiben in den Chat-Bubbles sichtbar. */
export function computeChatMarks(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  let last = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') { last = i; break; }
  }
  if (last === -1 || !Array.isArray(msgs[last].vorschlaege)) return [];
  const out = [];
  msgs[last].vorschlaege.forEach((v, vIdx) => {
    if (v._applied || v._discarded || v._stale || !v.original || !v.ersatz) return;
    out.push({ msgIdx: last, vIdx, original: v.original, ersatz: v.ersatz });
  });
  return out;
}

export const pageChatMarksMethods = {

  // Abgeleitete Flags pro Vorschlag. Läuft nach jedem Laden der Session, nach
  // jedem Übernehmen/Rückgängig/Verwerfen und nach Job-Ende:
  //   _applied/_discarded — Spiegel der persistierten Felder (applied / status)
  //   _stale    — offen, aber die Originalstelle steht nicht mehr in der Seite
  //   _undoable — übernommen, und der Ersatztext steht noch genau einmal da
  //   _diff     — Wort-Diff original → ersatz (null = zu gross, zwei Blöcke)
  _refreshVorschlagStates() {
    const html = pageChatHtml(window.__app);
    for (const m of this.chatMessages) {
      if (!Array.isArray(m.vorschlaege)) continue;
      for (const v of m.vorschlaege) {
        v._applied = !!v.applied;
        v._discarded = !v._applied && v.status === 'discarded';
        v._stale = !!html && !v._applied && !v._discarded && countInHtml(html, v.original) === 0;
        v._undoable = !!html && v._applied && countInHtml(html, v.ersatz) === 1;
        if (v._diff === undefined) v._diff = wordDiff(v.original, v.ersatz);
      }
    }
    this._publishChatMarks();
  },

  _publishChatMarks() {
    const store = window.Alpine?.store('pageChat');
    if (store) store.proposals = computeChatMarks(this.chatMessages);
    window.__app?.updatePageView?.();
  },

  _clearChatMarks() {
    const store = window.Alpine?.store('pageChat');
    if (store) store.proposals = [];
    locateHighlight.clear();
  },

  // Hover über einen Vorschlag → Stelle im Text hervorheben; `scroll` (Klick)
  // zusätzlich hinscrollen. Sucht im aktiven Container (Live-Editor bzw.
  // Leseansicht) den Originaltext — bei übernommenen Vorschlägen den Ersatz.
  locateChatVorschlag(v, { scroll = false } = {}) {
    const root = window.__app;
    const container = root?.editMode
      ? (root.focusActive ? null : root._getEditEl?.())
      : document.querySelector(VIEW_SEL);
    const needle = v?._applied ? v.ersatz : v?.original;
    if (!container || !needle) { locateHighlight.clear(); return; }
    const matches = collectMatches(container, needle, { caseSensitive: true });
    if (!matches.length) { locateHighlight.clear(); return; }
    locateHighlight.paint(matches.slice(0, 1), 0);
    if (scroll) matches[0].startNode?.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  },

  unlocateChatVorschlag() { locateHighlight.clear(); },
};
