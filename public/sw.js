// Service Worker: hält die SPA-Shell und Buch-Inhalte offline verfügbar (Zug-Szenario).
// Strategie:
//  - Navigate (/, /index.html): Stale-While-Revalidate im SHELL_CACHE
//    → 0-Latenz-Render bei Repeat-Visit; neues HTML wird parallel geladen.
//    Deploy-Update fliesst über `skip-waiting` + controllerchange-Reload.
//  - Shell-Assets (CSS/JS/Icons): Stale-While-Revalidate im SHELL_CACHE
//  - HTML-Partials: Network-First mit Cache-Fallback (verhindert eingefrorene UI-Bugs)
//  - Content-GETs (/content/*): Stale-While-Revalidate im CONTENT_CACHE → Navigation + Seiteninhalt offline
//  - Schreibende Requests (PUT/POST/DELETE): nie behandelt (method-Check am Anfang)
//  - Auth/KI/Job-Queue/SSE: Network-Only, nie cachen
//  - Version-Bump der Konstanten invalidiert den jeweiligen Cache

const SHELL_CACHE = 'schreibwerkstatt-shell-v1122';
const CONTENT_CACHE = 'schreibwerkstatt-content-v1';
const CONFIG_CACHE = 'schreibwerkstatt-config-v2';
const ACTIVE_CACHES = new Set([SHELL_CACHE, CONTENT_CACHE, CONFIG_CACHE]);
const SHELL_PATH = '/index.html';
const CONFIG_PATH = '/config';

// Pfade, die niemals aus dem Cache kommen dürfen (dynamische/auth-pflichtige Daten, Streams).
// /content/* und /config sind bewusst NICHT hier – sie haben eigene SWR-Handler.
const NEVER_CACHE_PREFIXES = [
  '/auth/',
  '/jobs',
  '/history',
  '/figures',
  '/locations',
  '/chat',
  '/sync',
  '/booksettings',
  '/publication',
  '/ideen',
  '/book-editor',
  '/search',
  '/share',
];

const SHELL_ASSET_REGEX = /\.(?:css|js|mjs|json|svg|ico|png|woff2?)$/i;
const PARTIAL_REGEX = /^\/partials\//;
// i18n-JSON: Network-First wie Partials, damit neue Keys nicht als Raw-Key
// im UI hängenbleiben.
const I18N_REGEX = /^\/js\/i18n\/[a-z]{2}\.json$/i;

// /js/plausible-init.js wird vom Server dynamisch aus app_settings gerendert
// (Plausible an/aus + URL). Niemals cachen, sonst greift Admin-Toggle nicht
// ohne Hard-Reload + SW-Invalidate.
const PLAUSIBLE_INIT_PATH = '/js/plausible-init.js';

function isShellRequest(url) {
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  if (url.pathname === PLAUSIBLE_INIT_PATH) return false;
  if (PARTIAL_REGEX.test(url.pathname)) return true;
  if (SHELL_ASSET_REGEX.test(url.pathname)) return true;
  return false;
}

function isNeverCache(url) {
  return NEVER_CACHE_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(p + '/') || url.pathname.startsWith(p));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Einstiegspunkt best-effort vorcachen – scheitert bei Offline-Install lautlos
    try { await cache.add(new Request('/', { cache: 'reload' })); } catch {}
    // Bewusst KEIN skipWaiting hier: der neue SW bleibt `waiting`, bis der
    // User das Update-Banner klickt (applyUpdate → 'skip-waiting'-Message).
    // Sonst übernähme der neue SW eine laufende (Editor-)Seite sofort und
    // bediente neue Network-First-Partials gegen die noch im Speicher
    // laufenden ALTEN JS-Module → Skew (z.B. ReferenceError auf neu
    // hinzugefügten Card-State-Feldern, die das alte Modul nicht kennt).
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !ACTIVE_CACHES.has(k)).map(k => caches.delete(k)));
    // Kein clients.claim(): laufende Tabs behalten den alten SW (= alte
    // Partials + alte Module, kohärent), bis sie via Banner/Reload wechseln.
    // Activate läuft ohnehin erst nach 'skip-waiting', also nach User-Klick.
  })());
});

// Navigate (HTML-Shell): Stale-While-Revalidate. Repeat-Visits liefern Shell
// 0-Latenz aus dem Cache, parallel läuft Network-Fetch und aktualisiert den
// Cache für den nächsten Besuch. Deploy-Updates kommen via `skip-waiting`-
// Pfad (controllerchange im Client → location.reload), nicht über
// Per-Navigation-Revalidate — sonst wäre der TTFB-Vorteil weg.
async function handleNavigate(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_PATH) || await cache.match('/');
  const netPromise = fetch(req).then((net) => {
    if (net && net.ok && net.type !== 'opaqueredirect') {
      cache.put(SHELL_PATH, net.clone());
    }
    return net;
  }).catch(() => null);

  if (cached) {
    netPromise.catch(() => {});
    return cached;
  }
  const net = await netPromise;
  if (net) return net;
  return new Response('Offline – Shell nicht im Cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function handleShellAsset(req) {
  const cache = await caches.open(SHELL_CACHE);
  const url = new URL(req.url);
  // Partials & i18n-JSON: Network-First, damit Markup- und Locale-Updates
  // sofort durchschlagen.
  if (PARTIAL_REGEX.test(url.pathname) || I18N_REGEX.test(url.pathname)) {
    try {
      const net = await fetch(req);
      if (net && net.ok) cache.put(req, net.clone());
      return net;
    } catch {
      const cached = await cache.match(req);
      if (cached) return cached;
      return new Response('Offline', { status: 503 });
    }
  }
  const cached = await cache.match(req);
  const netPromise = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  if (cached) {
    netPromise.catch(() => {});
    return cached;
  }
  const net = await netPromise;
  if (net) return net;
  return new Response('Offline', { status: 503 });
}

