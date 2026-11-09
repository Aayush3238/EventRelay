# EventRelay — Codebase Guide (Step by Step)

> A guided tour of this codebase in the order you should *learn* it:
> start at the entry points, follow one request end-to-end, then open each
> module. By the end you'll know what lives where and why.

---

## 0. The Big Picture (read this first)

EventRelay is a **monorepo with 4 packages** (npm workspaces, `package.json` at root):

```
EventRelay/
├── api/                  Express API server (the brain you talk to)
├── worker/               Background worker + dispatcher (the delivery muscle)
├── client/               React dashboard (what you see)
├── packages/shared/      Code shared by api + worker (crypto, retry logic…)
├── db/                   SQL schema + migration runner + seed
├── scripts/              Recovery command + dev webhook receiver
├── docker-compose.yml    Local stack: Postgres + Redis + api + worker + dispatcher + client
├── render.yaml           Free single-service deploy (Render)
├── render.paid.yaml      Paid 3-service deploy (Render)
└── plan.md               The original design document (why things are the way they are)
```

**Three running processes in production:**

| Process | File | Job |
|---|---|---|
| API | `api/src/server.js` | Auth, CRUD, event ingestion, replay, stats |
| Worker | `worker/src/worker.js` | Delivers webhooks (claim → sign → POST → record) |
| Dispatcher | `worker/src/worker.js --mode=dispatcher` | Moves outbox rows → BullMQ jobs |

**One database rule to remember:** PostgreSQL is the source of truth.
Redis/BullMQ is only a to-do list. If Redis dies, Postgres still knows
everything.

---

## 1. Start Here: The API Entry Point

**Read in this order:**

### 1.1 `api/src/server.js` (30 lines)
- Calls `env.assertLeaseSafety()` — fails fast if the delivery lease is too
  small for the max endpoint timeout (the §7.3 rule from `plan.md`).
- Starts Express on `PORT`.
- If `RUN_BACKGROUND=true`, also starts the worker + dispatcher **inside**
  the API process (the free-tier single-service trick).
- Graceful shutdown on SIGTERM/SIGINT.

### 1.2 `api/src/app.js` — the middleware pipeline
Every request flows through, top to bottom:
1. `helmet()` — security headers
2. Request-ID assignment (`X-Request-Id`, echoed back)
3. `pino-http` — structured JSON logging
4. `cors()` — only your Vercel origin allowed
5. `express.json()` (1 MB cap)
6. Global rate limiter (1000/min/IP)
7. `/health` — no auth, used by Render health checks
8. Routers: `/auth`, `/api-keys`, `/endpoints`, `/` (events), `/deliveries`, `/stats`
9. `notFound` → `errorHandler` (all errors become `{error:{code,message,requestId}}`)

### 1.3 `api/src/config/env.js`
All env vars in one place + the two production guards (lease inequality,
no `ALLOW_LOCAL_ENDPOINTS` in prod). **Read this to know every knob.**

### 1.4 `api/src/db/pool.js`
- `pool` — the `pg` connection pool (20 connections).
- `withTransaction(fn)` — **the most important helper in the codebase**:
  gives you a client inside `BEGIN…COMMIT`, rolls back on any error, always
  releases the client. Every multi-write operation uses it.

## 2. Follow One Request: `POST /v1/events`

This is the heart of the product. Trace it:

```
POST /v1/events  (X-API-Key: er_live_...)
        │
        ▼  api/src/routes/events.js
  ingestLimiter (600/min per API key)
        │
        ▼  requireApiKey  (api/src/middleware/auth.js)
  prefix lookup → SHA-256 compare (timingSafeEqual) → revoked? expired?
        │
        ▼  validate(ingestSchema)  (api/src/middleware/validate.js)
  type pattern, data is object, size checked later
        │
        ▼  ingestEvent()  (api/src/services/ingestion.js)  ← ONE transaction:
  ┌─────────────────────────────────────────────────────────┐
  │ 1. Idempotency check (SELECT … FOR UPDATE)              │
  │ 2. INSERT event                                         │
  │ 3. SELECT active endpoints subscribed to this type      │
  │ 4. INSERT delivery + outbox row per endpoint            │
  └─────────────────────────────────────────────────────────┘
        │
        ▼  202 { eventId, type, status: "accepted", deliveriesCreated: N }
```

Key ideas to absorb here:
- **Atomicity:** steps 1–4 commit together or not at all (`withTransaction`).
- **Idempotency:** same `Idempotency-Key` → returns the original event
  (`deduplicated: true`), no duplicates. Race handled via the unique index
  (`23505`) + re-select.
- **Double defence:** `UNIQUE(user_id, idempotency_key)` on events and
  `UNIQUE(event_id, endpoint_id)` on deliveries.

## 3. The Database Schema (`db/migrations/001_init.sql`)

Read the SQL top to bottom. Tables in dependency order:

