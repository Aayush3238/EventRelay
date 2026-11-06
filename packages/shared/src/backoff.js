// Exponential backoff with "full jitter" (AWS-style): delay = random(0, cap).
// Full jitter spreads retries out so 10k simultaneous failures don't
// thundering-herd the receiver in the same millisecond.
function computeBackoffMs(attemptNumber, cfg = {}) {
  const base = Number(cfg.baseDelayMs ?? process.env.BASE_RETRY_DELAY_MS ?? 5000);
  const multiplier = Number(cfg.multiplier ?? process.env.RETRY_MULTIPLIER ?? 2);
  const maxDelay = Number(cfg.maxDelayMs ?? process.env.MAX_RETRY_DELAY_MS ?? 3600000);
  const expDelay = base * Math.pow(multiplier, Math.max(0, attemptNumber - 1));
  const capped = Math.min(expDelay, maxDelay);
  return Math.floor(Math.random() * capped); // full jitter
}

// "Retry-After: 120" (seconds) or an HTTP-date. Returns ms, or null.
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs * 1000);
  const when = Date.parse(headerValue);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

function nextAttemptDelayMs(attemptNumber, retryAfterHeader, cfg = {}) {
  const maxDelay = Number(cfg.maxDelayMs ?? process.env.MAX_RETRY_DELAY_MS ?? 3600000);
  const backoff = computeBackoffMs(attemptNumber, cfg);
  const retryAfter = parseRetryAfterMs(retryAfterHeader);
  const chosen = retryAfter != null ? Math.max(backoff, retryAfter) : backoff;
  return Math.min(chosen, maxDelay);
}

module.exports = { computeBackoffMs, parseRetryAfterMs, nextAttemptDelayMs };
