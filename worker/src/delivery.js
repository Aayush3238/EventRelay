// The delivery engine. Claim (one TX) → HTTP (no TX) → finalize (one TX).
// That ordering is the whole ballgame: a DB transaction must never be open
// while we wait on someone else's server.
const crypto = require('node:crypto');
const { query, withTransaction } = require('./db');
const config = require('./config');
const logger = require('./logger');
const { postWebhook } = require('./httpClient');
const { decryptSecret, signPayload } = require('@eventrelay/shared').crypto;
const { classifyOutcome } = require('@eventrelay/shared').classify;
const { nextAttemptDelayMs } = require('@eventrelay/shared').backoff;
const { validateEndpointUrl, pinnedLookup } = require('@eventrelay/shared').ssrf;

async function claimDelivery(deliveryId) {
  const lockToken = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const { rows } = await query(
    `WITH claimed AS (
       UPDATE deliveries
       SET status = 'processing',
           lock_token = $2,
           locked_until = NOW() + make_interval(secs => $3 / 1000.0),
           attempt_count = attempt_count + 1,
           total_attempt_count = total_attempt_count + 1,
           next_attempt_at = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND (status IN ('pending','retrying')
              OR (status = 'processing' AND locked_until < NOW()))
       RETURNING *
     ), attempt AS (
       INSERT INTO delivery_attempts (id, delivery_id, cycle_number, attempt_number, status, started_at)
       SELECT $4, id, replay_count + 1, attempt_count, 'in_progress', NOW()
       FROM claimed
       RETURNING id
     )
     SELECT c.*, a.id AS attempt_id FROM claimed c JOIN attempt a ON true`,
    [deliveryId, lockToken, config.leaseMs, attemptId],
  );
  return rows[0] || null;
}

async function loadContext(deliveryId) {
  const { rows } = await query(
    `SELECT d.id AS delivery_id, d.event_id, d.endpoint_id, d.attempt_count,
            d.replay_count, ev.event_type, ev.payload, ev.created_at AS event_created_at,
            ep.url, ep.signing_secret_encrypted, ep.timeout_ms, ep.max_attempts,
            ep.is_active, ep.deleted_at
     FROM deliveries d
     JOIN events ev ON ev.id = d.event_id
     JOIN endpoints ep ON ep.id = d.endpoint_id
     WHERE d.id = $1`,
    [deliveryId],
  );
  return rows[0] || null;
}