| Table | Purpose | Key rule |
|---|---|---|
| `users` | Dashboard accounts | email unique |
| `api_keys` | Machine credentials | stores **hash only**, `UNIQUE(key_prefix)` |
| `endpoints` | Webhook destinations | **soft delete** (`deleted_at`), never hard-deleted |
| `endpoint_event_types` | Subscriptions | `UNIQUE(endpoint_id, event_type)` |
| `events` | Ingested events | partial unique `(user_id, idempotency_key)` |
| `deliveries` | One row per event×endpoint | `ON DELETE RESTRICT` — history is sacred |
| `delivery_attempts` | Immutable attempt log | CHECK: `in_progress | succeeded | retryable_failure | terminal_failure | worker_lost` |
| `outbox_messages` | "Jobs to enqueue" | `published_at` = broker accepted, NOT delivered |

**Counters on `deliveries` (learn these):**
- `attempt_count` — attempts in the *current* cycle (reset on replay)
- `total_attempt_count` — lifetime attempts (never reset)
- `replay_count` — manual replays; cycle number = `replay_count + 1`

**Migrations:** `db/migrate.js` applies `*.sql` files once, tracked in
`schema_migrations`. Runs automatically on Render (Dockerfile CMD).

## 4. The Other API Routes (quick tour)

| Route file | What it does | Auth |
|---|---|---|
| `routes/auth.js` | Register (bcrypt cost 12) / Login (JWT 24h) | public |
| `routes/apiKeys.js` | Create (raw key **once**), list (prefix only), revoke | JWT |
| `routes/endpoints.js` | CRUD + subscriptions (one TX), rotate secret, soft delete, **SSRF validation on save** | JWT |
| `routes/events.js` | Ingest (above) + event list/detail | API key / JWT |
| `routes/deliveries.js` | List/detail + attempts, **failed-only replay** | JWT |
| `routes/stats.js` | Overview counts + success rate + recent failures | JWT |

**Replay** (`deliveries.js`) is a single atomic statement:
`UPDATE … SET status='pending', attempt_count=0 … WHERE id=$1 AND status='failed'`
+ outbox insert. 0 rows → `409`. That's why concurrent replays can't
double-fire — no `SELECT FOR UPDATE` needed.

## 5. Shared Library (`packages/shared/`) — Used by API + Worker

| File | What it is |
|---|---|
| `src/crypto.js` | SHA-256 API-key hashing, AES-256-GCM secret encrypt/decrypt, HMAC signing (`t + "." + rawBody`), key/secret generators |
| `src/backoff.js` | Full-jitter exponential backoff + `Retry-After` parsing |
| `src/classify.js` | One pure function: outcome → `succeeded \| retryable_failure \| terminal_failure` |
| `src/ssrf.js` | The security brain: resolves hostnames, validates **every** IP (incl. IPv4-mapped IPv6), pinned DNS lookup anti-rebinding, local-dev allowlist |
| `src/index.js` | Single import surface (`@eventrelay/shared`) |

**Why shared?** SSRF validation must behave *identically* at endpoint-save
time (API) and delivery time (worker). Two copies would drift.

## 6. The Worker (`worker/src/`) — Where Delivery Happens

### 6.1 `queue.js` + `config.js` + `db.js`
BullMQ `Queue('deliveries')` + ioredis (`maxRetriesPerRequest: null` —
required by BullMQ). Worker's own pg pool.

### 6.2 `dispatcher.js` — outbox → queue (the only `queue.add()` caller)
```
loop:
  claim due rows (available_at <= NOW(), lease free)
    SELECT … FOR UPDATE SKIP LOCKED  + set lock_token/locked_until
  queue.add('deliver', {deliveryId, outboxId}, { jobId: "outbox_<id>" })
  mark published WHERE lock_token = ours   ← stale dispatchers can't lie
```
- `jobId = outbox_<outboxId>`: re-publishing the *same* row dedupes;
  retries/replays are *new rows* → new job IDs. Job IDs are a dedupe
  optimization, **not** correctness (the DB claim is).
- Crash between `queue.add` and mark-published → re-publish → same jobId →
  harmless.

### 6.3 `delivery.js` — the delivery engine (read this carefully)
```
1. CLAIM (one TX): UPDATE deliveries … SET status='processing',
   lock_token=<new>, locked_until=NOW()+lease, attempt_count+1,
   total_attempt_count+1 … WHERE claimable RETURNING *
   + INSERT in_progress attempt row     ← all atomic
2. Load event + endpoint (no TX open)
3. SSRF re-validate + pinned lookup
4. Build body, decrypt secret, HMAC sign
5. HTTP POST (httpClient.js)           ← NO DB transaction open here
6. FINALIZE (TX, lock_token guarded):
   - stale worker (0 rows) → discard everything, write nothing
   - success → succeeded
   - retryable + attempts left → retrying + NEW outbox row (same TX)
   - else → failed / dead_lettered
```

### 6.4 `httpClient.js` — why raw `http`/`https`, not `fetch`
Custom `lookup` (pinned to SSRF-validated IPs), byte-capped response
reading (64 KB), per-endpoint timeout, **never follows redirects**.

### 6.5 `sweeper.js` — crash recovery
Every 15s: expired `processing` leases → finalize their `in_progress`
attempt as **`worker_lost`** → delivery back to `retrying` (+ outbox row)
or `failed` if attempts exhausted. In one TX per batch.

