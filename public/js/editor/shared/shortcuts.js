// Inline-Formatting-Shortcuts mit Whitelist. Beide Editoren verwenden dieselbe
// Bindings-Funktion; die `allowedCommands`-Liste entscheidet, welche Commands
// im jeweiligen Editor wirken.
//
// MVP-Whitelist (Focus + Normal):  ['bold', 'italic', 'underline']
//                                  → Cmd/Ctrl+B / +I / +U
// Andere Shortcuts werden bewusst nicht abgefangen — Browser-Default greift
// (z.B. Cmd+Z für Undo, Cmd+S wird vom Editor-Karten-Handler verarbeitet).

const COMMAND_KEY = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
};

// Liefert true, wenn ein KeyboardEvent dem Inline-Format-Pattern entspricht
// (Cmd auf Mac, Ctrl sonst) und der Buchstabe in der Whitelist ist. Reine
// Funktion ohne DOM-Zugriff, damit Whitelist-Verhalten isoliert testbar
// bleibt.
export function matchInlineCommand(event, allowedCommands) {
  if (!event) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return null;
  if (event.altKey || event.shiftKey) return null;
  const key = (event.key || '').toLowerCase();
  for (const cmd of allowedCommands) {
    if (COMMAND_KEY[cmd] === key) return cmd;
  }
  return null;
}

// Hängt einen Keydown-Listener an `container`, der bei passendem Shortcut
// `document.execCommand(cmd, false, null)` ausführt und das Event
// preventDefault'et. Liefert die Teardown-Funktion zurück.
//
// `execCommand` ist deprecated, aber für `bold`/`italic`/`underline` weiterhin
// in allen aktuellen Browsern unterstützt und der pragmatischste Weg, ohne
// einen Rich-Text-Editor-Stack einzuziehen. Sollte eine spätere Phase mehr
// Commands brauchen, lohnt sich der Umstieg auf ein Beziehungs-Modell mit
// Selection-Range-Mutation.
export function bindInlineFormattingShortcuts(container, { allowedCommands } = {}) {
  if (!container) return () => {};
  const allow = Array.isArray(allowedCommands) ? allowedCommands : ['bold', 'italic', 'underline'];
  const handler = (event) => {
    const cmd = matchInlineCommand(event, allow);
    if (!cmd) return;
    event.preventDefault();
    try { document.execCommand(cmd, false, null); } catch {}
  };
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}
