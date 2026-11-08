# EventRelay — Feature Testing Guide

> How to test every feature of your deployed EventRelay (Render + Vercel),
> what to expect, and where failures show up. Work top to bottom — each
> section builds on the previous one.

**URLs you'll need** (fill in your own):

```
API:      https://eventrelay.onrender.com     (exact name from Render)
Site:     https://event-relay-*.vercel.app    (your Vercel URL)
Receiver: a public HTTPS echo, e.g. https://webhook.site/#!/your-token
```

> ⚠️ First request after idle takes ~30–50s (Render free-tier cold start).
> Don't panic if the first curl seems hung — retry once.

---

## 0. One-time setup (5 minutes)

1. Open your Vercel site → **Sign up** → you're logged in.
2. **API Keys → Create API key** → copy the `er_live_…` key (shown once).
   Save it in a password manager — you'll use it in almost every test.
3. **Endpoints → Create endpoint:**
   - Name: `webhook.site test`
   - URL: your webhook.site URL (must be `https://…`)
   - Event types: `order.created`
   - Copy the **Signing Secret** (shown once) — needed for §8.
4. In webhook.site, leave the tab open — deliveries will appear there live.

Set these in your terminal for the curl tests:

```bash
export API=https://eventrelay.onrender.com
export KEY=er_live_your_key_here
```

## 1. Auth tests

| # | Test | Expected |
|---|---|---|
| 1.1 | Open site logged out → lands on **Sign Up** | ✅ Sign Up page (not Sign In) |
| 1.2 | Sign up with a new email | ✅ Redirected to `/dashboard`, stats show 0s |
| 1.3 | Sign out, sign in with wrong password | ✅ "Invalid email or password" |
| 1.4 | Sign in with correct password | ✅ Dashboard loads |
| 1.5 | Logged in → visit `/` (landing) | ✅ Landing page with **Open dashboard** button |
| 1.6 | Logged in → click **Home page** in sidebar | ✅ Back to landing |
| 1.7 | `curl -X POST $API/v1/events` with **no** API key | ✅ `401 UNAUTHORIZED` |

## 2. Happy-path delivery ⭐ (the core test)

```bash
curl -X POST $API/v1/events \
  -H "X-API-Key: $KEY" \
  -H "Idempotency-Key: test-happy-1" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created","data":{"orderId":"ORD-1001","amount":1499,"currency":"INR"}}'
```

| Check | Where | Expected |
|---|---|---|
| Response | curl output | `202 {"eventId":"…","status":"accepted","deliveriesCreated":1}` |
| Receiver got it | webhook.site tab | POST with body `{id, type, createdAt, data}` + `X-EventRelay-Signature` header |
| Dashboard | Deliveries page | Status `succeeded`, attempts: 1, HTTP 200 |
| Attempts | Click **Attempts** | One row: `succeeded`, HTTP 200, latency in ms |

**Headers to verify on the receiver** (webhook.site shows them):
`X-EventRelay-Event-Id`, `X-EventRelay-Delivery-Id`,
`X-EventRelay-Timestamp`, `X-EventRelay-Signature: t=…,v1=…`

## 3. Idempotency (duplicate submissions)

Repeat the exact §2 curl with the **same** `Idempotency-Key: test-happy-1`.

| Check | Expected |
|---|---|
| Response | `200` with the **same `eventId`** as before + `"deduplicated": true` |
| webhook.site | **No second request** arrives |
| Dashboard | Still exactly 1 event / 1 delivery |

Then try the **same payload with a new key** (`test-happy-2`) → new event,
second delivery. This proves dedupe is key-based, not payload-based.

## 4. Retry on failure (the reliability test)

Make the receiver fail first, succeed later. On webhook.site: **Edit →
Custom actions → Status code 500** (or use their "fail N times then succeed"
rule if available). Alternatively point the endpoint at any URL returning 500.

1. Send an event → delivery shows `retrying`, attempts ticking up
2. Watch the Attempts timeline: `retryable_failure` rows with HTTP 500
3. **Reset webhook.site to 200** → next retry (within ~5–80s) succeeds
4. Final state: `succeeded`, attempts ≥ 2, full failure history preserved

⏱️ Full exhaustion test: leave it at 500 and wait — after **6 attempts**
(~2.5 min of backoff) it becomes `failed` with `dead_lettered_at` set.

## 5. Terminal failure (no retry storm)

