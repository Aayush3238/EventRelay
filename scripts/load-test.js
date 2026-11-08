// Simple ingestion load test — hammers POST /v1/events and reports results.
// Usage:
//   EVENTRELAY_API=https://your-api.onrender.com EVENTRELAY_KEY=er_live_... \
//   node scripts/load-test.js [count] [concurrency]
// Defaults: 100 events, 10 concurrent. Idempotency keys are unique per run
// (prefix = timestamp) unless LOADTEST_IDEMPOTENCY=1 reuses one key to
// prove deduplication (then deliveriesCreated should stay at first value).
const base = process.env.EVENTRELAY_API || 'http://localhost:4000';
const key = process.env.EVENTRELAY_KEY;
const count = Number(process.argv[2] || 100);
const concurrency = Number(process.argv[3] || 10);
const reuseKey = process.env.LOADTEST_IDEMPOTENCY === '1';
const runId = Date.now().toString(36);

if (!key) {
  console.error('Set EVENTRELAY_KEY to your API key first.');
  process.exit(1);
}

async function send(i) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
      'Idempotency-Key': reuseKey ? `loadtest-${runId}` : `loadtest-${runId}-${i}`,
    },
    body: JSON.stringify({
      type: process.env.LOADTEST_TYPE || 'order.created',
      data: { orderId: `LOAD-${i}`, amount: 100 + i, currency: 'INR', loadRun: runId },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ms: Date.now() - started, body };
}

async function main() {
  console.log(`→ ${base}/v1/events  count=${count} concurrency=${concurrency} reuseKey=${reuseKey}`);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < count) {
      const i = next;
      next += 1;
      try { results.push(await send(i)); }
      catch (err) { results.push({ status: 0, ms: 0, body: { error: String(err.message) } }); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const ok = results.filter((r) => r.status === 200 || r.status === 202);
  const deduped = results.filter((r) => r.body?.deduplicated);
  const eventIds = new Set(ok.map((r) => r.body?.eventId));
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`success: ${ok.length}/${count}`);
  console.log(`unique eventIds: ${eventIds.size}`);
  console.log(`deduplicated responses: ${deduped.length}`);
  console.log(`latency ms: p50=${times[Math.floor(times.length / 2)] ?? 0} p95=${times[Math.floor(times.length * 0.95)] ?? 0} max=${times[times.length - 1] ?? 0}`);
  const failed = results.filter((r) => r.status !== 200 && r.status !== 202);
  if (failed.length) console.log('sample failure:', JSON.stringify(failed[0]).slice(0, 300));
}

main().catch((err) => { console.error(err); process.exit(1); });
