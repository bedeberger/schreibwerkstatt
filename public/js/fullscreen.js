// Native Browser-Fullscreen-Helper.
//
// `toggleWrapFullscreen(wrap)` — Enter/Exit auf das gegebene Element. Wirft,
// wenn `requestFullscreen` rejected (iOS Safari ohne API, Permissions-Policy,
// Permission-Denial). Caller fängt für CSS-Overlay-Fallback ab.
//
// `attachFullscreenSync({ resolveWrap, onChange, signal })` — registriert
// einen `fullscreenchange`-Listener am document und ruft `onChange(active)`
// mit aktuellem Match-Status. `resolveWrap` als Funktion, damit lazy/erst
// später gemountete Wraps unterstützt werden. `signal` (AbortController) für
// automatisches Abmelden via Card-Lifecycle.

export async function toggleWrapFullscreen(wrap) {
  if (!wrap) return;
  if (document.fullscreenElement === wrap) {
    try { await document.exitFullscreen(); } catch {}
    return;
  }
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch {}
  }
  await wrap.requestFullscreen();
}

export function attachFullscreenSync({ resolveWrap, onChange, signal }) {
  const handler = () => {
    const wrap = typeof resolveWrap === 'function' ? resolveWrap() : resolveWrap;
    onChange(!!wrap && document.fullscreenElement === wrap);
  };
  document.addEventListener('fullscreenchange', handler, signal ? { signal } : undefined);
  return handler;
}
