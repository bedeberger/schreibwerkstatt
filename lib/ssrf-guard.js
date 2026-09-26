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

// IPv6-Literal zu acht 16-Bit-Hextets expandieren (inkl. `::`-Kompression und
// eingebettetem dotted-IPv4-Schwanz wie `::ffff:1.2.3.4`). null = unparsebar.
function expandIPv6(ip) {
  let s = String(ip).toLowerCase();
  const pct = s.indexOf('%');            // Zone-ID (fe80::1%eth0) abschneiden
  if (pct >= 0) s = s.slice(0, pct);
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const p = tail[1].split('.').map(Number);
    if (p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = s.slice(0, -tail[1].length)
      + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  const out = all.map(h => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function _v4FromHextets(hi, lo) {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

// Blockt IPv6-Ranges UND jede Form, die eine IPv4-Adresse einbettet — sonst
// umgeht `[::ffff:127.0.0.1]` den IPv4-Check: WHATWG-URL normalisiert das zu
// `[::ffff:7f00:1]`, ein Match auf die dotted Form greift dann nicht mehr.
function ipv6Blocked(ip) {
  const h = expandIPv6(ip);
  if (!h) return true;                                   // unparsebar -> defensiv
  const [a, b] = h;
  const zeroUpTo = (n) => h.slice(0, n).every(x => x === 0);
  if (zeroUpTo(8)) return true;                          // :: unspecified
  if (zeroUpTo(7) && h[7] === 1) return true;            // ::1 loopback
  if (zeroUpTo(5) && h[5] === 0xffff) return ipv4Blocked(_v4FromHextets(h[6], h[7])); // ::ffff:0:0/96 IPv4-mapped
  if (zeroUpTo(4) && h[4] === 0xffff && h[5] === 0) return ipv4Blocked(_v4FromHextets(h[6], h[7])); // ::ffff:0:0:0/96 SIIT
  if (zeroUpTo(6)) return true;                          // ::/96 IPv4-compatible (veraltet)
  if (a === 0x64 && b === 0xff9b && h.slice(2, 6).every(x => x === 0)) {
    return ipv4Blocked(_v4FromHextets(h[6], h[7]));      // 64:ff9b::/96 NAT64 (Well-Known)
  }
  if (a === 0x64 && b === 0xff9b && h[2] === 1) return true; // 64:ff9b:1::/48 NAT64 lokal
  if (a === 0x2002) return ipv4Blocked(_v4FromHextets(h[1], h[2])); // 2002::/16 6to4
  if (a === 0x2001 && b === 0) return true;              // 2001::/32 Teredo (v4 verschleiert)
  if (a === 0x2001 && b === 0xdb8) return true;          // 2001:db8::/32 Doku
  if (a === 0x100 && h.slice(1, 4).every(x => x === 0)) return true; // 100::/64 discard
  if ((a & 0xffc0) === 0xfe80) return true;              // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true;              // fec0::/10 site-local (veraltet)
  if ((a & 0xfe00) === 0xfc00) return true;              // fc00::/7 unique-local
  if ((a & 0xff00) === 0xff00) return true;              // ff00::/8 multicast
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

module.exports = { isBlockedIp, isBlockedHost, assertPublicUrl, expandIPv6 };
