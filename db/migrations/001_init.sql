-- EventRelay initial schema (plan.md §4).
-- History tables use ON DELETE RESTRICT: deleting an endpoint/event must never
-- wipe the delivery + attempt audit trail. Endpoints are soft-deleted instead.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'default',
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX api_keys_user_idx ON api_keys(user_id);

CREATE TABLE endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  signing_secret_encrypted TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ,
  timeout_ms INT NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  max_attempts INT NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX endpoints_user_idx ON endpoints(user_id) WHERE deleted_at IS NULL;

CREATE TABLE endpoint_event_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  UNIQUE (endpoint_id, event_type)
);
CREATE INDEX endpoint_event_types_type_idx ON endpoint_event_types(event_type, endpoint_id);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX events_user_idempotency_uidx
  ON events(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX events_user_created_idx ON events(user_id, created_at DESC);
CREATE INDEX events_type_idx ON events(event_type);

CREATE TABLE deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  endpoint_id UUID NOT NULL REFERENCES endpoints(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','retrying','succeeded','failed')),
  attempt_count INT NOT NULL DEFAULT 0,
  total_attempt_count INT NOT NULL DEFAULT 0,
  replay_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  lock_token TEXT,
  last_response_status INT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  succeeded_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  UNIQUE (event_id, endpoint_id)
);
CREATE INDEX deliveries_endpoint_idx ON deliveries(endpoint_id);
CREATE INDEX deliveries_event_idx ON deliveries(event_id);
CREATE INDEX deliveries_status_next_idx ON deliveries(status, next_attempt_at);
CREATE INDEX deliveries_status_locked_idx ON deliveries(status, locked_until);
CREATE INDEX deliveries_created_idx ON deliveries(created_at DESC);

-- Attempt state machine (plan.md §4.2): in_progress is the only mutable state;
-- once finalized (succeeded/retryable_failure/terminal_failure/worker_lost)
-- rows are immutable history. App code enforces WHERE status='in_progress'.
CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT,
  cycle_number INT NOT NULL,
  attempt_number INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress','succeeded','retryable_failure','terminal_failure','worker_lost')),
  request_timestamp TIMESTAMPTZ,
  response_status INT,
  response_body TEXT,
  response_time_ms INT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts(delivery_id, started_at);

CREATE TABLE outbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_type TEXT NOT NULL CHECK (message_type IN ('delivery.created','delivery.retry','delivery.replay','delivery.recovery')),
  aggregate_id UUID NOT NULL, -- delivery id
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  lock_token TEXT,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX outbox_unpublished_idx
  ON outbox_messages(available_at, created_at) WHERE published_at IS NULL;
