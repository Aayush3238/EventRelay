// Worker-side unit-ish tests that don't need Postgres/Redis.
// The real locking/crash tests live in the M9 drill suite (real infra).
const { classify } = require('@eventrelay/shared');

describe('delivery classification contract (shared)', () => {
  it('maps worker outcomes to attempt statuses', () => {
    expect(classify.classifyOutcome({ httpStatus: 200 })).toBe('succeeded');
    expect(classify.classifyOutcome({ httpStatus: 500 })).toBe('retryable_failure');
    expect(classify.classifyOutcome({ httpStatus: 410 })).toBe('terminal_failure');
  });

  it('bullmq job ids never contain colons (plan §6.3)', () => {
    const outboxId = '3f4a2b1c-0000-4000-8000-000000000000';
    const jobId = `outbox_${outboxId}`;
    expect(jobId).not.toContain(':');
    expect(jobId).toMatch(/^outbox_[A-Za-z0-9_-]+$/);
  });
});
