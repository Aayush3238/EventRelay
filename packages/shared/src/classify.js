// Single source of truth for "was that attempt good, retryable, or dead?".
// Kept pure (no I/O) so it's trivially unit-testable.

function retryableStatusCodes() {
  const raw = process.env.RETRYABLE_STATUS_CODES || '408,425,429';
  const set = new Set(
    raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
  );
  return set;
}

// Outcome: { httpStatus?: number, error?: Error|string, timedOut?: boolean }
// Returns: 'succeeded' | 'retryable_failure' | 'terminal_failure'
function classifyOutcome(outcome = {}) {
  const { httpStatus, error } = outcome;

  if (typeof httpStatus === 'number') {
    if (httpStatus >= 200 && httpStatus < 300) return 'succeeded';
    if (retryableStatusCodes().has(httpStatus)) return 'retryable_failure';
    if (httpStatus >= 500 && httpStatus < 600) return 'retryable_failure';
    // Any other 4xx (and 3xx — we never follow redirects) is terminal.
    return 'terminal_failure';
  }

  // No HTTP response at all: DNS, ECONNREFUSED, TLS, timeout, reset, ...
  // All of those are "try again later" in webhook-land.
  if (error) return 'retryable_failure';

  // Defensive default: unknown shape → terminal, don't retry blindly forever.
  return 'terminal_failure';
}

module.exports = { classifyOutcome, retryableStatusCodes };
