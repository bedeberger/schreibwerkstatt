// setupCardLifecycle: eigene onBookChanged/onViewReset-Overrides ersetzen
// Reset + Load, aber NICHT das Abräumen der timerKeys. Ein Poller des alten
// Buchs, der weiterliefe, schriebe sein Ergebnis in die Karte des neuen.
import test from 'node:test';
import assert from 'node:assert/strict';

const target = new EventTarget();
globalThis.window = {
  addEventListener: target.addEventListener.bind(target),
  removeEventListener: target.removeEventListener.bind(target),
  dispatchEvent: target.dispatchEvent.bind(target),
  __app: {},
};
globalThis.Alpine = { store: (n) => (n === 'nav' ? { selectedBookId: '1' } : {}) };

const { setupCardLifecycle } = await import('../../public/js/cards/card-lifecycle.js');
const { EVT } = await import('../../public/js/events.js');

function mkCtx() {
  return { _pollTimer: setInterval(() => {}, 100000), $watch() {} };
}

for (const [label, evt, key] of [
  ['book:changed', EVT.BOOK_CHANGED, 'onBookChanged'],
  ['view:reset', EVT.VIEW_RESET, 'onViewReset'],
]) {
  test(`${label}-Override: timerKeys werden vorher geclearet`, () => {
    const ctx = mkCtx();
    let seenTimer = 'unset';
    const lc = setupCardLifecycle(ctx, {
      name: 'x',
      timerKeys: ['_pollTimer'],
      [key]: (e, c) => { seenTimer = c._pollTimer; },
    });
    window.dispatchEvent(new CustomEvent(evt));
    assert.equal(seenTimer, null, 'Override sah noch den laufenden Timer');
    assert.equal(ctx._pollTimer, null);
    lc.destroy();
  });
}
