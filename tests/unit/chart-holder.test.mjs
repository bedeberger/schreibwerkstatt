// createChartHolder (public/js/cards/chart-holder.js): eine Chart-Instanz pro
// Halter, Theme-Redraw nur bei stehendem Chart, disconnect() trennt den Observer.
import test from 'node:test';
import assert from 'node:assert/strict';

const observers = [];
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; this.connected = false; observers.push(this); }
  observe() { this.connected = true; }
  disconnect() { this.connected = false; }
};
globalThis.document = { documentElement: {} };

const { createChartHolder } = await import('../../public/js/cards/chart-holder.js');

const mkChart = () => ({ destroyed: 0, destroy() { this.destroyed++; } });

test('set ersetzt und zerstört die alte Instanz, destroy räumt', () => {
  const h = createChartHolder();
  const a = mkChart(); const b = mkChart();
  h.set(a); h.set(b);
  assert.equal(a.destroyed, 1);
  assert.equal(h.get(), b);
  h.destroy();
  assert.equal(b.destroyed, 1);
  assert.equal(h.get(), null);
});

test('ensureThemeRedraw: einmalig, feuert nur mit Chart, disconnect trennt', () => {
  const h = createChartHolder();
  let redraws = 0;
  const before = observers.length;
  h.ensureThemeRedraw(() => { redraws++; });
  h.ensureThemeRedraw(() => { redraws += 100; });
  assert.equal(observers.length, before + 1, 'nur ein Observer');
  const obs = observers.at(-1);
  obs.cb();
  assert.equal(redraws, 0, 'ohne Chart kein Redraw');
  h.set(mkChart());
  obs.cb();
  assert.equal(redraws, 1);
  h.disconnect();
  assert.equal(obs.connected, false);
  h.ensureThemeRedraw(() => {});
  assert.equal(observers.length, before + 2, 'nach disconnect neu anhängbar');
});