// Content-GETs: Stale-While-Revalidate, damit Buch-/Kapitel-/Seitenlisten
// und einzelne Seiteninhalte (/content/pages/:id) offline lesbar bleiben.
// 401/Fehlerantworten werden nicht gecacht, damit Login-Redirects nicht festfrieren.
//
// LRU-Bound: ohne Limit wächst der Cache mit jeder besuchten Seite und
// verbraucht auf Long-Running-Sessions zig MB. MAX_CONTENT_CACHE_ENTRIES kappt
// nach FIFO (cache.keys() liefert Insertion-Order in allen Browsern, die SW
// unterstützen).
const MAX_CONTENT_CACHE_ENTRIES = 200;
async function _evictContentCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_CONTENT_CACHE_ENTRIES;
  if (overflow > 0) {
    for (let i = 0; i < overflow; i++) await cache.delete(keys[i]);
  }
}
async function _handleSwr(req, cacheName) {
  // Bypass-Marker: konsistenzkritische Reads (z.B. Konflikt-Check vor
  // Draft-Push) müssen frische Server-Daten sehen, nicht den SWR-Cache.
  // Sonst matcht ein stale `page.html` mit dem `draft.originalHtml` und
  // ein veralteter Draft überschreibt Server-Stand.
  const url = new URL(req.url);
  if (url.searchParams.has('__fresh')) {
    try { return await fetch(req); }
    catch {
      return new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  }
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const netPromise = fetch(req).then(async (res) => {
    if (res && res.ok && res.type !== 'opaqueredirect') {
      await cache.put(req, res.clone());
      await _evictContentCache(cache);
    }
    return res;
  }).catch(() => null);

  if (cached) {
    netPromise.catch(() => {});
    return cached;
  }
  const net = await netPromise;
  if (net) return net;
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function handleContent(req) { return _handleSwr(req, CONTENT_CACHE); }

// /config liefert Session-User + Provider-Config. SWR, damit wiederkehrende
// Offline-User den App-Shell-Bootstrap komplett durchlaufen können. 401/Fehler
// werden nicht gecacht (via res.ok-Check), damit Login-Redirects nicht festfrieren.
async function handleConfig(req) {
  const cache = await caches.open(CONFIG_CACHE);
  const cached = await cache.match(CONFIG_PATH);
  const netPromise = fetch(req).then((res) => {
    if (res && res.ok && res.type !== 'opaqueredirect') cache.put(CONFIG_PATH, res.clone());
    return res;
  }).catch(() => null);

  if (cached) {
    netPromise.catch(() => {});
    return cached;
  }
  const net = await netPromise;
  if (net) return net;
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Logout aus dem Client: API+Config-Caches dropen, sonst rendert die SPA nach
// `/auth/logout` kurz noch gecachte Seiten/Configs des alten Users.
// Update-Anstoss: 'skip-waiting' aktiviert den wartenden SW sofort. Erst danach
// feuert `controllerchange` im Client, der dann ein einmaliges location.reload()
// macht.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === 'auth-logout') {
    event.waitUntil((async () => {
      await Promise.all([
        caches.delete(CONTENT_CACHE),
        caches.delete(CONFIG_CACHE),
      ]);
      event.source?.postMessage?.({ type: 'auth-logout-done' });
    })());
  }
  // Invalidiert CONTENT_CACHE-Einträge nach Writes. Ohne diesen Bust liefert SWR
  // nach einem PUT weiterhin die alte Fassung beim nächsten GET — und ein
  // Read-Modify-Write-Pfad (Lektorat-Save, Chat-Vorschlag) überschreibt damit
  // frische User-Edits mit Stale-Daten. paths sind /content/*-Subpfade
  // ohne `/content/`-Prefix.
  if (event.data?.type === 'invalidate-content') {
    const paths = Array.isArray(event.data.paths) ? event.data.paths : [];
    event.waitUntil(_invalidateCacheEntries(CONTENT_CACHE, paths, '/content/'));
  }
});

async function _invalidateCacheEntries(cacheName, paths, prefix) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const targets = new Set(paths.map(p => prefix + p));
  for (const k of keys) {
    try {
      const u = new URL(k.url);
      if (targets.has(u.pathname)) await cache.delete(k);
    } catch {}
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(req));
    return;
  }
  if (url.pathname === CONFIG_PATH) {
    event.respondWith(handleConfig(req));
    return;
  }
  if (url.pathname.startsWith('/content/')) {
    event.respondWith(handleContent(req));
    return;
  }
  if (isShellRequest(url)) {
    event.respondWith(handleShellAsset(req));
  }
});
