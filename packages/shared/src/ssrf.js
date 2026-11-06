// SSRF defence for webhook endpoints. Rule #1: never trust a hostname string.
// A URL that *looks* fine can resolve to 127.0.0.1 — so we resolve it, check
// every address, and then pin the connection to the checked addresses to
// stop DNS-rebinding (TOCTOU) between the check and the connect.
const dns = require('node:dns').promises;
const net = require('node:net');

class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
    this.code = 'SSRF_BLOCKED';
  }
}

function parseV4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function inRange(n, lo, hi) { return n >= lo && n <= hi; }

// Is this a single IPv4 address in a range we must never dial?
function isBlockedV4([a, b]) {
  if (a === 0) return true;                                    // 0.0.0.0/8 "this host"
  if (a === 10) return true;                                   // private
  if (a === 127) return true;                                  // loopback
  if (a === 169 && b === 254) return true;                     // link-local (cloud metadata lives here)
  if (a === 172 && inRange(b, 16, 31)) return true;            // private
  if (a === 192 && b === 168) return true;                     // private
  if (a === 192 && b === 0) return true;                       // 192.0.0.0/24 + TEST-NET-1
  if (a === 192 && b === 88) return true;                      // 6to4 relay (deprecated)
  if (a === 192 && b === 2) return true;                       // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;        // benchmarking
  if (a === 198 && b === 51) return true;                      // TEST-NET-2
  if (a === 203 && b === 0) return true;                       // TEST-NET-3
  if (a === 100 && inRange(b, 64, 127)) return true;           // CGNAT shared space
  if (a >= 224) return true;                                   // multicast + reserved (240/4)
  return false;
}

// Best-effort IPv6 classification. We cover the ranges attackers actually use;
// anything we don't recognise as globally routable gets blocked (fail closed).
function isBlockedV6(ipLower) {
  let ip = ipLower.toLowerCase();

  // IPv4-mapped IPv6: ::ffff:127.0.0.1 — unwrap and judge as IPv4.
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4 = parseV4(mapped[1]);
    return v4 ? isBlockedV4(v4) : true;
  }
  if (ip === '::' || ip === '::1') return true;                // unspecified / loopback
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // fe80::/10 link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 unique-local
  if (ip.startsWith('ff')) return true;                        // multicast
  if (ip.startsWith('2001:db8:')) return true;                 // documentation
  if (ip.startsWith('64:ff9b:')) return true;                  // NAT64 well-known prefix
  if (ip.startsWith('::ffff:')) return true;                   // any other mapped form → fail closed
  // Everything else (global unicast etc.) is allowed through.
  return false;
}

function isBlockedIp(ip) {
  if (typeof ip !== 'string' || !ip) return true;
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(clean)) {
    const v4 = parseV4(clean);
    return v4 ? isBlockedV4(v4) : true;
  }
  if (net.isIPv6(clean)) return isBlockedV6(clean);
  return true; // not an IP at all → treat as blocked (fail closed)
}

async function resolveAllAddresses(hostname) {
  const results = [];
  // resolve4/resolve6 each throw on ENOTFOUND etc. — let those bubble up so
  // the caller can classify them (a DNS failure is retryable, a blocked
  // address is terminal — different handling downstream).
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  if (v4.status === 'fulfilled') results.push(...v4.value);
  if (v6.status === 'fulfilled') results.push(...v6.value);
  if (results.length === 0) {
    const reason = v4.status === 'rejected' ? v4.reason : v6.reason;
    throw reason;
  }
  return [...new Set(results)];
}

function isLocalDevHostname(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}

function allowLocalEnabled() {
  return String(process.env.ALLOW_LOCAL_ENDPOINTS || 'false').toLowerCase() === 'true';
}

// Validate an endpoint URL. Throws SsrfError for blocked targets.
// Options: { allowLocal } — overrides the env flag (tests use this).
async function validateEndpointUrl(rawUrl, options = {}) {
  const allowLocal = options.allowLocal ?? allowLocalEnabled();
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('Invalid endpoint URL');
  }

  const isProd = (process.env.NODE_ENV || 'development') === 'production';
  const allowInsecure = String(process.env.ALLOW_INSECURE_URLS || 'false').toLowerCase() === 'true';

  if (url.protocol === 'https:') {
    // fine everywhere
  } else if (url.protocol === 'http:') {
    if (isProd && !allowLocal && !allowInsecure) {
      throw new SsrfError('HTTPS is required for webhook endpoints in production');
    }
    if (!allowLocal && !allowInsecure) {
      // Plain http in dev is okay-ish for local testing, but only if local
      // endpoints are allowed; otherwise require https even in dev by default.
      // We keep this permissive in dev for ergonomics, strict in prod.
      if (isProd) throw new SsrfError('HTTPS is required in production');
    }
  } else {
    throw new SsrfError('Only http:// and https:// endpoint URLs are allowed');
  }

  if (!url.hostname) throw new SsrfError('Endpoint URL must include a hostname');
  // Node keeps brackets on IPv6 hostnames ("[::1]") — strip for net checks.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  // IP-literal host: judge it directly, no DNS involved.
  if (net.isIP(host)) {
    if (!allowLocal && isBlockedIp(host)) {
      throw new SsrfError(`Endpoint IP ${host} is in a blocked range`);
    }
    return { url: url.toString(), addresses: [host] };
  }

  if (allowLocal && isLocalDevHostname(host)) {
    return { url: url.toString(), addresses: [] }; // dev allowlist — skip DNS checks
  }

  // Hostname: resolve and check EVERY address. One bad address poisons it.
  const addresses = await resolveAllAddresses(host);
  if (!allowLocal) {
    for (const addr of addresses) {
      if (isBlockedIp(addr)) {
        throw new SsrfError(`Endpoint host ${host} resolves to blocked address ${addr}`);
      }
    }
  }
  return { url: url.toString(), addresses };
}

// Custom `lookup` for http/https requests: only hands out the addresses we
// already validated for THIS attempt. This is what defeats DNS rebinding —
// even if DNS flips to 127.0.0.1 a millisecond later, we never ask again.
function pinnedLookup(hostname, addresses) {
  return (_hostname, _options, callback) => {
    if (typeof _options === 'function') {
      callback = _options;
      _options = {};
    }
    const options = _options || {};
    if (!addresses || addresses.length === 0) {
      // Nothing pinned (dev allowlist): fall back to normal resolution.
      return dns.lookup(String(hostname).replace(/^\[|\]$/g, ''), options, callback);
    }
    const first = addresses[0];
    const family = net.isIPv6(first) ? 6 : 4;
    if (options.all) {
      return callback(null, addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })));
    }
    return callback(null, first, family);
  };
}

module.exports = {
  SsrfError, isBlockedIp, resolveAllAddresses, validateEndpointUrl, pinnedLookup,
};