### 6.6 `worker.js` — entry point
`--mode=dispatcher` → dispatcher only; default → BullMQ Worker + sweeper.
Exports `startWorker()` so the API can embed it (`RUN_BACKGROUND=true`).

## 7. Ops Scripts (`scripts/`)

| File | What it does |
|---|---|
| `recover-queue.js` | After a Redis wipe: re-enqueues `pending`/`retrying`/expired-`processing` deliveries as `delivery.recovery` outbox rows. `--dry-run` previews. Idempotent. |
| `dev-receiver.js` | Local webhook receiver that verifies HMAC signatures. `npm run dev:receiver -- 5001 <secret>` |

## 8. The Frontend (`client/src/`)

```
main.jsx      React + Router + QueryClient bootstrap
index.css     Tailwind + Inter/JetBrains Mono + motion (reveal, log, marquee)
lib/api.js    Axios instance: attaches JWT + X-Request-Id to every call,
              redirects to /login on 401
App.jsx       Everything else (single-file dashboard):
  - Landing (public, /)      scroll sections, scroll-spy nav
  - Register / Login         split-screen auth (AuthLayout)
  - Shell                    dark sidebar + sticky header
  - Dashboard                stat cards, pipeline strip, recent failures
  - Events / Deliveries      dense tables, status badges, attempt timeline,
                             filter chips, Replay button
  - Endpoints / API Keys     CRUD forms, one-time secret displays
```

**Data flow rule:** components never fetch directly — they use React Query
(`useQuery` for reads, `useMutation` + `invalidateQueries` for writes).
The browser **never** touches Postgres/Redis; only the API.

**Routing:** `/` landing (logged-in users get an "Open dashboard" button),
`/dashboard`, `/events`, `/deliveries`, `/endpoints`, `/api-keys` (protected),
`/register` (first-visit landing for new users), `/login`.

## 9. Infrastructure

| File | What it is |
|---|---|
| `docker-compose.yml` | Local stack: Postgres 16, Redis 7, api, worker, dispatcher, client — all with healthchecks |
| `api/Dockerfile` / `worker/Dockerfile` / `client/Dockerfile` | Node 24-alpine images; api CMD runs migrations then server |
| `render.yaml` | **Free** deploy: ONE web service, `RUN_BACKGROUND=true` (API+worker+dispatcher in one process) |
| `render.paid.yaml` | **Production** deploy: 3 services (api free web, worker + dispatcher starter) |
| `client/vercel.json` | SPA rewrite (client-side routing on refresh) |
| `.env` / `.env.example` | Local secrets (gitignored) / template. Key vars: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `DELIVERY_LEASE_MS`, `ALLOW_LOCAL_ENDPOINTS` |

**Deploy order:** backend first (Render) → note API URL → frontend
(Vercel, `VITE_API_URL`) → set `CLIENT_URL` on Render to the Vercel URL →
redeploy API (CORS). Full guide: `DEPLOYMENT.md`.

## 10. Key Flows (memorize these three)

**A. Happy path**
`curl POST /v1/events` → auth → validate → TX(event+deliveries+outbox) →
dispatcher → BullMQ → worker claim → sign → POST → finalize `succeeded` →
dashboard shows it.

**B. Failure + retry**
Receiver 500 → attempt `retryable_failure` → finalize sets `retrying`,
`next_attempt_at = now + backoff`, inserts `delivery.retry` outbox row →
dispatcher publishes when due → worker claims again → … → success or
`failed` (dead-lettered).

**C. Worker crash**
Worker claims (lease 100s) → posts → **dies before finalize** → lease
expires → sweeper marks attempt `worker_lost`, re-enqueues → delivery
retries. Receiver may get a duplicate — dedupe on delivery ID.

## 11. Tests (`__tests__/`)

| Suite | Covers | Needs |
|---|---|---|
| `packages/shared/__tests__/` | crypto, backoff, classify, SSRF range table (34 tests) | nothing |
| `api/__tests__/` | health, validation, 404s + gated DB integration | Postgres for integration |
| `worker/__tests__/` | classification contract, jobId format (no colons) | nothing |

Run: `npm test`. Integration tests use real Postgres (never pg-mem for
locking claims — see `plan.md` §14).

## 12. Suggested Reading Order (your learning path)

1. `plan.md` §1–3 — product vision + architecture (why)
2. `db/migrations/001_init.sql` — the data model (what)
3. `api/src/services/ingestion.js` — the core transaction (how events enter)
4. `worker/src/delivery.js` — the core delivery loop (how events leave)
5. `worker/src/dispatcher.js` + `sweeper.js` — outbox & recovery (how it survives failure)
6. `packages/shared/src/ssrf.js` — the security model
7. `api/src/routes/*.js` — the REST surface
8. `client/src/App.jsx` — the UI (last; it's a view over the APIs)
9. `DEPLOYMENT.md` + `USER_MANUAL.md` — operating it as a user/operator

---

*End of guide. When in doubt, trace a request: API route → service →
SQL → outbox → dispatcher → worker → receiver. Everything in this codebase
exists to make that path reliable.*
