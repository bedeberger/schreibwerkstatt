// Unit-Tests für handleEditorPastePlain (public/js/editor/shared/paste.js) —
// der Plain-Text-only-Paste-Pfad des Focus-Standalone-Editors. Im Gegensatz zu
// handleEditorPaste behält dieser Handler KEINE Whitelist-Tags und führt KEINE
// Konfig-Block-Heuristik aus: aus dem Clipboard wird ausschliesslich
// text/plain via insertText eingefügt — fremdes HTML wird verworfen.
//
// Setup analog tests/unit/paste-sanitize.test.mjs: linkedom liefert ein DOM;
// document.execCommand wird gestubt, um den Insert-Aufruf zu beobachten.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;

// execCommand-Stub: zeichnet command/value auf.
const calls = [];
document.execCommand = (command, _show, value) => {
  calls.push({ command, value });
  return true;
};

const { handleEditorPastePlain } = await import('../../public/js/editor/shared/paste.js');

// Minimales clipboardData-/Event-Stub.
function pasteEvent(data) {
  let prevented = false;
  return {
    clipboardData: { getData: (type) => data[type] || '' },
    preventDefault() { prevented = true; },
    get _prevented() { return prevented; },
  };
}

test('handleEditorPastePlain: HTML im Clipboard → nur text/plain via insertText, kein insertHTML', () => {
  calls.length = 0;
  const e = pasteEvent({
    'text/plain': 'Hallo Welt',
    'text/html': '<p style="color:red"><strong>Hallo</strong> Welt</p>',
  });
  const res = handleEditorPastePlain(e);
  assert.equal(res, true);
  assert.equal(e._prevented, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'insertText');
  assert.equal(calls[0].value, 'Hallo Welt');
  // kein insertHTML, keine Formatierung durchgereicht
  assert.equal(calls.some(c => c.command === 'insertHTML'), false);
});

test('handleEditorPastePlain: leeres Clipboard → false, kein Insert', () => {
  calls.length = 0;
  const e = pasteEvent({ 'text/html': '<p>nur html</p>' });
  const res = handleEditorPastePlain(e);
  assert.equal(res, false);
  assert.equal(e._prevented, true);
  assert.equal(calls.length, 0);
});

test('handleEditorPastePlain: kein clipboardData → false', () => {
  calls.length = 0;
  const res = handleEditorPastePlain({ preventDefault() {} });
  assert.equal(res, false);
  assert.equal(calls.length, 0);
});
