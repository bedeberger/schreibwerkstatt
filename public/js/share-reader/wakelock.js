'use strict';
// Bildschirm wachhalten, solange die Leseansicht sichtbar ist (Screen Wake Lock
// API). Ein Beta-Leser liest oft minutenlang, ohne den Bildschirm zu berühren —
// ohne Wake-Lock dimmt/sperrt das Handy und unterbricht das Lesen.
//
// Best-Effort, reines Progressive Enhancement: fehlt die API (kein Support, kein
// HTTPS) oder lehnt der Browser ab, passiert nichts. Der Lock wird vom Browser
// automatisch freigegeben, sobald der Tab in den Hintergrund geht — darum bei
// jedem Sichtbar-Werden neu anfordern.

export function setupWakeLock() {
  if (!('wakeLock' in navigator)) return;
  let sentinel = null;

  async function acquire() {
    if (sentinel || document.hidden) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      // Der Browser kann den Lock jederzeit selbst lösen (z.B. Akku-Sparmodus);
      // dann Referenz freigeben, damit ein späterer visibilitychange neu anfordert.
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch { sentinel = null; }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) acquire();
  });
  acquire();
}
