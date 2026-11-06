# EventRelay

Reliable webhook delivery infrastructure with **at-least-once** semantics.
Producers POST events; EventRelay fans out to subscribed endpoints, signs
each delivery, retries with backoff, and keeps a full attempt history.
PostgreSQL is the source of truth — Redis/BullMQ only executes work.

See `plan.md` for the full architecture (outbox, leases, SSRF rules, recovery).

## Quick start (Docker)

```bash
cp .env.example .env   # then set JWT_SECRET + ENCRYPTION_KEY (see file for generators)
docker compose up --build
# API: http://localhost:4000/health   Dashboard: http://localhost:5173
```

## Quick start (no Docker)

Prerequisites: Node 24, Postgres 16, Redis 7 running locally.

```bash
npm install
cp .env.example .env   # set DATABASE_URL / REDIS_URL / secrets
# local dev only: allow http://localhost endpoints (SSRF allowlist, never in prod)
# add to .env: ALLOW_LOCAL_ENDPOINTS=true
npm run db:migrate
npm run db:seed        # prints a dev user + API key + signing secret
npm run dev:receiver -- 5001 <signing-secret>   # terminal 1
npm run dev:api                                 # terminal 2
npm run dev:worker                              # terminal 3
npm run dev:dispatcher                          # terminal 4
npm run dev:client                              # terminal 5 (http://localhost:5173)
```

## Ingest an event

```bash
curl -X POST http://localhost:4000/v1/events \
  -H "X-API-Key: er_live_...your-key..." \
  -H "Idempotency-Key: order-1001-1" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created","data":{"orderId":"ORD-1001","amount":1499}}'
```

## Verify signatures (receiver side)

Every delivery is signed: `X-EventRelay-Signature: t=<unix>,v1=<hex>`, where
`v1 = HMAC-SHA256(signingSecret, t + "." + rawBody)`. See
`scripts/dev-receiver.js` for a working verifier. Receivers must dedupe on
`X-EventRelay-Delivery-Id` — duplicate deliveries are expected under
at-least-once semantics.

## Recovery after a Redis wipe

Jobs that were published but lost when Redis was wiped are **not** in the
outbox anymore. Rebuild them explicitly:

```bash
npm run recovery:queue -- --dry-run   # see what would be re-enqueued
npm run recovery:queue
```

## Project layout

- `api/` — Express API (auth, endpoints, ingestion, replay, stats)
- `worker/` — BullMQ worker + outbox dispatcher + lease sweeper
- `packages/shared/` — crypto, backoff, classification, SSRF validation
- `client/` — React dashboard
- `db/` — SQL migrations + seed
- `scripts/` — queue recovery + dev webhook receiver

## Tests

```bash
npm test   # unit tests run anywhere; DB integration tests need DATABASE_URL
```
