# EventRelay — Implementation Plan

> **Project:** EventRelay — Reliable Webhook Delivery & Event Processing Infrastructure  
> **Core Principle:** At-Least-Once Delivery. PostgreSQL is the source of truth; Redis/BullMQ is only an execution/scheduling aid.  
> **Stack:** JavaScript only (no TypeScript), Node.js + Express, PostgreSQL (`pg`), Redis + BullMQ, React + Vite, Docker Compose.
> **Status:** Revised for correctness, reliability, and security — ready for M0.

---

## Table of Contents

1. [Product Vision & Reliability Goals](#1-product-vision--reliability-goals)
2. [Technology Stack & Version Pinning](#2-technology-stack--version-pinning)
3. [System Architecture](#3-system-architecture)
4. [Database Design & Migrations](#4-database-design--migrations)
5. [Event Ingestion Pipeline](#5-event-ingestion-pipeline)
6. [Transactional Outbox & Queue Processing](#6-transactional-outbox--queue-processing)
7. [Webhook Delivery Engine](#7-webhook-delivery-engine)
8. [Retry Mechanism & Failure Classification](#8-retry-mechanism--failure-classification)
9. [API Specification](#9-api-specification)
10. [Authentication, Authorization & Security](#10-authentication-authorization--security)
11. [Frontend Dashboard](#11-frontend-dashboard)
12. [Project Structure](#12-project-structure)
13. [Infrastructure, Docker & Deployment](#13-infrastructure-docker--deployment)
14. [Testing Strategy](#14-testing-strategy)
15. [Observability & Operations](#15-observability--operations)
16. [Build Order / Milestones](#16-build-order--milestones)
17. [Risks, Trade-offs & Non-Goals](#17-risks-trade-offs--non-goals)
18. [Architectural Revisions](#18-architectural-revisions)

---

## 1. Product Vision & Reliability Goals

### 1.1 What EventRelay Does

Developers register webhook endpoints + subscribe them to event types. Producers (`POST /v1/events` with an API key) submit events. EventRelay:

1. Persists the event + one `delivery` per matching endpoint **atomically** in PostgreSQL.
2. Enqueues delivery work via a **transactional outbox** so a Redis outage never loses work.
3. Workers claim deliveries with expiring leases, sign + POST to endpoints, record **every attempt**, and retry with backoff until success or dead-letter.
4. Operators can inspect attempts and **manually replay** failed deliveries.

### 1.2 Scenario Coverage (Acceptance Criteria)

| Scenario | Handling |
|---|---|
| Receiver temporarily unavailable / 500 / timeout | Retryable → exponential backoff + jitter, up to `max_attempts` |
| Producer retries / double-submit | `Idempotency-Key` → unique `(user_id, idempotency_key)`; return existing event, create no duplicates |
| Receiver gets same delivery twice | Expected under at-least-once; receivers dedupe on `X-EventRelay-Delivery-Id` / `X-EventRelay-Event-Id`; document this |
| Redis unavailable at ingest time | Event + deliveries + outbox rows already committed in Postgres; dispatcher publishes later |
| Redis wiped **after** successful publication | Explicit recovery command (§6.4) republishes eligible `pending`/`retrying`/expired-`processing` deliveries as new outbox rows; delivery/attempt history untouched |
| Worker crashes mid-delivery | `processing` lease (`locked_until` + `lock_token`) expires → sweeper finalizes abandoned attempt as `worker_lost` (§7.2) → delivery becomes claimable; no transaction held during HTTP call |
| Thousands of events at once | Stateless API, pooled `pg`, BullMQ concurrency + rate limiting, `SKIP LOCKED` claiming |
| Replay of failed delivery | `POST /v1/deliveries/:id/replay` (**failed-only in v1**) → new attempt cycle, reset `attempt_count`, preserve history (§8.5) |
| 4xx from receiver | Terminal `failed` (configurable), no silent retry storm |
| SSRF via DNS / redirect to private IP | Hostname resolved and **every** IPv4/IPv6 address validated at endpoint save **and** at delivery time with a pinned lookup (§10.1) |
| Worker crashes after sending webhook but before finalizing DB | Attempt remains `in_progress`; sweeper finalizes it as `worker_lost` (§7.2). A duplicate delivery may follow — at-least-once requires receiver dedupe (§7.6) |

### 1.3 Explicit Non-Claims

- **No exactly-once delivery.** Duplicates are possible — including when a worker crashes after the HTTP request succeeded remotely but before the DB finalize. Receivers must dedupe on `X-EventRelay-Delivery-Id`.
- Postgres is authoritative; BullMQ job loss must never mean data loss. BullMQ job IDs are a **deduplication optimization only**, not the source of delivery correctness (§6.3).

---

## 2. Technology Stack & Version Pinning

**Rule: JavaScript only everywhere** — backend, worker, frontend, tests, scripts. No TypeScript build step.

### 2.1 Backend / Worker

| Package | Purpose | Notes |
|---|---|---|
| `express` ^5.1 | HTTP API | Current stable major; only web framework |
| `pg` ^8.13 | Postgres client | `Pool` + explicit transactions; no ORM |
| `bullmq` ^5.58 | Queue (immediate-execution jobs; **no BullMQ `delay`** — Postgres `available_at` is authoritative, §6.3) | Requires Redis ≥ 6; compatible with Node 22/24 |
| `ioredis` ^5.7 | Redis client (BullMQ peer) | `maxRetriesPerRequest: null` for BullMQ |
| `jsonwebtoken` ^9.0 | JWT auth | Access tokens for dashboard |
| `bcryptjs` ^3.0 | **User password hashing only** (cost 12) | Pure JS, no native build. **Not** used for API keys (§10) |
| `zod` ^3.25 | Request validation | All inputs; shared schemas where possible |
| `pino` ^9.7 + `pino-http` ^10.5 | Structured logging | JSON in prod, pretty in dev; `requestId` propagation |
| `helmet` ^8.0 | Security headers | |
| `express-rate-limit` ^8.0 | Rate limiting | Per-IP + per-API-key |
| `swagger-ui-express` ^5.0 | OpenAPI docs | Serve at `/docs`; spec in `openapi.yaml` |
| `node:crypto` | HMAC-SHA256 signing, AES-256-GCM secret encryption, SHA-256 API-key hashing, `crypto.randomUUID()` / `randomBytes` | No extra dep |
| `dotenv` ^17.0 | Env loading | |
| `cors` ^2.8 | Dashboard CORS | Lock to frontend origin |

### 2.2 Frontend

| Package | Purpose |
|---|---|
| `react` ^19.1 + `react-dom` ^19.1 | UI (current stable major) |
| `vite` ^7.1 | Dev server / build |
| `react-router-dom` ^7.6 | Routing |
| `@tanstack/react-query` ^5.74 | Server state (events, deliveries, endpoints) |
| `axios` ^1.12 | API client (interceptors: auth header, request-id) |
| `tailwindcss` ^4.1 + `@tailwindcss/vite` ^4.1 | Styling (CSS-first config) |
| `lucide-react` ^0.525 | Icons |

### 2.3 Testing / Tooling

`jest` ^30, `supertest` ^7, `eslint` ^9, `prettier` ^3, `nodemon` (dev). Integration tests use **real PostgreSQL and Redis** (CI services / Docker Compose) — `pg-mem`/mocked Redis only for fast unit subsets, never for locking/transaction/idempotency tests (§14).

### 2.4 Version Policy

- Node **24 LTS (Active)** — pin via `engines: { "node": ">=24 <25" }` and `.nvmrc`/`Dockerfile FROM node:24-alpine`. Node 20 is EOL; do not use it. Node 22 LTS is acceptable as fallback, but target 24.
- Pin major versions in `package.json` (`^` ranges); commit `package-lock.json`.
- Document the version matrix + Node 24 LTS in README.
- No extra frameworks (no Nest/Fastify/etc.), no ORM, no TypeScript.

---

## 3. System Architecture

```
                        ┌─────────────────────────────────────────────┐
 Producer ──API Key──▶  │  API Server (Express, stateless)            │
                        │  Auth · Endpoints · Events · Replay · Stats │
                        └───────┬──────────────────┬──────────────────┘
                                │ 1 TX: event+deliveries+outbox         │ 2 Reads/writes (dashboard)
                                ▼                                      ▼
                        ┌─────────────────────────────────────────────┐
                        │          PostgreSQL (source of truth)       │
                        │  users·api_keys·endpoints·events·deliveries │
                        │  delivery_attempts·outbox_messages          │
                        └───────▲──────────────────▲──────────────────┘
                                │ SKIP LOCKED claim│ lease claim
              ┌─────────────────┴───┐      ┌───────┴──────────────┐
              │ Outbox Dispatcher   │ jobs │   Worker(s) (BullMQ) │
              │ (separate process)  │─────▶│  Claim → Sign → POST │
              │ poll available_at   │ Redis│  Record → Finalize   │
              └─────────────────────┘      │  (lock-token guarded)│
                                           └──┬──────────┬────────┘
                                              │          │ expiry
                                  Recovery cmd│sweeper   ▼ HTTPS POST
                                     (§6.4)     │   Receiver endpoints
                                              ▼
                                    new delivery.recovery
                                    outbox row → dispatcher
```

### 3.1 Component Responsibilities

**A. API Server** (process: `npm run start:api`)

- JWT auth (dashboard), API-key auth (event ingestion + programmatic access)
- Endpoint / subscription / API-key CRUD
- `POST /v1/events` — **single-transaction** fan-out (see §5)
- Delivery history, attempts, stats/aggregations
- Manual replay, event inspection
- Validation (Zod), rate limiting, Helmet, Pino logging, OpenAPI docs

**B. Background Worker** (process: `npm run start:worker`, independent of API)

- Consumes BullMQ `deliveries` queue (immediate jobs only)
- Atomic claim via `lock_token` + `locked_until` lease, including `in_progress` attempt insert in the **same TX** (§7.1)
- Signs + POSTs with bounded timeout / `AbortController`; **no DB transaction held during HTTP** (§7.3)
- Finalizes attempts with lock-token guard; classifies outcome (success / retryable / terminal)
- Enqueues retry by inserting a new outbox row (`available_at = next_attempt_at`) in the finalize TX (§6.3)
- **Recovery sweeper:** periodically finalizes expired-lease deliveries as `worker_lost` and re-enqueues via outbox (§7.2)

**C. Outbox Dispatcher** (separate process `npm run start:dispatcher`)

- Polls **due** rows: `published_at IS NULL AND available_at <= NOW()` AND lease free/expired
- Claims with `SELECT ... FOR UPDATE SKIP LOCKED`, sets `lock_token` + `locked_until` in a short TX (§6.2)
- Adds BullMQ jobs with `jobId = outbox_<outboxId>` (§6.3)
- Marks `published_at` **only** on guarded update (`WHERE lock_token = ours AND locked_until > NOW()`); `published_at` means **"successfully enqueued in Redis"**, not delivery success (§6.2)

**D. Recovery Command** (ops process: `npm run recovery:queue` / `node scripts/recover-queue.js`)

- Republishes eligible deliveries after a Redis wipe: creates `delivery.recovery` outbox rows for `pending`/`retrying` deliveries and expired-`processing` leases (§6.4)

**E. React Dashboard** (SPA, Vite)

- Communicates **only** via REST. Never touches Postgres/Redis.
- Pages: Login, Dashboard (stats), Events (list + detail + payload viewer), Deliveries (list, filters by status/endpoint/type, attempt timeline), Endpoints (CRUD + subscriptions + signing-secret management), API Keys (create once-display, revoke).

### 3.2 Key Architecture Decisions

- **No Redis as system of record.** If Redis is wiped, unpublished outbox rows drain automatically; *published* rows are lost — those deliveries are recovered only via the explicit recovery command (§6.4).
- **PostgreSQL `available_at` is the sole retry scheduler.** BullMQ jobs are always immediate (`delay: 0`); the dispatcher publishes a row only when `available_at <= NOW()`. There is exactly one scheduling mechanism, so no ambiguity between DB due-time and queue delay.
- **No DB transaction held across HTTP calls.** Short claim TX → HTTP outside TX → short finalize TX (guarded by `lock_token`).
- **Stateless API** → horizontal scale behind any load balancer; sticky sessions not required.

---

## 4. Database Design & Migrations

### 4.1 Migration Approach

- Plain SQL migration files: `db/migrations/001_init.sql`, `002_indexes.sql`, ... run by a small `migrate.js` script (`node db/migrate.js`) using `pg`; track applied files in `schema_migrations` table.
- Seeds: `db/seed.js` (dev only) — demo user, endpoint, sample events.
- All timestamps `TIMESTAMPTZ`; IDs `UUID` generated in app (`crypto.randomUUID()`). HTTP IDs are the raw UUIDs (no synthetic `evt_`/`dlv_` prefixes — this avoids prefix/lookup mismatches; document that UUIDs are the public IDs).

### 4.2 Tables (DDL Summary)

Foreign keys on history-bearing tables use `ON DELETE RESTRICT` (never `CASCADE`) so historical records cannot be destroyed by deletion. Endpoints are **soft-deleted** (see below).

**`users`** — `id UUID PK, name TEXT NOT NULL, email CITEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at, updated_at`

**`api_keys`** — `id UUID PK, user_id FK→users ON DELETE CASCADE, name TEXT, key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL, last_used_at, expires_at, created_at, revoked_at`
- Raw key format: `er_live_<22-char random base64url>` (~132 bits entropy). `key_prefix` = the **first 16 characters of the full raw key** (`er_live_XXXXXXXX`, including the `er_live_` marker and 8 random chars) — meaningful, display-safe, and unique. `UNIQUE(key_prefix)` — lookup finds at most one row; collisions regenerate the key (astronomically unlikely but retried on 23505).
- `key_hash` = `SHA-256(raw key)` hex. API keys are high-entropy (not human passwords), so a fast deterministic hash is correct and avoids a `bcrypt.compare` per ingestion request. Compare with `crypto.timingSafeEqual` on the digests (§10).
- Raw key shown **once** at creation.

**`endpoints`** — `id UUID PK, user_id FK→users ON DELETE CASCADE, name TEXT, url TEXT NOT NULL, signing_secret_encrypted TEXT NOT NULL, is_active BOOL DEFAULT TRUE, deleted_at TIMESTAMPTZ, timeout_ms INT DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000), max_attempts INT DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20), created_at, updated_at`
- **Soft delete:** `DELETE /endpoints/:id` sets `deleted_at = NOW(), is_active = false`. The row is **never** hard-deleted when deliveries reference it — `deliveries.endpoint_id` FK is `ON DELETE RESTRICT`. List queries filter `deleted_at IS NULL`; delivery-history joins still resolve the endpoint. Fan-out (§5) only matches `is_active AND deleted_at IS NULL`.
- `signing_secret_encrypted`: AES-256-GCM ciphertext (`iv:authTag:ciphertext`, base64) using `ENCRYPTION_KEY` (32 bytes, base64) from env. **Never** returned by list/get APIs.
- Endpoint URL validity is enforced by SSRF-aware validation (§10.1), not string format alone.

**`endpoint_event_types`** — `id UUID PK, endpoint_id FK→endpoints ON DELETE CASCADE, event_type TEXT NOT NULL, UNIQUE(endpoint_id, event_type)`
- Defines subscriptions. Endpoint edit = replace set in one TX. Cascade here is safe: subscriptions are config, not history.

**`events`** — `id UUID PK, user_id FK→users ON DELETE RESTRICT, idempotency_key TEXT, event_type TEXT NOT NULL, payload JSONB NOT NULL, created_at`
- `UNIQUE(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL` (partial unique index).
- Payload size guard (≤ 256 KB serialized) enforced in validation.

**`deliveries`** — `id UUID PK, event_id FK→events ON DELETE RESTRICT, endpoint_id FK→endpoints ON DELETE RESTRICT, status TEXT CHECK IN ('pending','processing','retrying','succeeded','failed'), attempt_count INT DEFAULT 0, total_attempt_count INT DEFAULT 0, replay_count INT DEFAULT 0, next_attempt_at TIMESTAMPTZ, locked_until TIMESTAMPTZ, lock_token TEXT, last_response_status INT, last_error TEXT, created_at, updated_at, succeeded_at, dead_lettered_at`

Counter semantics (consistent everywhere — §7.1, §8.4):
- `attempt_count` = attempts **started in the current cycle**. Reset to `0` on replay; incremented **inside the claim TX** when an attempt starts.
- `total_attempt_count` = lifetime attempts started across all cycles. **Never reset**, including on replay.
- `replay_count` = number of successful manual replays; current cycle number = `replay_count + 1`.

- `UNIQUE(event_id, endpoint_id)` — one delivery per (event, endpoint).
- `failed` = permanently failed / dead-lettered (terminal for the current cycle). `dead_lettered_at` records when.
- History preservation: nothing in the app issues `DELETE` against `deliveries`, `delivery_attempts`, or `events`. Retention (§4.5) is the only removal path.

**`delivery_attempts`** — `id UUID PK, delivery_id FK→deliveries ON DELETE RESTRICT, cycle_number INT NOT NULL, attempt_number INT NOT NULL, status TEXT CHECK IN ('in_progress','succeeded','retryable_failure','terminal_failure','worker_lost'), request_timestamp TIMESTAMPTZ, response_status INT, response_body TEXT, response_time_ms INT, error_message TEXT, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ`

Attempt state machine (see §7.1 for full lifecycle):

| Status | Meaning | `completed_at` |
|---|---|---|
| `in_progress` | Worker claimed the delivery and started this attempt; HTTP in flight or not yet finalized | NULL |
| `succeeded` | Receiver returned 2xx | set |
| `retryable_failure` | Network error / timeout / 408 / 425 / 429 / 5xx — retry scheduled | set |
| `terminal_failure` | Other 4xx / inactive endpoint / non-retryable config error | set |
| `worker_lost` | Lease expired before finalize (worker crashed or is a stale worker); written by sweeper | set |

- **Immutability:** an attempt row may only be updated while `status = 'in_progress'`; every finalize/finalize-as-lost `UPDATE` includes `WHERE status = 'in_progress'`. Once finalized, rows are append-only history. (Enforce in application code + a migration comment; a DB trigger rejecting updates to finalized rows is an optional hardening — M5.)
- Cap stored `response_body` (first 8 KB); truncated responses are noted in `error_message`. Response reading is bounded (§10.1).
- `request_timestamp` = timestamp sent in the signing header; `started_at` ≈ claim time.

**`outbox_messages`** — `id UUID PK, message_type TEXT NOT NULL CHECK IN ('delivery.created','delivery.retry','delivery.replay','delivery.recovery'), aggregate_id UUID NOT NULL (delivery id), available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), published_at TIMESTAMPTZ, attempts INT NOT NULL DEFAULT 0, lock_token TEXT, locked_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `published_at` means **BullMQ accepted the job** (broker enqueue succeeded). It does **not** mean the webhook was delivered. A delivery can be `succeeded` while an older outbox row is (rarely) still unpublished, and vice versa.
- `lock_token` + `locked_until`: publisher lease, same pattern as deliveries — guards against stale dispatchers (§6.2).
- One row per enqueue intent. Initial delivery, each retry, each replay, and each recovery republish each create a **new** row with its own ID (and therefore its own `jobId`), apart from duplicate publication of the *same* row (§6.3).

### 4.3 Indexes

- `events(user_id, created_at DESC)`, `events(event_type)`, partial unique `events(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
- `deliveries(endpoint_id)`, `deliveries(event_id)`, `deliveries(status, next_attempt_at)`, `deliveries(status, locked_until)`, `deliveries(created_at DESC)`
- `delivery_attempts(delivery_id, started_at)`
- `endpoint_event_types(event_type, endpoint_id)` — fast fan-out lookup
- Partial `outbox_messages(available_at, created_at) WHERE published_at IS NULL`
- `UNIQUE api_keys(key_prefix)`, `api_keys(user_id)`
- `endpoints(user_id) WHERE deleted_at IS NULL`

### 4.4 Transaction Rules

- Multi-row writes (ingest fan-out, endpoint+subscriptions edit, replay reset, recovery republish, sweeper finalize+re-enqueue) run in **one** `BEGIN/COMMIT` via a `withTransaction(fn)` helper.
- Ingest uses `INSERT ... ON CONFLICT DO NOTHING` + re-select for idempotency short-circuit.
- No external HTTP (or Redis) inside transactions, with one deliberate exception: the dispatcher inserts BullMQ jobs **between** two short DB transactions — the claim TX, then (outside any TX) `queue.add`, then a guarded mark-published TX. The outbox row remains unpublished if anything between fails, so the next poll retries. This ordering is the outbox pattern itself.
- Locking: `SELECT ... FOR UPDATE SKIP LOCKED` for dispatcher claims; single-row `UPDATE ... WHERE <lease conditions> RETURNING` for delivery claims (atomic claim primitive).

### 4.5 Retention & Archival Policy (history preservation)

- **No cascade deletes** of `events`/`deliveries`/`delivery_attempts` from user or endpoint deletion. Endpoint deletion is soft (§4.2). User deletion: v1 does not offer account deletion; if added later, anonymize rather than hard-delete while history exists.
- **Retention:** `delivery_attempts.response_body` is truncated at write; full payloads older than **90 days** move to cold archival storage (documented SQL export + `DELETE` in a maintenance job run by ops, never by API code paths). `deliveries`/`events` older than **365 days** are eligible for archival under the same procedure. Archival is manual/ops-run with a pre-run count report — never automatic destructive behavior without operator confirmation.
- Operators can always answer "what happened to event X" from Postgres alone, independent of Redis.

---

## 5. Event Ingestion Pipeline

### 5.1 Endpoint

```
POST /v1/events
Headers: X-API-Key: <raw key>            (required)
         Idempotency-Key: <client key>   (optional)
Body:    { "type": "order.created", "data": { ... } }
```

### 5.2 Validation (Zod, before any DB write)

- Authenticate API key: extract `key_prefix` (first 16 chars of presented key) → `SELECT ... WHERE key_prefix = $1` → `SHA-256(presented)` compared via `timingSafeEqual` → check `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`; update `last_used_at` (best-effort, outside main TX).
- `type`: non-empty string, max ~200 chars, allowed-charset pattern.
- `data`: required JSON object; serialized size ≤ limit (default 256 KB).
- Reject unknown/extra top-level fields.

### 5.3 Workflow (single transaction)

```
BEGIN;
  -- Idempotency check (if Idempotency-Key present)
  SELECT id FROM events WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE;
  IF found → ROLLBACK; RETURN existing result (eventId, deliveriesCreated=count of its deliveries, deduplicated=true)

  INSERT INTO events (id, user_id, idempotency_key, event_type, payload)
  VALUES (...) RETURNING id;

  -- Fan-out: active, non-deleted endpoints subscribed to this type, owned by this user
  SELECT e.id FROM endpoints e
  JOIN endpoint_event_types eet ON eet.endpoint_id = e.id
  WHERE e.user_id=$1 AND e.is_active AND e.deleted_at IS NULL AND eet.event_type=$2;

  FOR each endpoint:
    INSERT INTO deliveries (id, event_id, endpoint_id, status='pending') ON CONFLICT DO NOTHING;
    INSERT INTO outbox_messages (id, message_type='delivery.created', aggregate_id=delivery_id,
                                 available_at=NOW());

COMMIT;
```

### 5.4 Response

```json
{ "eventId": "<uuid>", "type": "order.created", "status": "accepted", "deliveriesCreated": 3 }
```

- Duplicate submission → same shape with existing `eventId` and original `deliveriesCreated`; HTTP 200 with `deduplicated: true`. Never 500, never partial duplicates.
- If TX fails → nothing persisted. Return 500 with `requestId`; producer may safely retry (idempotency key makes retry safe).

### 5.5 Concurrency Notes

- Two racing submissions with the same idempotency key: the unique index serializes them; loser blocks on `FOR UPDATE` / hits unique-violation → re-select path. Covered by a **real-Postgres** concurrency test (§14) — not `pg-mem`.
- `UNIQUE(event_id, endpoint_id)` on deliveries is the second line of defense.

---

## 6. Transactional Outbox & Queue Processing

### 6.1 Why (Failure Mode Prevented)

DB commit succeeds but Redis is down → naive `queue.add()` after commit loses the job forever until the recovery command runs. The outbox makes the DB commit **include** the intent to enqueue; the dispatcher retries until Redis accepts it.

### 6.2 Dispatcher Algorithm (with lock token)

Loop (poll every ~500 ms–1 s, or `LISTEN/NOTIFY` enhancement later). No Redis `delay` is ever used — only rows with `available_at <= NOW()` are picked up (§3.2).

```
-- Short claim TX
BEGIN;
  SELECT id, aggregate_id FROM outbox_messages
  WHERE published_at IS NULL AND available_at <= NOW()
    AND (locked_until IS NULL OR locked_until < NOW())
  ORDER BY available_at, created_at LIMIT 50
  FOR UPDATE SKIP LOCKED;
  UPDATE outbox_messages
  SET locked_until = NOW() + interval '30 seconds',
      lock_token = $dispatcherToken, attempts = attempts + 1
  WHERE id = ANY($claimedIds);
COMMIT;

-- Outside any TX, per claimed message:
TRY:
  await queue.add('deliver', { deliveryId: aggregate_id, outboxId: id },
                  { jobId: `outbox_${id}` });           -- §6.3
  -- Guarded mark (stale-dispatcher protection):
  UPDATE outbox_messages
  SET published_at = NOW(), lock_token = NULL, locked_until = NULL
  WHERE id = $1 AND lock_token = $dispatcherToken AND locked_until > NOW();
  -- 0 rows ⇒ we lost the lease (another dispatcher re-published); harmless.
CATCH (Redis down):
  UPDATE outbox_messages SET lock_token = NULL, locked_until = NULL WHERE id = $1;
  log error; continue;  -- row stays unpublished; next poll retries
```

- `SKIP LOCKED` → multiple dispatchers safe.
- `lock_token` guard → a slow dispatcher whose lease expired cannot mark a row published after another dispatcher took over. If it already enqueued before losing the lease, both dispatches produce the **same** `jobId` (§6.3), so BullMQ dedupes them and the worker claim (§7.1) is idempotent anyway.
- **Dispatcher crash after `queue.add` but before mark-published:** row remains unpublished → next poll re-publishes → same `jobId` → duplicate is collapsed by BullMQ; if a duplicate job still executes, the worker's atomic claim makes it a no-op. This is tested explicitly (§14).
- `published_at` semantics: broker accepted the job. Delivery success is tracked on `deliveries`/`delivery_attempts`, never on the outbox row.

### 6.3 BullMQ Job IDs and Scheduling (single mechanism)

- **Job ID format:** `outbox_<outboxId>` (e.g. `outbox_3f4a…`). No colons (BullMQ custom IDs must not contain `:`; keep to `[A-Za-z0-9_-]`), no delivery-only derivation.
- Each `delivery.created` / `delivery.retry` / `delivery.replay` / `delivery.recovery` outbox row has its own UUID → each intent gets a **distinct** job ID. A retry of delivery X never collides with delivery X's initial job.
- Re-publication of the **same** outbox row (crash recovery, duplicate dispatcher) reuses the **same** `jobId` → BullMQ dedupes the duplicate `add`.
- Scheduling: jobs are added with **zero delay** once due. `available_at` in Postgres is the only scheduler; `next_attempt_at` on the delivery is set (for observability/next-due queries) but the outbox row's `available_at` is what the dispatcher actually polls. This removes the previous ambiguity between "dispatcher delay polling" and "BullMQ delayed jobs".
- **Job IDs are a deduplication optimization only.** Correctness rests on: outbox durability (Postgres), idempotent dispatcher re-publish, and the worker's atomic claim + lock-token-guarded finalize. Even if two jobs for the same delivery execute, only one claim wins.

### 6.4 Redis-Outage and Redis-Wipe Recovery

Two distinct cases:

**Case A — Redis down, then back (no data loss):** unpublished outbox rows accumulate; dispatcher logs + backs off; alert on unpublished age > threshold. After Redis returns, the dispatcher drains the backlog automatically. No manual action.

**Case B — Redis wiped / queue data lost (published jobs gone):** outbox rows for those jobs already have `published_at` set, so the dispatcher will never re-publish them. Recovery requires an **explicit operator command**:

```
npm run recovery:queue            # node scripts/recover-queue.js [--dry-run]
```

Algorithm (batched, in transactions):

```
For deliveries in batches of 500 where:
  status IN ('pending','retrying')
  OR (status = 'processing' AND locked_until < NOW())
  -- terminal states succeeded/failed are NOT republished
AND NOT EXISTS (SELECT 1 FROM outbox_messages o
                WHERE o.aggregate_id = deliveries.id AND o.published_at IS NULL):
  BEGIN;
    -- if expired-processing: finalize its in_progress attempt as worker_lost (§7.2)
    INSERT INTO outbox_messages (id, message_type='delivery.recovery',
                                 aggregate_id=delivery_id, available_at=NOW());
    -- reset lease so the delivery is claimable; keep attempt_count/counters intact
    UPDATE deliveries SET locked_until = NULL, lock_token = NULL
    WHERE id = delivery_id;
  COMMIT;
```

- Preserves `deliveries`, `delivery_attempts` (including `worker_lost` rows), counters, and `attempt_count` semantics — recovery never resets history. `attempt_count` is unchanged; the new attempt increments it normally when claimed.
- Idempotent: safe to re-run; rows already covered by an unpublished outbox row are skipped.
- `--dry-run` prints eligible counts (by status) without writing.
- **Automated reconciliation (later enhancement, not v1):** a scheduled job comparing `deliveries` states against Redis queue contents and auto-republishing orphans, with alerting. Documented as a roadmap item (§17); the explicit command is the v1 mechanism.
- Tested: publish jobs → `FLUSHALL` Redis → run recovery → jobs reappear, attempts preserved (§14).

---

## 7. Webhook Delivery Engine

### 7.1 Worker Flow — atomic claim + in-progress attempt

Counters: `attempt_count` = attempts started in current cycle (incremented **at claim**); `total_attempt_count` = lifetime attempts started. Both are incremented in the claim TX, so a crash after claim still counts the attempt — this matches the `in_progress` attempt row.

```
job = { deliveryId, outboxId }
1. CLAIM (ONE short TX — all four effects atomically):
     WITH claimed AS (
       UPDATE deliveries
       SET status = 'processing',
           lock_token = $newToken,
           locked_until = NOW() + $lease,          -- §8.1 relationship enforced
           attempt_count = attempt_count + 1,
           total_attempt_count = total_attempt_count + 1,
           next_attempt_at = NULL
       WHERE id = $deliveryId
         AND (status IN ('pending','retrying')
              OR (status = 'processing' AND locked_until < NOW()))
       RETURNING *
     ), attempt AS (
       INSERT INTO delivery_attempts
         (id, delivery_id, cycle_number, attempt_number, status,
          started_at, request_timestamp)
       SELECT $attemptId, id, replay_count + 1, attempt_count,
              'in_progress', NOW(), NULL
       FROM claimed
       RETURNING id
     )
     SELECT * FROM claimed;
   → 0 rows = someone else holds it (or terminal) → return silently (idempotent no-op).
   lock_token + cycle_number + attempt_number are returned to the worker.
   TX COMMITS before any HTTP.

2. LOAD event + endpoint (endpoint: url, signing_secret_encrypted, timeout_ms, is_active, deleted_at).
   → Endpoint deleted/inactive → finalize attempt as terminal_failure
     (error_message='endpoint_inactive') + delivery failed, in one guarded TX (§7.4).
   → SSRF validation re-run at delivery time (§10.1); failure → terminal_failure.

3. BUILD body (exact string matters for signing):
     body = JSON.stringify({ id, type, createdAt, data })
   Decrypt signing secret (AES-256-GCM) in memory only.
   timestamp = Math.floor(Date.now()/1000)
   signature = HMAC_SHA256(secret, `${timestamp}.${body}`)

4. HTTP POST (via fetch with AbortController + timeout_ms; NO open DB TX — §7.3):
     Headers: Content-Type: application/json
              X-EventRelay-Event-Id, X-EventRelay-Delivery-Id,
              X-EventRelay-Timestamp, X-EventRelay-Signature: t=..,v1=..
   Measure response_time_ms; read body with the byte cap (§10.1).

5. FINALIZE (short TX, lock-token guarded — §7.4):
     UPDATE delivery_attempts
     SET status = $outcome, response_status = ..., response_body = ...,
         response_time_ms = ..., error_message = ..., completed_at = NOW()
     WHERE id = $attemptId AND status = 'in_progress';
     UPDATE deliveries
     SET status = ..., last_response_status = ..., last_error = ...,
         next_attempt_at = ..., succeeded_at = ... / dead_lettered_at = ...,
         lock_token = NULL, locked_until = NULL
     WHERE id = $deliveryId AND lock_token = $ours;
   → If the second UPDATE affects 0 rows, we lost the lock (stale worker):
     do NOT write to outbox (no retry enqueued), log + discard. The winning
     worker / sweeper owns the outcome.
   → On retryable failure (if attempts remain): same TX also inserts the
     delivery.retry outbox row with available_at = next_attempt_at (§6.3).
```

### 7.2 Lease, Crash, and Sweeper Finalization

- **Sweeper** (worker process, every 15 s) claims expired leases with `SKIP LOCKED` in one TX per batch:
  - Each `processing` delivery with `locked_until < NOW()` has exactly one `in_progress` attempt (invariant from the atomic claim + finalize design). Sweeper finalizes **that** attempt as `worker_lost` (`error_message='lease_expired'`, `completed_at = NOW()`) — only where `status = 'in_progress'` — and sets the delivery to `retrying` (or `failed` if `attempt_count` already reached `max_attempts`), clearing `lock_token`/`locked_until`.
  - In a separate outbox row (`delivery.recovery`, `available_at = NOW()`) the sweeper re-enqueues the delivery **in the same TX**, so the retry intent is durable even if Redis is down.
  - A stale worker that was merely slow later finalizes with 0 rows (lock-token guard, §7.4) and becomes a no-op — its HTTP result is discarded even if the receiver got the request.

### 7.3 Lease–Timeout Relationship (enforceable, no renewal in v1)

**v1 uses no lease renewal.** Correctness instead comes from a strict, enforced inequality:

```
DELIVERY_LEASE_MS ≥ (endpoint.timeout_ms × 3) + PROCESSING_MARGIN_MS   (default margin 10 s)
AND  endpoint.timeout_ms ≤ MAX_ENDPOINT_TIMEOUT_MS (30 s, hard cap, CHECK constraint)
```

- Defaults: `DELIVERY_LEASE_MS = 60_000` (60 s) → allows endpoint timeouts up to ~16 s with margin; endpoints with `timeout_ms` up to 30 s require `DELIVERY_LEASE_MS ≥ 100 s` (operators raise the env when they need longer timeouts). Startup validation **fails fast** if `DELIVERY_LEASE_MS < 15_000` (below the minimum useful margin) and endpoint save rejects `timeout_ms` that would violate the inequality for the configured lease.
- Rationale: DNS + TCP/TLS + HTTP round trip + finalize TX must complete well inside the lease for a healthy worker. Under this bound, a live worker always finalizes before expiry, so expiry reliably means "worker gone". No background renewer, no renewal races.
- The DB claim sets `locked_until = NOW() + DELIVERY_LEASE_MS` uniformly — the effective bound is then `lease − timeout` (≥ 2× timeout + margin), which is generous for one finalize TX.

### 7.4 Stale-Worker Protection and Immutability

- Every delivery finalize includes `AND lock_token = $ours`. A stale worker (lease lost, sweeper or another worker claimed the delivery) **cannot** update delivery state, cannot insert a retry outbox row, and cannot mark the delivery terminal. Its only write attempt affects 0 rows.
- Attempt imputation: the attempt UPDATE includes `AND status = 'in_progress'` — once `worker_lost`/terminal/succeeded, no stale worker can overwrite it. Finalized attempt rows are immutable history; replays append new rows with a new `cycle_number`.
- Worker crash **after HTTP succeeded** but before finalize: the receiver *did* get the webhook; the attempt ends as `worker_lost` via the sweeper; the delivery retries and may deliver again. **External duplicate delivery remains possible** — this is intrinsic to at-least-once without receiver cooperation, and is why receivers must dedupe (§7.6).

### 7.5 Signing Contract (document in README + OpenAPI)

- Signed: `t=<unix_seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`.
- Receiver verification: recompute HMAC over `X-EventRelay-Timestamp + "." + rawBody`, compare with `timingSafeEqual`, reject if timestamp skew > 5 min.
- Provide a verification snippet (JS + cURL) and a test receiver endpoint (`POST /dev/webhook-receiver` in dev only) so developers can validate signatures end-to-end.

### 7.6 Receiver Deduplication Contract

Every delivery request carries `X-EventRelay-Event-Id` and `X-EventRelay-Delivery-Id`. Receivers should treat a repeated `X-EventRelay-Delivery-Id` as a duplicate (return 2xx without re-processing). Document this prominently in the README and OpenAPI — it is the only exactly-once-adjacent guarantee in the system.

### 7.7 Secret Management

- `ENCRYPTION_KEY` env (32-byte base64). AES-256-GCM; store `iv:authTag:ciphertext`.
- Decrypted secret lives only in worker memory during signing; never logged; never returned by list/get endpoint APIs. `POST /v1/endpoints/:id/rotate-secret` returns new secret once.

---

## 8. Retry Mechanism & Failure Classification

### 8.1 Backoff Formula and Lease Relationship

```
delay_n = min( MAX_DELAY, BASE_RETRY_DELAY_MS * RETRY_MULTIPLIER^(n-1) )  with full jitter:
delay = random(0, computed)
next_attempt_at = available_at = NOW() + delay
```

Defaults (configurable via env):

| Param | Default |
|---|---|
| `MAX_ATTEMPTS` | 6 (incl. first attempt) |
| `BASE_RETRY_DELAY_MS` | 5000 |
| `RETRY_MULTIPLIER` | 2 |
| `MAX_RETRY_DELAY_MS` | 3_600_000 (1 h) |
| `DELIVERY_LEASE_MS` | 60_000 (must satisfy §7.3) |
| `MAX_ENDPOINT_TIMEOUT_MS` | 30_000 (hard endpoint cap) |
| `JITTER` | full jitter |

Example schedule (pre-jitter): 1st immediate → 5 s → 10 s → 20 s → 40 s → 80 s. Jitter spreads retries so thousands of simultaneous failures don't thundering-herd the receiver.

### 8.2 Per-Endpoint Overrides

`endpoints.max_attempts` + `endpoints.timeout_ms` (hard-capped, §4.2) allow per-endpoint tuning; global env values are fallbacks.

### 8.3 Classification (configurable — document in README + `.env.example`)

**Success:** HTTP 2xx → attempt `succeeded`, delivery `succeeded`, `succeeded_at=NOW()`.

**Retryable** (schedule next attempt if `attempt_count < endpoint.max_attempts`, else delivery `failed`/dead-letter):

- Network errors: DNS, ECONNREFUSED/RESET, TLS errors, SSRF-validation transient DNS failures, `AbortError` (timeout)
- HTTP **408**, **425**, **429** (honor `Retry-After`: `next_attempt_at = max(backoff, now + retryAfter)`, capped at `MAX_RETRY_DELAY_MS`)
- HTTP **5xx**

**Terminal** (immediately delivery `failed`, `dead_lettered_at=NOW()`):

- Other HTTP **4xx** (except 408/425/429)
- Invalid endpoint URL/config, inactive/deleted endpoint, SSRF-blocked target (private/reserved IP without dev allowlist)
- 3xx: **redirects are never followed** (`redirect: 'manual'`); any 3xx is `terminal_failure` (documented; receivers must return 2xx)
- Non-retryable delivery errors

`RETRYABLE_STATUS_CODES` env (comma list) overrides the default set. Classification lives in one pure function `classifyOutcome(result)` — unit-testable without HTTP. Attempt statuses map: success→`succeeded`, retryable→`retryable_failure` (+ retry outbox row when attempts remain, else delivery `failed`), terminal→`terminal_failure`.

### 8.4 State Transitions

```
pending → processing → succeeded                     (2xx)
pending → processing → retrying → (outbox delivery.retry, available_at=next_attempt_at) → processing → …
processing → failed                                  (terminal_failure, or attempts exhausted, or endpoint gone)
processing (lease expired) → sweeper: attempt=worker_lost → retrying / failed (re-enqueued via outbox)
failed → (manual replay, failed-only) → pending      (new cycle, replay_count++, attempt_count=0, cycle_number++)
```

- `attempt_count` = attempts started in current cycle (reset on replay to 0, incremented at each claim); `total_attempt_count` = lifetime attempts started (never reset). `succeeded_at`/`dead_lettered_at` cleared on replay.
- Exhaustion → `status='failed'`, `dead_lettered_at=NOW()`, `next_attempt_at=NULL`. Alert-ready: query `status='failed' AND dead_lettered_at > NOW()-1h`.

### 8.5 Manual Replay (failed-only, atomic, race-safe)

```
POST /v1/deliveries/:id/replay   (JWT auth; ownership check via endpoint.user_id)
TX (single statement, atomic):
  UPDATE deliveries
  SET status='pending', attempt_count=0, replay_count=replay_count+1,
      next_attempt_at=NOW(), lock_token=NULL, locked_until=NULL,
      succeeded_at=NULL, dead_lettered_at=NULL
  WHERE id=$1 AND status='failed'          -- v1: failed only. s succeeded is never replayable.
  RETURNING replay_count;
  IF 0 rows → ROLLBACK, 409 Conflict ("delivery is not in failed state").
  INSERT INTO outbox_messages (message_type='delivery.replay', aggregate_id=$1, available_at=NOW());
→ 202 { deliveryId, status:'pending', replayCount }
```

- Previous attempt rows are untouched; new attempts get `cycle_number = replay_count + 1` and `attempt_number` starting at 1.
- **Concurrent replays cannot create duplicate cycles:** the first TX flips `status` `failed → pending`; the second re-`UPDATE`s 0 rows (`status` no longer `failed`) → 409. The `status='failed'` guard + single-TX outbox insert make the operation linearizable without `SELECT FOR UPDATE`.
- v1 explicitly does **not** support replaying `succeeded` deliveries. Do not "extend" this until a product decision is made.

---

## 9. API Specification

Base: `/v1`. Auth: `Authorization: Bearer <JWT>` (dashboard) or `X-API-Key` (ingestion/verification).

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register`, `/auth/login` | — | JWT issuance |
| `GET/POST` | `/api-keys` | JWT | List (no raw material) / create (raw key once) |
| `DELETE` | `/api-keys/:id` | JWT | Revoke (set `revoked_at`) |
| `GET/POST` | `/endpoints` | JWT | List (no secrets, no deleted) / create (SSRF-validated URL, §10.1) |
| `GET/PUT/DELETE` | `/endpoints/:id` | JWT | Get (no secret) / update incl. subscriptions / **soft delete** (`deleted_at`, `is_active=false`) |
| `POST` | `/endpoints/:id/rotate-secret` | JWT | New secret, shown once |
| `POST` | `/v1/events` | API key | Ingest (see §5) |
| `GET` | `/events`, `/events/:id` | JWT | List (filters: type, date) / detail + deliveries |
| `GET` | `/deliveries`, `/deliveries/:id` | JWT | List (status, endpoint, event filters, pagination) / detail + attempts |
| `POST` | `/deliveries/:id/replay` | JWT | Manual replay — **failed-only** (§8.5); 409 otherwise |
| `GET` | `/stats/overview` | JWT | Counts by status, success rate, recent failures |
| `GET` | `/docs` | — | Swagger UI; `/openapi.yaml` |

Conventions: offset pagination (`limit`+`offset`, `meta` in response), `{ error: { code, message, requestId } }` error shape, `X-Request-Id` on every response, 401/403/404/409/422/429 semantics documented in OpenAPI. All write bodies validated with Zod.

---

## 10. Authentication, Authorization & Security

### 10.1 SSRF and Webhook Security (endpoint URL validation)

A URL-string check is **never** sufficient. Hostname-based attacks (DNS returning private IPs, rebinding between check and connect) must be defeated structurally:

**Validation at endpoint creation/update AND re-validation at every delivery attempt:**

1. Parse URL. Scheme: `https:` only when `NODE_ENV=production`; `http:` allowed only when `ALLOW_INSECURE_URLS=true` (dev/local) — and production always rejects `http:`.
2. Resolve hostname via `node:dns/promises` `resolve4`/`resolve6` (or `lookup(hostname, { all: true, verbatim: true })`). **Every** returned address must pass the public-IP check; a single private/reserved address rejects the whole hostname. Use the OS resolver behavior consistently; do not skip IPv6.
3. Public-IP check rejects: loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), multicast (`224/4`, `ff00::/8`), unspecified (`0.0.0.0`, `::`), documentation/benchmark/reserved (`192.0.2/24`, `198.51.100/24`, `203.0.113/24`, `198.18/15`, `240/4`, `::ffff:0:0/96` mapped forms, `100.64/10` CGNAT unless explicitly allowed). **IPv4-mapped IPv6** (`::ffff:127.0.0.1`) is unwrapped and checked as IPv4. Classification uses `node:net` `isIPv4/isIPv6` + an explicit range table (or `ipaddr.js`-equivalent logic implemented in `lib/ssrf.js`, unit-tested per range).
4. **DNS rebinding (TOCTOU) defense at delivery time:** connect using a **pinned lookup** — the worker passes a custom `lookup` to `http`/`https` request (via `fetch` `dispatcher`/`agent` or raw `https.request`) that returns only the addresses validated in step 2 for *this* attempt. The validated IP set is re-resolved per attempt, so a DNS record that changes between attempts is re-checked. Optionally also set connection `servername` for SNI/Host correctness. Document that this prevents the "validated public, connected to private" split.
5. **Redirects:** `redirect: 'manual'`. Any 3xx is `terminal_failure` — the worker never follows a redirect to a possibly-private URL. Documented in §8.3.
6. **Dev allowlist (controlled):** `ALLOW_LOCAL_ENDPOINTS=true` (never set in production; startup **refuses** to boot with `NODE_ENV=production` + `ALLOW_LOCAL_ENDPOINTS=true`) permits `localhost` / loopback / private targets for local development. Endpoint create/update and delivery-time checks both consult the same allowlist flag.
7. **Bounded response reading:** read at most `MAX_RESPONSE_BYTES` (default 64 KB) via streaming with a hard abort when the cap is exceeded; never buffer unbounded bodies. A body over the cap is recorded truncated with `error_message` noting truncation — the HTTP status still classifies the attempt. This prevents memory exhaustion from a rogue receiver.
8. **Timeouts:** `AbortController` with `endpoint.timeout_ms`; also cap request header size. Per-endpoint `timeout_ms ≤ MAX_ENDPOINT_TIMEOUT_MS` (§4.2).

Implementation point: shared `lib/ssrf.js` (`validateEndpointUrl(url, { allowLocal })` async + `pinnedLookup(hostname, addresses)`) used by both API (save time) and worker (delivery time). Pure IP-range logic is unit-tested with table-driven cases including mapped-IPv6 and boundary addresses.

### 10.2 Other Security

- **Passwords:** `bcryptjs` hash (cost 12); never stored/returned plain.
- **JWT:** `jsonwebtoken`, `JWT_SECRET` env, short expiry (24 h), Bearer + in-memory storage. Dashboard routes only.
- **API keys:** format `er_live_<22-char random base64url>`; `key_prefix` = first 16 chars incl. `er_live_` (§4.2); `UNIQUE(key_prefix)`; `key_hash = SHA-256(raw)`; verify via lookup-by-prefix + `timingSafeEqual` on SHA-256 digests. Shown **once**; `revoked_at`/`expires_at` enforced on every ingestion. Store no other copy of the raw key.
- **Authorization:** every query scoped by `user_id` (ownership) — no cross-user reads; replay/endpoint ops verify `endpoint.user_id = caller`.
- **Encryption at rest:** endpoint signing secrets AES-256-GCM (§7.7). `.env` never committed; `.env.example` documents all keys. Production enforces HTTPS for endpoint URLs (§10.1).
- **Transport/headers:** Helmet; CORS locked to `CLIENT_URL`; rate limits: auth strict, ingest per-API-key + global, general per-IP.
- **Input:** Zod validation everywhere; payload size limits (256 KB events, 64 KB responses).
- **Logging hygiene:** Pino redacts `authorization`, `x-api-key`, secrets; no payload bodies or decrypted secrets in logs by default.

---

## 11. Frontend Dashboard

- **Architecture:** Vite SPA; `src/{routes,components,hooks,lib}`; Axios instance with JWT interceptor + `X-Request-Id`; React Query for all server state (no manual fetch-state), React Router for routes.
- **Pages:** Login/Register → Layout (sidebar) → Dashboard (stat cards, recent failures) → Events (table + filters + detail drawer with JSON viewer) → Deliveries (status filter chips, detail with attempt timeline showing the §4.2 attempt statuses per attempt) → Endpoints (table, create/edit modal with URL — surfaced SSRF validation errors — subscriptions multi-select, timeout/attempts, secret rotate, soft-delete) → API Keys (create modal → one-time key display with copy button, revoke, last-used).
- **Actions:** Replay button on **failed** deliveries only (confirm modal → 202 toast → React Query invalidation; 409 surfaces "already replayed/in progress").
- **UX details:** loading skeletons, empty states, error toasts via requestId, pagination, date formatting, Lucide icons. Tailwind design system with a small set of reusable primitives (Button, Badge, Modal, Table, PageHeader).
- **Build:** `npm run build` → static `dist/` served by API in prod (single-container option) or separate nginx; document both.

---

## 12. Project Structure

```
EventRelay/
├── plan.md
├── README.md                  # setup, architecture, signing, ops
├── package.json               # workspaces or split: api/, worker/, client/
├── docker-compose.yml
├── .env.example
├── openapi.yaml
├── db/
│   ├── migrations/001_init.sql
│   ├── migrate.js
│   └── seed.js
├── api/                       # Express API server
│   ├── src/
│   │   ├── app.js             # express setup: helmet, cors, rate-limit, pino-http, routes
│   │   ├── server.js          # start (api only)
│   │   ├── routes/            # auth, apiKeys, endpoints, events, deliveries, stats
│   │   ├── controllers/
│   │   ├── services/          # ingestion, replay, stats
│   │   ├── db/pool.js, migrate runner, withTransaction helper
│   │   ├── middleware/        # auth (jwt / apiKey), validate(zod), errorHandler, requestId
│   │   ├── lib/               # crypto (hash/encrypt/HMAC), backoff, classify, ssrf
│   │   └── config/env.js
│   └── __tests__/             # supertest integration + unit
├── worker/                    # shared lib + worker entry (separate process)
│   ├── src/
│   │   ├── worker.js          # BullMQ Worker + sweeper + dispatcher (flags: --mode)
│   │   ├── delivery.js        # claim→sign→POST→finalize (atomic claim TX, §7.1)
│   │   ├── queue.js           # BullMQ Queue/Worker setup (jobId=outbox_<id>, §6.3)
│   │   └── lib/               # same crypto/backoff/classify/ssrf (shared package)
│   └── __tests__/
├── client/                    # React + Vite app
│   └── src/{routes,components,hooks,lib}
└── scripts/
    ├── recover-queue.js       # Redis-wipe / lost-job recovery (§6.4)
    └── dev-receiver.js        # local webhook receiver for signing tests
```

**Shared code:** crypto/backoff/classify/ssrf helpers shared between `api/` and `worker/` via a `packages/shared` workspace or duplicated pure modules with mirrored tests — prefer a shared package to avoid drift.

---

## 13. Infrastructure, Docker & Deployment

### 13.1 `docker-compose.yml` (dev + prod-like)

- `postgres:16-alpine` (volume `pgdata`, healthcheck `pg_isready`)
- `redis:7-alpine` (volume `redisdata`, healthcheck `redis-cli ping`)
- `api` (build `api/Dockerfile`, `FROM node:24-alpine`, port 4000, depends_on healthy pg/redis, runs migrations on start)
- `worker` (same image, command `node worker.js`, `WORKER_CONCURRENCY` env, scalable via `docker compose up --scale worker=3`)
- `dispatcher` (same image, command `node worker.js --mode=dispatcher`) — or fold into API via env flag for small deploys; document the trade-off.
- `client` build or nginx serving `client/dist` (port 5173 dev / 80 prod)
- `NODE_ENV=production` in prod services automatically enforces HTTPS-only endpoint URLs and forbids `ALLOW_LOCAL_ENDPOINTS=true` (§10.1)

### 13.2 Environment Variables (`.env.example`)

`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `PORT`, `CLIENT_URL`, `NODE_ENV`, `MAX_ATTEMPTS`, `BASE_RETRY_DELAY_MS`, `RETRY_MULTIPLIER`, `MAX_RETRY_DELAY_MS`, `DELIVERY_LEASE_MS`, `MAX_ENDPOINT_TIMEOUT_MS`, `WORKER_CONCURRENCY`, `RETRYABLE_STATUS_CODES`, `MAX_EVENT_PAYLOAD_BYTES`, `MAX_RESPONSE_BYTES`, `ALLOW_LOCAL_ENDPOINTS`, `ALLOW_INSECURE_URLS`, `LOG_LEVEL`.

### 13.3 Deployment Notes

- Run `node db/migrate.js` before first API boot (or on API startup; idempotent).
- Single host = Compose; multi-host = run api/worker/dispatcher as separate containers/services; Postgres + Redis managed (RDS/ElastiCache equivalents) with backups + PITR for Postgres (source of truth).
- Graceful shutdown: worker drains in-flight jobs (`worker.close()`), API stops accepting + drains; lease expiry covers SIGKILL cases anyway.
- Health endpoints: `GET /health` (API: DB ping), worker readiness via Redis/DB connectivity logs.
- Startup guards: validate `DELIVERY_LEASE_MS` vs. max endpoint timeout (§7.3); refuse production boot with `ALLOW_LOCAL_ENDPOINTS=true` (§10.1).

---

## 14. Testing Strategy

Principles: locking-, transaction-, and concurrency-sensitive behavior is tested against **real PostgreSQL and Redis** (CI services or Compose). `pg-mem`, mocked `ioredis`, and in-memory fakes are permitted only for fast unit tests — never as the sole evidence for the cases below.

| Layer | Tool / Environment | What |
|---|---|---|
| Unit | Jest | `classifyOutcome`, backoff+jitter bounds, HMAC sign/verify, AES-GCM round-trip, SHA-256 API-key verify, Zod schemas, **SSRF IP-range table** (all ranges incl. mapped-IPv6 + boundaries), job-ID format check (no `:`) |
| API integration | Supertest + **real Postgres** | Register/login, API-key lifecycle (prefix uniqueness, hash-only storage, one-time display), endpoint CRUD + subscriptions + **soft delete keeps history**, ingest fan-out, idempotency (same key twice → one event), auth scoping (user A can't read user B) |
| **Concurrency (real Postgres)** | Parallel `pg` clients | Two simultaneous `POST /v1/events` with the same `Idempotency-Key` → exactly 1 event, 1 set of deliveries, 1 set of outbox rows. Two concurrent replay POSTs on one failed delivery → exactly one 202, one 409, one new cycle. Concurrent worker claims on one delivery → exactly one claim wins |
| Outbox | Jest + **real Redis** | Redis down → outbox unpublished persists → Redis up → job enqueued exactly once (`jobId = outbox_<id>`, re-publish of same row reuses same `jobId`) |
| **Dispatcher crash** | Redis + Postgres fault injection | Kill dispatcher between `queue.add` and mark-published → next run re-publishes same row/job ID → BullMQ holds 1 job → worker claims once; no duplicate deliveries |
| **Worker crash after send** | Mock receiver + real Postgres | Receiver returns 2xx; worker killed before finalize → sweeper finalizes attempt as `worker_lost`, delivery retries, duplicate delivery observed + dedupe contract verified; history shows `worker_lost` then the retried attempt |
| **Redis wipe after publish** | `FLUSHALL` on real Redis | Publish → wipe → run `scripts/recover-queue.js` → `pending`/`retrying`/expired-`processing` deliveries re-enqueued; `succeeded`/`failed` untouched; attempts/counters preserved; second run is a no-op |
| Delivery integration | Mock receiver (local HTTP) | Worker end-to-end: 2xx success, 500 retry→success, terminal 4xx, timeout retry, redirect treated as terminal, lease-expiry recovery |
| **Large response body** | Mock receiver streaming > 64 KB | Worker aborts reads at the cap; attempt stored truncated; memory stays bounded; classification unaffected |
| **DNS-based SSRF** | Stub DNS (or `/etc/hosts`-style override in test env) | Endpoints resolving to `127.0.0.1`, `10.x`, `::1`, `::ffff:127.0.0.1`, or mixed public+private records → rejected at save; public IP at save → private at delivery → blocked at delivery (pinned-lookup path); allows dev allowlist only in non-production |
| Contract | OpenAPI + manual | Signing verification snippet tested against `/dev/webhook-receiver` |
| E2E (smoke) | Playwright or manual checklist | Dashboard login → create endpoint → ingest → see delivery succeeded |

- CI: GitHub Actions — `npm ci`, lint, unit, integration with ephemeral Postgres/Redis services, build client.
- Coverage targets: classify/backoff/signing/crypto/ssrf 100%; services/routes > 80%.

---

## 15. Observability & Operations

- **Logging:** Pino JSON with `requestId`, `deliveryId`, `attemptId`, `eventId`, `outboxId`; levels via `LOG_LEVEL`; redact secrets. Never log raw payloads/signing secrets at info+.
- **Metrics (phase 2 or minimal):** deliveries by status (DB queries), outbox backlog age, worker lag — expose `/metrics` (Prometheus format) if time permits; otherwise SQL-based ops dashboard queries in README.
- **Alerts (document as SQL/runbook):** unpublished outbox age > 60 s; `processing` lease-expired count spike; `worker_lost` attempts rate; dead-letter rate > threshold; API 5xx rate.
- **Runbooks (README):** Redis outage (dispatcher self-heals), Redis wipe (`npm run recovery:queue`, §6.4), Postgres restore, key rotation (`ENCRYPTION_KEY` rotation procedure — re-encrypt secrets), scaling workers, automated reconciliation (roadmap).
- **Tracers:** `requestId` across API→dispatcher→worker via job payload + headers; include in Pino child loggers.

---

## 16. Build Order / Milestones

1. **M0 — Scaffolding:** repo layout, package.json pins (Node 24 LTS, Express 5, React 19, Vite 7), `.env.example`, Docker Compose (pg+redis), `migrate.js`, Pino + Helmet + error handling, health check. *Done when:* `docker compose up` → API `/health` 200.
2. **M1 — Auth & API keys:** users (bcrypt), JWT, api_keys CRUD (SHA-256, 16-char prefix, unique index, once-display), Zod + rate limits. Tests included.
3. **M2 — Endpoints & subscriptions:** endpoints CRUD (soft delete, timeout cap + lease inequality), AES-GCM secret storage, subscriptions, rotate-secret, SSRF-aware URL validation (`lib/ssrf.js`, §10.1).
4. **M3 — Ingestion + outbox schema:** migrations for events/deliveries/attempts (new state machine, §4.2)/outbox (lock_token), `POST /v1/events` single-TX fan-out + idempotency. **Real-Postgres concurrent-idempotency test.**
5. **M4 — Dispatcher + queue:** outbox poller (`available_at` only, `SKIP LOCKED`, `lock_token`, `jobId = outbox_<id>`), Redis-down + dispatcher-crash-after-add tests.
6. **M5 — Delivery engine:** atomic claim TX (lease + counters + `in_progress` attempt), HMAC signing, bounded POST with pinned DNS lookup, lock-token-guarded finalize, sweeper (`worker_lost`), worker-crash tests.
7. **M6 — Retries, classification, replay, recovery:** backoff+jitter, `Retry-After`, terminal classification, failed-only atomic replay (§8.5), `scripts/recover-queue.js` + Redis-wipe test.
8. **M7 — Dashboard:** React app — auth, events, deliveries+attempts (incl. `worker_lost`), endpoints (soft delete, SSRF errors), API keys, stats, replay UX (failed-only).
9. **M8 — API surface polish:** OpenAPI + Swagger UI, pagination/filters, stats endpoint, error-shape consistency.
10. **M9 — Hardening:** load test (thousands of events), Redis-kill + worker-kill drills (incl. real-Postgres/Redis fault-injection tests, §14), README (setup, signing, ops/runbooks), CI, coverage pass.

Each milestone ends with: tests green, README notes updated, `docker compose up` still works.

---

## 17. Risks, Trade-offs & Non-Goals

| Risk / Trade-off | Mitigation |
|---|---|
| Duplicate deliveries (at-least-once) | Documented contract (§7.6); `X-EventRelay-Delivery-Id` for receiver dedupe; idempotent worker claim |
| Endpoint URL abuse / SSRF | DNS-based validation with pinned lookups, redirects disabled, HTTPS enforced in prod, dev allowlist gated (§10.1) |
| Redis wipe loses published jobs | Explicit recovery command (§6.4); automated reconciliation as later enhancement |
| Outbox polling latency | 500 ms poll acceptable for webhooks; `LISTEN/NOTIFY` as later optimization |
| Attempt-row volume at scale | Truncate `response_body` (+ response cap); retention/archival policy (§4.5); index `(delivery_id, started_at)` |
| `ENCRYPTION_KEY` loss | Back it up; document rotation; without it secrets are unrecoverable (by design) |
| Lease too short for slow receivers | Hard endpoint timeout cap + enforced lease inequality (§7.3); startup validation |
| BullMQ/Redis version drift | Pin majors; healthchecks; `maxRetriesPerRequest: null` |

**Non-goals (v1):** exactly-once semantics, WebSockets/SSE live streams, email/SMS consumers, multi-tenant billing, visual pipeline builder, per-endpoint custom retry policies beyond `max_attempts`/`timeout_ms`, GraphQL, automatic queue reconciliation (explicit command only), replaying `succeeded` deliveries, lease renewal.

---

## 18. Architectural Revisions

The following corrections were applied to the previously approved draft. Each change fixes a concrete correctness, reliability, or security defect — none are cosmetic.

| # | Change | Why (defect in prior draft) |
|---|---|---|
| 1 | **Job IDs are `outbox_<outboxId>`; all `delivery:<id>` colon IDs removed.** Every enqueue intent (created/retry/replay/recovery) gets a fresh outbox row → distinct job ID; re-publish of the same row reuses the same ID. | Colons are invalid in BullMQ custom IDs. Delivery-derived IDs collided across retries/replays (second retry deduped away); the replacement guarantees "same row ⇒ same ID, different intent ⇒ different ID" and is documented as dedupe-optimization only (§6.3). |
| 2 | **Explicit Redis-wipe recovery command** (`scripts/recover-queue.js`, §6.4) republishing `pending`/`retrying`/expired-`processing` as `delivery.recovery` outbox rows; history preserved; automated reconciliation deferred to roadmap. | Prior draft only covered *unpublished* outbox rows; jobs published then lost on wipe were unrecoverable. New command closes that gap; test added (§14). |
| 3 | **Attempt state machine** (`in_progress`, `succeeded`, `retryable_failure`, `terminal_failure`, `worker_lost`) with `status` CHECK constraint; claim TX atomically inserts the `in_progress` attempt; update-only-while-`in_progress` immutability rule; sweeper finalizes as `worker_lost`. | Prior draft inserted `pending` attempts that violated the 3-value CHECK constraint, and left the sweeper's "record as failed" undefined. Schema, worker algorithm, and sweeper now agree exactly (§4.2, §7.1–7.2). |
| 4 | **SSRF hardening:** DNS resolution with all-address validation, IPv4/IPv6 private/loopback/link-local/multicast/reserved rejection incl. IPv4-mapped forms, pinned lookup anti-rebinding, redirects never followed, dev-only allowlist gated off in prod, 64 KB response cap, HTTPS-only in prod (§10.1). | Prior "block private ranges" line had no mechanism: hostname strings are not addresses, check-then-connect is a TOCTOU/rebinding hole, and fetch would follow redirects into the private network. |
| 5 | **History preservation:** `ON DELETE RESTRICT` on all history FKs; endpoint **soft delete** (`deleted_at`); retention/archival policy (§4.5). | Prior `ON DELETE CASCADE` from endpoints/events would silently destroy delivery + attempt history — the audit trail the product exists to provide. |
| 6 | **API-key fix:** single canonical prefix (16 chars incl. `er_live_`), `UNIQUE(key_prefix)`, `SHA-256` hash + `timingSafeEqual` on ingestion path; bcrypt reserved for passwords (§4.2, §10.2). | Prior draft had two conflicting prefix lengths (8 vs 12) and paid a `bcrypt.compare` (~100 ms) on every ingestion request for a 132-bit random secret — wrong primitive, needless latency. |
| 7 | **Dispatcher lock token + scheduling clarity:** `lock_token`/`locked_until` on outbox rows with guarded mark-published; `published_at` = broker-accepted; **Postgres `available_at` is the only scheduler; BullMQ `delay` removed entirely** (§6.2–6.3). | Prior draft could hold two scheduling mechanisms (dispatcher poll + BullMQ delayed jobs), and an ungarded mark-published let a stale dispatcher corrupt publication state after lease loss. |
| 8 | **Enforceable lease/timeout rule:** no lease renewal; hard `timeout_ms` cap + `DELIVERY_LEASE_MS ≥ (timeout × 3) + margin` validated at startup and endpoint save (§7.3); lock-token-guarded finalize with 0-row stale-worker handling; external duplicates explicitly documented (§7.4, §7.6). | "Lease > timeout, enforce at startup" was unenforceable against per-endpoint timeouts and left stale-worker writes unspecified. The inequality + caps make it a checkable invariant. |
| 9 | **Replay is failed-only, v1-only, and race-safe:** `WHERE status='failed'` only (removed `'succeeded'`), 0-row → 409 contract, concurrency test required (§8.5, §14). | Prior SQL allowed replaying `succeeded` deliveries despite claiming "default"; and concurrent replays could each create a "new cycle". The single-statement guard makes double-replay linearizable. |
| 10 | **Supported versions:** Node 24 LTS (EOL 20 removed), Express 5, React 19, Vite 7, Tailwind 4 (§2). | Node 20 leaves the supported-LTS window during this project's lifetime; Express 4 / React 18 are maintained but no longer current. Compatibility verified against BullMQ 5 (Node 20+ API surface, `maxRetriesPerRequest` semantics, custom-ID charset). |
| 11 | **Real-infrastructure tests:** actual-Postgres concurrency tests (duplicate ingestion, concurrent claims, concurrent replay), dispatcher-crash-after-add, worker-crash-after-send, Redis-wipe, DNS-SSRF, large-body cap; `pg-mem`/mocks demoted to unit subsets (§14). | Prior tests allowed `pg-mem` and mocked Redis to be the *only* evidence for locking/transaction/idempotency claims — exactly the behavior that can't be verified without a real database. |

### Consistency checklist (verified on this revision)

- Every schema CHECK constraint matches every algorithm that writes to it (attempt statuses §4.2 ↔ §7.1–7.2; outbox types §4.2 ↔ §5.3/§6.4/§8.5; delivery statuses §4.2 ↔ §7.2/§8.4).
- Retry/replay/recovery all insert a **new** outbox row with `available_at` in the same TX as the delivery-state change; dispatcher publishes only due rows, immediate jobs, `jobId = outbox_<id>` — no path uses BullMQ delay or colon IDs.
- Counter semantics (attempt_count current-cycle, total lifetime, replay_count, cycle_number = replay_count + 1) are stated once in §4.2 and used identically in §7.1, §8.4, §8.5.
- Architecture diagram (§3) reflects the recovery command and sweeper as separate paths; milestones (§16) include the new tests and hardening tasks; acceptance criteria (§1.2) include Redis-wipe, SSRF, and worker-crash-after-send scenarios.

---

*End of plan. Next step: M0 scaffolding.*
