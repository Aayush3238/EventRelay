// Shared crypto helpers. Pure Node, no deps — culture of "boring crypto only".
const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';

function getEncryptionKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (base64)');
  return key;
}

// API keys are high-entropy random strings (~132 bits), not human passwords.
// bcrypt here would just burn ~100ms per ingestion request for no extra safety.
// SHA-256 + timingSafeEqual is the right primitive. Passwords still use bcrypt.
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function verifyApiKeyHash(rawKey, storedHex) {
  if (typeof rawKey !== 'string' || typeof storedHex !== 'string') return false;
  const a = Buffer.from(hashApiKey(rawKey), 'hex');
  let b;
  try {
    b = Buffer.from(storedHex, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// er_live_ + 22 base64url chars from 16 random bytes = ~132 bits of entropy.
// Prefix is the first 16 chars (incl. "er_live_"), stored UNIQUE in the DB.
function generateApiKey() {
  const secret = crypto.randomBytes(16).toString('base64url'); // 22 chars
  const raw = `er_live_${secret}`;
  return { raw, prefix: raw.slice(0, 16), hash: hashApiKey(raw) };
}

function generateSigningSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

// AES-256-GCM. Format: iv:authTag:ciphertext (all base64).
// The IV is random per value — encrypting the same secret twice gives
// different rows, which is exactly what you want.
function encryptSecret(plain) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = String(stored).split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

// The exact signing contract from plan.md §7.5:
// HMAC-SHA256(secret, timestamp + "." + rawBody)
function signPayload(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function verifySignature(secret, timestamp, rawBody, signatureHex) {
  const expected = signPayload(secret, timestamp, rawBody);
  const a = Buffer.from(expected, 'hex');
  let b;
  try {
    b = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  hashApiKey,
  verifyApiKeyHash,
  generateApiKey,
  generateSigningSecret,
  encryptSecret,
  decryptSecret,
  signPayload,
  verifySignature,
};
