import { EVT } from '../../events.js';

// Service Worker: cached SPA-Shell für Offline/Zug-Modus. Nur über HTTPS bzw.
// localhost registrierbar. Fehler schlucken – SW ist Progressive Enhancement.
// Dev/Localhost: SW deaktiviert (Cache-Artefakte beim Entwickeln eklig).
// Override pro Browser via `localStorage.setItem('sw', '1')` (an) bzw. `'0'` (aus).
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const swPref = localStorage.getItem('sw');
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const swEnabled = swPref === '1'
    || (swPref !== '0' && location.protocol === 'https:' && !isLocal);

  if (!swEnabled) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
    if (window.caches) {
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .catch(() => {});
    }
    return;
  }

  window.addEventListener('load', async () => {
    try {
      // updateViaCache:'none' → Update-Checks revalidieren sw.js UND seine
      // importScripts (/sw-manifest.js) immer frisch vom Netz. Ohne das nutzt
      // der Default ('imports') den HTTP-Cache für importierte Skripte, und ein
      // neuer Build (nur Manifest-Hash geändert) würde u.U. nicht erkannt.
      const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      // Periodisch nach Updates fragen — ohne aktiven update()-Call wartet
      // der Browser u.U. Stunden bis Tage, bis er einen neuen SW
      // einspielt; v.a. auf Mobile (Tab im Hintergrund / SW gekillt) sieht
      // der User Frontend-Updates dann nie. 60s ist günstig: minimale
      // Bandbreite (nur sw.js wird revalidiert), schnelle Sichtbarkeit.
      // Im versteckten Tab pausieren (Funk/Akku auf Mobile) und beim
      // Wiedersichtbarwerden einmal sofort nachholen.
      setInterval(() => { if (!document.hidden) reg.update().catch(() => {}); }, 60_000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
      const notify = (worker) => {
        if (!worker || !navigator.serviceWorker.controller) return;
        window.__pendingWorker = worker;
        window.dispatchEvent(new CustomEvent(EVT.APP_UPDATE_AVAILABLE));
      };
      if (reg.waiting) notify(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed') notify(nw);
        });
      });
      // Controllerchange feuert erst, nachdem der User das Update-Banner
      // bestätigt hat (applyUpdate → 'skip-waiting' → SW aktiviert; sw.js
      // macht bewusst kein skipWaiting/clients.claim beim Deploy). Bis dahin
      // bedient der ALTE SW die laufende Seite kohärent (alte Partials + alte
      // Module). Auto-Reload hier nur, wenn der Editor nicht dirty ist —
      // sonst Banner stehen lassen, damit der User erst speichern kann.
      // hadController-Snapshot: beim First-Install (Tab ohne Controller
      // geladen) feuert clients.claim() ein controllerchange — ohne Snapshot
      // würde die Seite direkt nach dem ersten Laden nochmal reloaden.
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (reloaded) return;
        reloaded = true;
        const app = window.__app;
        // Niemals auto-reloaden, wenn der User aktiv editiert oder im
        // Fokusmodus liest/schreibt. Auto-Save kann editDirty zwischendurch
        // auf false flippen — focusActive/editMode als härteres Signal.
        if (app?.editMode || app?.focusActive || app?.editDirty) {
          app.updateAvailable = true;
          return;
        }
        // Offline nicht reloaden: der frisch aktivierte SW hat die alte
        // SHELL_CACHE-Version (mit allen JS-Modulen) gelöscht, der neue Cache
        // hält nur die Shell. Ein Reload würde die Module per Netz nachladen —
        // offline scheitert das, Alpine bootet nicht, der Body bleibt hinter
        // dem data-app-loading-Gate unsichtbar (schwarz). Stattdessen Banner;
        // Reload kommt beim nächsten Online-Wechsel.
        if (!navigator.onLine) {
          if (app) app.updateAvailable = true;
          window.addEventListener('online', () => location.reload(), { once: true });
          return;
        }
        location.reload();
      });

      // Reload in eine kohärente Generation — geteilt von 'shell-incoherent'
      // (SW evictierte einen Einzeleintrag) und dem Boot-Build-Guard
      // (Server-Build ≠ geladene Shell). Beim Editieren nur Banner (User soll
      // erst speichern), offline aufschieben bis online. Loop-Schutz: max. ein
      // automatischer Reload pro 30 s (sessionStorage), sonst Banner — sonst
      // könnte eine dauerhaft evictierte Datei eine Reload-Schleife treiben.
      const requestCoherentReload = () => {
        const app = window.__app;
        if (app?.editMode || app?.focusActive || app?.editDirty) {
          if (app) app.updateAvailable = true;
          return;
        }
        if (!navigator.onLine) {
          if (app) app.updateAvailable = true;
          window.addEventListener('online', () => location.reload(), { once: true });
          return;
        }
        let last = 0;
        try { last = Number(sessionStorage.getItem('sw-coherent-reload') || 0); } catch {}
        const now = Date.now();
        if (now - last < 30_000) {
          if (app) app.updateAvailable = true;
          return;
        }
        try { sessionStorage.setItem('sw-coherent-reload', String(now)); } catch {}
        location.reload();
      };
      window.__requestCoherentReload = requestCoherentReload;

      // Vom Update-Banner ("Neu laden") aufgerufen. Normalfall: einen
      // wartenden SW via 'skip-waiting' aktivieren → controllerchange-Listener
      // oben macht den Reload in die neue Generation. Loop-Breaker: Gibt es
      // KEINEN wartenden SW (Build-Guard-Banner ohne neuen Worker, im install
      // gescheitertes cache.addAll, vom Mobile-Browser verworfener Worker),
      // bringt ein reiner location.reload() nichts — der alte SW bedient die
      // alte Shell + alte sw-manifest.js weiter, der Build-Guard feuert erneut,
      // der Banner kommt wieder (Endlos-Loop). Dann erst einen Update-Check
      // erzwingen; bleibt es nach dem zweiten Versuch beim Mismatch, hart
      // heilen: Shell-Caches wegwerfen + SW abmelden + frisch laden, sodass der
      // nächste Load garantiert die deployte Generation vom Netz zieht.
      const applyUpdate = async () => {
        const w = window.__pendingWorker || reg.waiting;
        if (w) {
          try { w.postMessage({ type: 'skip-waiting' }); } catch {}
          setTimeout(() => location.reload(), 2000);
          return;
        }
        let attempts = 0;
        try { attempts = Number(sessionStorage.getItem('sw-update-attempts') || 0); } catch {}
        attempts += 1;
        try { sessionStorage.setItem('sw-update-attempts', String(attempts)); } catch {}
        if (attempts < 2) {
          try { await reg.update(); } catch {}
          const fresh = reg.waiting || window.__pendingWorker;
          if (fresh) { try { fresh.postMessage({ type: 'skip-waiting' }); } catch {} }
          setTimeout(() => location.reload(), 2000);
          return;
        }
        try {
          if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(
              keys.filter(k => k.startsWith('schreibwerkstatt-shell-')).map(k => caches.delete(k))
            );
          }
        } catch {}
        try { await reg.unregister(); } catch {}
        try { sessionStorage.removeItem('sw-update-attempts'); } catch {}
        location.reload();
      };
      window.__applyUpdate = applyUpdate;

      // Der SW meldet eine Cache-Lücke (Einzel-Eviction → er musste eine
      // möglicherweise generationsfremde Datei durchreichen). Frischen
      // Update-Check anstossen (ein wartender SW läuft über controllerchange)
      // und in eine kohärente Generation reloaden.
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'shell-incoherent') {
          reg.update().catch(() => {});
          requestCoherentReload();
        }
      });
    } catch {}
  });
}
