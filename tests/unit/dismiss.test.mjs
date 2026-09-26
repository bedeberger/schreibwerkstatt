// attachDismiss (public/js/cards/dismiss.js): Scroll (Capture) + Resize +
// optionale Zusatz-Events schliessen; abort() meldet alles ab.
import test from 'node:test';
import assert from 'node:assert/strict';

const target = new EventTarget();
globalThis.window = {
  addEventListener: target.addEventListener.bind(target),
  removeEventListener: target.removeEventListener.bind(target),
  dispatchEvent: target.dispatchEvent.bind(target),
};

const { attachDismiss, detachDismiss } = await import('../../public/js/cards/dismiss.js');

test('scroll/resize/Zusatz-Event schliessen, abort meldet ab', () => {
  let n = 0;
  const ctx = { _d: attachDismiss(() => { n++; }, { events: ['book:changed'] }) };
  for (const t of ['scroll', 'resize', 'book:changed']) window.dispatchEvent(new Event(t));
  assert.equal(n, 3);
  detachDismiss(ctx, '_d');
  assert.equal(ctx._d, null);
  for (const t of ['scroll', 'resize', 'book:changed']) window.dispatchEvent(new Event(t));
  assert.equal(n, 3);
  detachDismiss(ctx, '_d'); // idempotent
});

test('scroll: false hört nur auf resize', () => {
  let n = 0;
  const c = attachDismiss(() => { n++; }, { scroll: false });
  window.dispatchEvent(new Event('scroll'));
  assert.equal(n, 0);
  window.dispatchEvent(new Event('resize'));
  assert.equal(n, 1);
  c.abort();
});
