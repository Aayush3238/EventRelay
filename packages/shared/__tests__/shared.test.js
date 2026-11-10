// Unit tests for the shared library. These run anywhere (no DB/Redis needed).
const { crypto, backoff, classify, ssrf } = require('../src');

describe('crypto: api keys', () => {
  it('generates the canonical format with a 16-char prefix', () => {
    const { raw, prefix, hash } = crypto.generateApiKey();
    expect(raw.startsWith('er_live_')).toBe(true);
    expect(prefix).toBe(raw.slice(0, 16));
    expect(prefix).toHaveLength(16);
    expect(crypto.verifyApiKeyHash(raw, hash)).toBe(true);
    expect(crypto.verifyApiKeyHash(raw + 'x', hash)).toBe(false);
  });
});

describe('crypto: AES-256-GCM secrets', () => {
  const prev = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = prev;
  });

  it('round-trips and produces different ciphertext each time', () => {
    const a = crypto.encryptSecret('shh-secret');
    const b = crypto.encryptSecret('shh-secret');
    expect(a).not.toBe(b);
    expect(crypto.decryptSecret(a)).toBe('shh-secret');
    expect(crypto.decryptSecret(b)).toBe('shh-secret');
  });
});

describe('crypto: signing', () => {
  it('signs timestamp.body and verifies', () => {
    const sig = crypto.signPayload('secret', '1700000000', '{"a":1}');
    expect(crypto.verifySignature('secret', '1700000000', '{"a":1}', sig)).toBe(true);
    expect(crypto.verifySignature('secret', '1700000000', '{"a":2}', sig)).toBe(false);
  });
});

describe('backoff', () => {
  it('caps at maxDelay and jitters within bounds', () => {
    for (let i = 0; i < 100; i += 1) {
      const d = backoff.computeBackoffMs(99, { baseDelayMs: 5000, multiplier: 2, maxDelayMs: 60000 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(60000);
    }
  });

  it('honours Retry-After over backoff (capped)', () => {
    const d = backoff.nextAttemptDelayMs(1, '120', { baseDelayMs: 5000, multiplier: 2, maxDelayMs: 3600000 });
    expect(d).toBe(120000);
  });
});

describe('classify', () => {
  it('2xx succeeds', () => {
    expect(classify.classifyOutcome({ httpStatus: 204 })).toBe('succeeded');
  });
  it('408/429/5xx are retryable', () => {
    expect(classify.classifyOutcome({ httpStatus: 408 })).toBe('retryable_failure');
    expect(classify.classifyOutcome({ httpStatus: 429 })).toBe('retryable_failure');
    expect(classify.classifyOutcome({ httpStatus: 503 })).toBe('retryable_failure');
  });
  it('other 4xx and 3xx are terminal', () => {
    expect(classify.classifyOutcome({ httpStatus: 400 })).toBe('terminal_failure');
    expect(classify.classifyOutcome({ httpStatus: 404 })).toBe('terminal_failure');
    expect(classify.classifyOutcome({ httpStatus: 302 })).toBe('terminal_failure');
  });
  it('network errors are retryable', () => {
    expect(classify.classifyOutcome({ error: new Error('ECONNREFUSED') })).toBe('retryable_failure');
  });
});

describe('ssrf: blocked ranges', () => {
  const blocked = [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '198.18.0.1',
    '100.64.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', // IPv4-mapped IPv6
  ];
  it.each(blocked)('blocks %s', (ip) => {
    expect(ssrf.isBlockedIp(ip)).toBe(true);
  });

  const allowed = ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '172.32.0.1'];
  it.each(allowed)('allows %s', (ip) => {
    expect(ssrf.isBlockedIp(ip)).toBe(false);
  });
});

describe('ssrf: validate + pinned lookup', () => {
  it('rejects private IP literals without any DNS call', async () => {
    await expect(
      ssrf.validateEndpointUrl('http://127.0.0.1/hook', { allowLocal: false }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(
      ssrf.validateEndpointUrl('http://[::ffff:127.0.0.1]/hook', { allowLocal: false }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });

  it('allows public IP literals', async () => {
    const out = await ssrf.validateEndpointUrl('https://93.184.216.34/hook', { allowLocal: false });
    expect(out.addresses).toEqual(['93.184.216.34']);
  });

  it('pinnedLookup only hands out validated addresses', (done) => {
    const lookup = ssrf.pinnedLookup('example.com', ['93.184.216.34']);
    lookup('example.com', {}, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
      done();
    });
  });
});
