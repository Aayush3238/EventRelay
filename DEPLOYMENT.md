# Deploying EventRelay — Render (backend) + Vercel (frontend)

This guide assumes your local `.env` already has working `DATABASE_URL` and
`REDIS_URL` values (cloud Postgres + Redis). The same two values are reused
on Render — your local `.env` itself is **never** uploaded anywhere.

Final architecture:

```
Vercel (React SPA) ──HTTPS──▶ Render API (Express) ──▶ Render Postgres (source of truth)
                                       │                     ▲
                                       └──▶ Render Redis (BullMQ queue)
                                       ├──▶ Render worker (deliveries)
                                       └──▶ Render dispatcher (outbox)
Worker ──HTTPS POST──▶ your users' webhook endpoints (must be public)
```

---

## Part 1 — Backend on Render (3 services, one blueprint)

> **"Payment Information Required" prompt?** That's because Render has **no
> free tier for background workers** — the paid `render.yaml` blueprint
> (worker + dispatcher on `starter`) can't be created without a card on
> file. If you don't want to add a card, use the **free single-service
> variant** instead: same Blueprint flow, but set **Blueprint Path =
> `render.free.yaml`** — one free web service that runs API + worker +
> dispatcher together via `RUN_BACKGROUND=true` (great for testing; sleeps
> when idle, so deliveries pause until the next request wakes it).
> Switch to the paid `render.yaml` later for production.

1. Push this repo to GitHub (already done — `render.yaml` is in the root).
2. Render Dashboard → **New → Blueprint** → select `Aayush3238/EventRelay`.
   Render reads `render.yaml` and creates three services:
   - `eventrelay-api` (web service, Docker)
   - `eventrelay-worker` (background worker, Docker)
   - `eventrelay-dispatcher` (background worker, Docker, `--mode=dispatcher`)
3. In each service → **Environment**, paste the secret values
   (`sync: false` keys in `render.yaml` are placeholders):
   - `DATABASE_URL`, `REDIS_URL` — copy from your local `.env`
   - `JWT_SECRET`, `ENCRYPTION_KEY` — copy from your local `.env`
     (⚠️ `ENCRYPTION_KEY` must be **identical** on API and worker, or signing
     secrets become undecryptable. Use fresh production values and keep them
     backed up.)
   - `CLIENT_URL` — leave for now; you fill it in step 2 below.
4. Click **Deploy**. The API service runs `node db/migrate.js` before
   starting, so the schema is created automatically on first deploy.
5. Note the API URL, e.g. `https://eventrelay-api.onrender.com`.
   Verify: `GET https://eventrelay-api.onrender.com/health` → `{"status":"ok",...}`

## Part 2 — Frontend on Vercel

1. Vercel Dashboard → **Add New → Project** → import the same repo.
2. **Root Directory:** `client` (important — not the repo root).
3. Framework preset: **Vite** (auto-detected). Build command
   `npm run build`, output `dist` (defaults are fine).
4. **Environment Variables:** add
   - `VITE_API_URL` = your Render API URL (e.g. `https://eventrelay-api.onrender.com`)
     — no trailing slash. The dev proxy in `vite.config.js` does NOT apply
     in production; this variable is how the built app finds the API.
