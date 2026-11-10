// Bounded webhook POST using raw http/https (not fetch) so we can pin the DNS
// lookup to the SSRF-validated addresses. Redirects are never followed — a
// 3xx is classified as terminal by the caller.
const http = require('node:http');
const https = require('node:https');

function postWebhook({ url, headers, body, timeoutMs, lookup, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const hostOnly = target.hostname.replace(/^\[|\]$/g, '');
    const transport = target.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    let settled = false;
    const done = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: hostOnly,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        lookup,
        timeout: timeoutMs,
        // SNI/Host correctness when the IP is pinned but the hostname differs.
        servername: hostOnly,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk) => {
          // Byte-capped read: a rogue receiver can't make us buffer forever.
          if (size + chunk.length > maxResponseBytes) {
            truncated = true;
            const remaining = maxResponseBytes - size;
            if (remaining > 0) {
              chunks.push(chunk.subarray(0, remaining));
              size += remaining;
            }
            res.destroy(); // stop reading; status already captured
          } else {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        res.on('end', () =>
          done(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            responseTimeMs: Date.now() - startedAt,
          }),
        );
        res.on('error', (err) => done(reject, err));
      },
    );

    req.on('timeout', () => {
      const err = new Error(`Webhook request timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', (err) => done(reject, err));
    req.end(body);
  });
}

module.exports = { postWebhook };