// Finalize under our lock token. If the UPDATE hits 0 rows we lost the lease —
// a stale worker must not write anything (no state change, no retry outbox).
async function finalize({
  deliveryId,
  attemptId,
  lockToken,
  outcome,
  httpStatus,
  responseBody,
  responseTimeMs,
  errorMessage,
  retryAfterHeader,
  ctx,
}) {
  const attemptStatus = outcome; // succeeded | retryable_failure | terminal_failure
  const maxAttempts = ctx.max_attempts || config.maxAttempts;
  const attemptCount = ctx.attempt_count; // already incremented at claim

  let nextStatus = 'failed';
  let nextAttemptAt = null;
  let succeededAt = null;
  let deadLetteredAt = null;
  let enqueueRetry = false;

  if (outcome === 'succeeded') {
    nextStatus = 'succeeded';
    succeededAt = new Date();
  } else if (outcome === 'retryable_failure' && attemptCount < maxAttempts) {
    const delayMs = nextAttemptDelayMs(attemptCount, retryAfterHeader, {
      baseDelayMs: config.baseDelayMs,
      multiplier: config.multiplier,
      maxDelayMs: config.maxDelayMs,
    });
    nextAttemptAt = new Date(Date.now() + delayMs);
    nextStatus = 'retrying';
    enqueueRetry = true;
  } else {
    nextStatus = 'failed';
    deadLetteredAt = new Date();
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE deliveries
       SET status = $2, last_response_status = $3, last_error = $4,
           next_attempt_at = $5, succeeded_at = $6, dead_lettered_at = $7,
           lock_token = NULL, locked_until = NULL, updated_at = NOW()
       WHERE id = $1 AND lock_token = $8
       RETURNING id`,
      [
        deliveryId,
        nextStatus,
        httpStatus ?? null,
        errorMessage ?? null,
        nextAttemptAt,
        succeededAt,
        deadLetteredAt,
        lockToken,
      ],
    );
    if (!rows.length) {
      // Stale worker: someone else owns this delivery now. Roll back (nothing
      // else was written in this TX) and let the owner drive.
      logger.warn({ deliveryId, attemptId }, 'finalize skipped: lock lost (stale worker)');
      return { stale: true };
    }

    await client.query(
      `UPDATE delivery_attempts
       SET status = $2, response_status = $3, response_body = $4,
           response_time_ms = $5, error_message = $6, completed_at = NOW()
       WHERE id = $1 AND status = 'in_progress'`,
      [
        attemptId,
        attemptStatus,
        httpStatus ?? null,
        responseBody ?? null,
        responseTimeMs ?? null,
        errorMessage ?? null,
      ],
    );

    if (enqueueRetry) {
      // Same TX as the state change — the retry intent is durable before
      // the dispatcher ever hears about it.
      await client.query(
        `INSERT INTO outbox_messages (id, message_type, aggregate_id, available_at)
         VALUES ($1, 'delivery.retry', $2, $3)`,
        [crypto.randomUUID(), deliveryId, nextAttemptAt],
      );
    }
    return { stale: false, status: nextStatus };
  });
}

async function processDelivery(deliveryId) {
  const claimed = await claimDelivery(deliveryId);
  if (!claimed) return { skipped: true }; // someone else holds it — fine.

  const ctx = await loadContext(deliveryId);
  if (!ctx) return { skipped: true };

  const log = logger.child({ deliveryId, attemptId: claimed.attempt_id });

  // Dead endpoint → terminal, immediately. Don't burn retries on a URL
  // the operator already switched off.
  if (!ctx.is_active || ctx.deleted_at) {
    await finalize({
      deliveryId,
      attemptId: claimed.attempt_id,
      lockToken: claimed.lock_token,
      outcome: 'terminal_failure',
      errorMessage: 'endpoint_inactive',
      ctx,
    });
    return { status: 'failed' };
  }

  // SSRF re-validation at delivery time (endpoint could have been created
  // when DNS was clean and rebinding since). Pinned lookup closes the gap.
  let addresses = [];
  try {
    const validated = await validateEndpointUrl(ctx.url);
    addresses = validated.addresses;
  } catch (err) {
    const isSsrf = err.code === 'SSRF_BLOCKED';
    log.warn({ err: err.message }, 'endpoint URL failed SSRF validation at delivery time');
    await finalize({
      deliveryId,
      attemptId: claimed.attempt_id,
      lockToken: claimed.lock_token,
      outcome: isSsrf ? 'terminal_failure' : 'retryable_failure',
      errorMessage: `ssrf_validation: ${err.message}`,
      ctx,
    });
    return { status: isSsrf ? 'failed' : 'retrying' };
  }

  const rawBody = JSON.stringify({
    id: ctx.event_id,
    type: ctx.event_type,
    createdAt: new Date(ctx.event_created_at).toISOString(),
    data: ctx.payload,
  });

  let secret;
  try {
    secret = decryptSecret(ctx.signing_secret_encrypted);
  } catch (err) {
    log.error({ err }, 'could not decrypt signing secret');
    await finalize({
      deliveryId,
      attemptId: claimed.attempt_id,
      lockToken: claimed.lock_token,
      outcome: 'terminal_failure',
      errorMessage: 'signing_secret_decrypt_failed',
      ctx,
    });
    return { status: 'failed' };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(secret, timestamp, rawBody);

  const headers = {
    'Content-Type': 'application/json',
    'X-EventRelay-Event-Id': ctx.event_id,
    'X-EventRelay-Delivery-Id': deliveryId,
    'X-EventRelay-Timestamp': String(timestamp),
    'X-EventRelay-Signature': `t=${timestamp},v1=${signature}`,
  };

  let result;
  try {
    result = await postWebhook({
      url: ctx.url,
      headers,
      body: rawBody,
      timeoutMs: ctx.timeout_ms,
      lookup: pinnedLookup(new URL(ctx.url).hostname, addresses),
      maxResponseBytes: config.maxResponseBytes,
    });
  } catch (err) {
    const outcome = classifyOutcome({ error: err });
    await finalize({
      deliveryId,
      attemptId: claimed.attempt_id,
      lockToken: claimed.lock_token,
      outcome,
      errorMessage: String(err.message || err).slice(0, 2000),
      ctx,
    });
    return { status: outcome === 'retryable_failure' ? 'retrying' : 'failed' };
  }

  const outcome = classifyOutcome({ httpStatus: result.status });
  const errorMessage = result.truncated
    ? 'response body truncated at cap'
    : outcome === 'succeeded'
      ? null
      : `HTTP ${result.status}`;
  await finalize({
    deliveryId,
    attemptId: claimed.attempt_id,
    lockToken: claimed.lock_token,
    outcome,
    httpStatus: result.status,
    responseBody: result.body ? result.body.slice(0, 8192) : null,
    responseTimeMs: result.responseTimeMs,
    errorMessage,
    retryAfterHeader: result.headers?.['retry-after'],
    ctx,
  });
  return { status: outcome === 'succeeded' ? 'succeeded' : outcome };
}

module.exports = { processDelivery, claimDelivery, finalize };