5. Deploy. `client/vercel.json` handles SPA routing (refresh on
   `/deliveries` etc. won't 404).
6. Copy the Vercel URL (e.g. `https://event-relay.vercel.app`).

## Part 3 — Connect the two

1. Render → `eventrelay-api` → Environment → set
   `CLIENT_URL=https://<your-vercel-url>` (no trailing slash).
2. **Manual Deploy → Redeploy** the API service (CORS change needs a restart).
3. Open the Vercel app and log in — the browser now calls the Render API
   with your JWT, and CORS allows the Vercel origin.

## Part 4 — Smoke test the whole pipeline

1. In the dashboard: create an **API key** (copy it — shown once).
2. Create an **endpoint** pointing at a *public* HTTPS receiver
   (e.g. a [webhook.site](https://webhook.site) URL, or any public HTTPS
   echo). ⚠️ `http://localhost` endpoints will fail in production —
   SSRF validation blocks private addresses and prod requires HTTPS.
   Copy the **signing secret** (shown once).
3. Ingest an event:
   ```bash
   curl -X POST https://eventrelay-api.onrender.com/v1/events \
     -H "X-API-Key: er_live_...your-key..." \
     -H "Idempotency-Key: smoke-1" \
     -H "Content-Type: application/json" \
     -d '{"type":"order.created","data":{"orderId":"ORD-1"}}'
   ```
   Expect `{"eventId":"...","status":"accepted","deliveriesCreated":1}`.
4. Check the receiver: you should see a POST with
   `X-EventRelay-Signature: t=...,v1=...` and the JSON body.
5. In the dashboard → **Deliveries**: status should be `succeeded`.
   If the receiver returned 500, watch it move to `retrying` and retry —
   that's the backoff working.
6. Test replay: point an endpoint at a URL returning 400 (e.g. webhook.site
   custom response), ingest, see it go `failed`, then hit **Replay** in the
   dashboard → new attempt cycle appears in the attempt history.

## Environment variable reference (Render)

| Variable | API | Worker | Dispatcher | Notes |
|---|---|---|---|---|
| `NODE_ENV=production` | ✓ | ✓ | ✓ | Enforces HTTPS-only endpoints; forbids local allowlist |
| `DATABASE_URL` | ✓ | ✓ | ✓ | Same value everywhere |
| `REDIS_URL` | – | ✓ | ✓ | BullMQ queue |
| `JWT_SECRET` | ✓ | – | – | ≥ 32 chars |
| `ENCRYPTION_KEY` | ✓ | ✓ | – | 32 bytes base64; must match API ⇄ worker |
| `CLIENT_URL` | ✓ | – | – | Vercel URL, no trailing slash |
| `DELIVERY_LEASE_MS` | – | ✓ | – | Default 100000 is fine; must stay ≥ 3× max endpoint timeout + 10s |

Defaults for retries/timeouts (`MAX_ATTEMPTS`, backoff, etc.) are already
sensible — override only if you know why.

## Free-tier caveats (read this!)

- **Render free web services sleep** after ~15 min idle. First request after
  sleep takes ~30–50s (cold start) — the dashboard will feel slow, and the
  worker's outbound webhooks are unaffected, but API calls may time out on
  first hit. A paid instance ($7/mo Starter) fixes this.
- **Background workers on free plans** — Render only allows background
  workers on paid plans in some regions. If the blueprint fails to create
  worker services on free, upgrade the plan or run worker + dispatcher as
  regular web services with a dummy health endpoint as a workaround
  (not recommended long-term).
- **Postgres/Redis free tiers** (Neon/Upstash/Render) have size/connection
  limits — fine for testing, upgrade before real traffic.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard loads, login fails with CORS error | `CLIENT_URL` wrong/missing | Set it to the exact Vercel URL, redeploy API |
| API `/health` 502/503 on Render | Service still building, or free-tier sleeping | Wait/retry; check Render logs |
| Events ingested but never delivered | Dispatcher not running | Check `eventrelay-dispatcher` service is live; check Redis URL |
| Deliveries stuck `processing` | Worker crashed / lease expired, sweeper should recover in ~15s | Check worker logs; verify `ENCRYPTION_KEY` matches API |
| `signing_secret_decrypt_failed` in attempt history | `ENCRYPTION_KEY` differs between API and worker | Set the same value in both services, redeploy both |
| Endpoint creation rejected (422 SSRF) | URL is http in prod, or resolves to a private IP | Use a public HTTPS URL |
| `DELIVERY_LEASE_MS too small` on boot | Lease < 3× max timeout + margin | Raise `DELIVERY_LEASE_MS` (≥ 100000) |

## After every code change

Push to `main` → Render auto-deploys backend → Vercel auto-deploys frontend.
If you changed the SQL schema, the API's startup migration applies it
automatically (migrations are idempotent and tracked in `schema_migrations`).
