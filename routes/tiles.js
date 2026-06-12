'use strict';
// Tile-Proxy fuer die Orte-Karte. Leaflet laedt Kacheln normalerweise direkt im
// Browser; ein self-hosted Tile-Server, der nur HTTP spricht (z. B. im LAN),
// wird von einer HTTPS-App aber als Mixed-Content geblockt. Dieser Proxy holt die
// Kacheln server-seitig und liefert sie ueber den App-eigenen Origin aus — der
// Tile-Server bleibt HTTP und unexponiert. Das Frontend bekommt die Proxy-URL nur,
// wenn geocode.tiles.url auf http:// zeigt (siehe routes/proxies.js#/config);
// HTTPS-/OSM-Upstreams laedt Leaflet weiterhin direkt. Auth greift global
// (Cookies werden same-origin mitgesendet). z/x/y sind admin-konfiguriert in der
// Template-URL, nicht user-gesteuert → kein SSRF-Vektor.
const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');

const router = express.Router();
// Grosszuegig: On-Demand-Tile-Server (mod_tile/renderd, cachende Proxies) rendern
// eine kalte Kachel beim ERSTEN Zugriff und brauchen dafuer teils >10s; danach
// liefert ihr Cache sie sofort. Ein knapper Timeout bricht genau diese Cold-Renders
// ab → 502 beim ersten Oeffnen der Karte. 30s gibt dem Render-Pfad Luft.
const TILE_TIMEOUT_MS = 30000;
// Kacheln aendern sich praktisch nie → Browser darf lange cachen (spart dem
// Tile-Server die Cold-Render-Last bei jedem erneuten Betrachten).
const CACHE_CONTROL = 'public, max-age=86400';

function upstreamTileUrl(z, x, y) {
  const tpl = String(appSettings.get('geocode.tiles.url') || '').trim();
  if (!tpl) return null;
  // {s}-Subdomain auf einen festen Wert auflösen (OSM-Mirror a/b/c sind gleichwertig).
  return tpl
    .replace('{s}', 'a')
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

router.get('/:z/:x/:y', async (req, res) => {
  const { z, x, y } = req.params;
  if (![z, x, y].every(v => /^\d+$/.test(v))) return res.status(400).end();

  const url = upstreamTileUrl(z, x, y);
  if (!url) return res.status(404).end();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TILE_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { signal: ctrl.signal });
    if (!upstream.ok) return res.status(upstream.status === 404 ? 404 : 502).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.end(buf);
  } catch (err) {
    // undici verpackt den echten Grund (DNS/Connect/TLS) in err.cause; err.message
    // ist nur das generische "fetch failed". Cause mitloggen, sonst ist ein nicht
    // erreichbarer self-hosted Tile-Server nicht diagnostizierbar (ENOTFOUND =
    // DNS, ECONNREFUSED = Port/Server, ETIMEDOUT/EHOSTUNREACH = Routing/Firewall).
    if (err.name !== 'AbortError') {
      const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
      logger.warn(`tile-proxy ${z}/${x}/${y} → ${url}: ${err.message}${cause}`);
    }
    res.status(502).end();
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
