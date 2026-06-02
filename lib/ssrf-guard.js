// SSRF-Schutz fuer ausgehende Requests auf user-kontrollierte URLs (z.B.
// WordPress-Blog-Connection). Blockt loopback, private, link-local, CGNAT,
// multicast/reserved und unspecified Ranges fuer IPv4 + IPv6 sowie
// 'localhost'-Hostnamen. `assertPublicUrl` loest den Hostnamen zusaetzlich via
// DNS auf und prueft ALLE Adressen — verhindert das Zielen auf interne Dienste
// ueber einen oeffentlichen DNS-Namen.
//
// Rest-Risiko: ein DNS-Rebind zwischen Resolve und Connect ist nicht
// ausgeschlossen (echte Pinning-Loesung braeuchte einen custom lookup im
// fetch-Agent). Der Resolve-Zeit-Check hebt die Huerde aber deutlich.
const net = require('net');
const dns = require('dns').promises;

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // 10/8 private
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 private
  if (a === 192 && b === 168) return true;           // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true;                          // multicast + reserved
  return false;
}

function ipv6Blocked(ip) {
  const lc = ip.toLowerCase();
  if (lc === '::1' || lc === '::') return true;       // loopback / unspecified
  if (lc.startsWith('fe80')) return true;             // link-local
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // unique-local fc00::/7
  const m = lc.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (m) return ipv4Blocked(m[1]);
  return false;
}

// true, wenn das IP-Literal in einem nicht-oeffentlichen Bereich liegt.
function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true; // kein gueltiges Literal -> defensiv blocken
}

// Synchroner Check: blockt IP-Literale in privaten Ranges und localhost-Namen.
// Hostnamen, die per DNS aufgeloest werden muessen, deckt erst assertPublicUrl ab.
function isBlockedHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return true;
  if (net.isIP(h)) return isBlockedIp(h);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return false;
}

function _throw() {
  const e = new Error('SSRF_BLOCKED_HOST');
  e.code = 'SSRF_BLOCKED_HOST';
  throw e;
}

// Async-Vollcheck: validiert Scheme, blockt Literale und loest Hostnamen via
// DNS auf, um ALLE Zieladressen gegen die Blockliste zu pruefen.
async function assertPublicUrl(urlString) {
  let u;
  try { u = new URL(urlString); }
  catch { const e = new Error('SSRF_INVALID_URL'); e.code = 'SSRF_INVALID_URL'; throw e; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') _throw();
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) _throw();
    return;
  }
  if (isBlockedHost(host)) _throw();
  // Test-Seam: Integrationstests stubben globalThis.fetch und nutzen
  // nicht-aufloesbare Reserved-TLD-Hosts (z.B. wp.test). Nur die DNS-Aufloesung
  // wird dann uebersprungen — der Literal-/localhost-Block oben bleibt aktiv.
  if (process.env.SSRF_SKIP_DNS_CHECK === '1') return;
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { const e = new Error('SSRF_DNS_FAILED'); e.code = 'SSRF_DNS_FAILED'; throw e; }
  if (!addrs.length) _throw();
  for (const { address } of addrs) {
    if (isBlockedIp(address)) _throw();
  }
}

module.exports = { isBlockedIp, isBlockedHost, assertPublicUrl };
