// Local webhook receiver for development + signing verification.
//   node scripts/dev-receiver.js [port] [signingSecret]
// Logs every delivery and verifies the HMAC signature when a secret is given.
const http = require('node:http');
const { verifySignature } = require('../packages/shared/src/crypto');

const port = Number(process.argv[2] || 5001);
const secret = process.argv[3] || process.env.DEV_RECEIVER_SECRET || null;

const seen = new Set();

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const deliveryId = req.headers['x-eventrelay-delivery-id'];
    const dupe = deliveryId && seen.has(deliveryId);
    if (deliveryId) seen.add(deliveryId);

    let sigOk = 'no-secret';
    if (secret) {
      const ts = req.headers['x-eventrelay-timestamp'];
      const sigHeader = req.headers['x-eventrelay-signature'] || '';
      const v1 = sigHeader.match(/v1=([0-9a-f]+)/)?.[1] || '';
      sigOk = verifySignature(secret, ts, rawBody, v1) ? 'valid' : 'INVALID';
    }
    console.log(JSON.stringify({
      at: new Date().toISOString(), eventId: req.headers['x-eventrelay-event-id'],
      deliveryId, duplicate: !!dupe, signature: sigOk, body: rawBody.slice(0, 500),
    }, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true, duplicate: !!dupe }));
  });
}).listen(port, () => console.log(`dev receiver listening on :${port}${secret ? ' (verifying signatures)' : ''}`));