Point an endpoint at a URL returning **404** (webhook.site custom action,
or `https://example.com/nonexistent`).

| Check | Expected |
|---|---|
| Delivery | `failed` **immediately** after attempt 1 |
| Attempts | Exactly 1 row: `terminal_failure`, HTTP 404 — no retries |

This proves 4xx ≠ retryable (contrast with §4's 500).

## 6. Timeout test

Use a receiver that sleeps: webhook.site **Delay response** (5s+) or a
tiny local server with `setTimeout`. Set the endpoint's timeout low is
not possible via UI (default 10s) — a 15s delay should produce a
`retryable_failure` with a timeout error, then retry.

## 7. Manual replay

1. Use the `failed` delivery from §5.
2. Deliveries page → **Replay** → response 202, status `pending`
3. Attempts: old cycle-1 row preserved; new cycle-2 attempt appears
4. Click Replay again while it's running → `409` ("not in failed state")
   — proves concurrent replays can't double-fire.

## 8. Signature verification

On the receiver, verify the signature manually (Node):

```js
import crypto from 'node:crypto';
const expected = crypto.createHmac('sha256', SIGNING_SECRET)
  .update(timestamp + '.' + rawBody).digest('hex');
console.log(crypto.timingSafeEqual(
  Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'))); // true
```

`SIGNING_SECRET` = the secret from §0 step 3. Also test a **tampered**
body → verification must fail. (Or run the repo's dev receiver:
`npm run dev:receiver -- 5001 <secret>` locally against a tunnel.)

## 9. API key lifecycle

| Test | Expected |
|---|---|
| Create second key, send event with it | Works |
| Revoke first key, send event with it | `401` immediately |
| Dashboard lists keys | Prefix + last-used visible; raw key never shown again |

## 10. Endpoint management

| Test | Expected |
|---|---|
| Create endpoint with `http://…` URL (prod) | `422` |
| Create endpoint with `http://127.0.0.1/…` | `422 SSRF_BLOCKED` |
| Create with `https://example.com` ✅ | Works (SSRF checks resolve + validate IPs) |
| Delete endpoint, then check old deliveries | Deliveries still visible (soft delete — history preserved) |
| Send event after endpoint deleted | `deliveriesCreated: 0` for that endpoint |

## 11. Dashboard & stats

- **Overview:** counts match reality (events/deliveries by status), success
  rate plausible, recent failures list updates.
- **Events:** new events appear at the top, newest first.
- **Deliveries filters:** filter chips show only matching statuses.

## 12. Load test (thousands of events)

```bash
EVENTRELAY_API=$API EVENTRELAY_KEY=$KEY node scripts/load-test.js 500 20
```

Expect: `success: 500/500`, `unique eventIds: 500`, low p95 latency.
Then run with dedupe pressure:

```bash
EVENTRELAY_API=$API EVENTRELAY_KEY=$KEY LOADTEST_IDEMPOTENCY=1 node scripts/load-test.js 200 20
```

Expect: `unique eventIds: 1` + `deduplicated responses: 199` — concurrent
duplicate ingestion creates exactly one event.

## 13. Automated tests (repo)

```bash
npm test          # unit tests (shared lib, API smoke, worker) — run anywhere
```

Integration tests (register→key→ingest→idempotency) run only when
`DATABASE_URL` is set, against that real Postgres — point it at a
throwaway Neon DB, not production data. Full worker/Redis/crash drills are
in `plan.md` §14 (need local Docker or CI services).

## 14. Failure-injection checklist (advanced)

| Scenario | How to simulate | Expected outcome |
|---|---|---|
| Redis down at ingest | Point `REDIS_URL` at a dead host, restart service, ingest | Event accepted; outbox rows wait; drain on Redis return |
| Redis wiped after publish | Flush Redis, run `npm run recovery:queue` | Eligible deliveries re-enqueued; `succeeded`/`failed` untouched |
| Worker crash mid-delivery | Kill worker process during a slow delivery | Attempt → `worker_lost`; delivery retried by sweeper |
| Large receiver response | Receiver returns >64 KB body | Attempt stored truncated; worker memory bounded |

---

### Quick pass/fail summary

If §2 (happy path), §3 (idempotency), §4 (retry→success), §5 (terminal
4xx), and §7 (replay) all pass, EventRelay is working end-to-end. Everything
else is depth. 🎯
