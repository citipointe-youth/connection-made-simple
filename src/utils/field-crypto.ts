import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Self-describing envelope: "v1.<keyId>.<iv>.<tag>.<ct>" (each part base64url, unpadded).
// The "v1." prefix is the "is this already encrypted?" test — it keeps the backfill
// idempotent and lets reads tolerate a table that is any mix of plaintext + ciphertext.
const VERSION = 'v1';
const IV_LEN = 12; // 96-bit GCM nonce (standard, most efficient)
const KEY_LEN = 32; // AES-256

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeKey(b64: string, id: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`FIELD_ENCRYPTION key '${id}' must decode to ${KEY_LEN} bytes; got ${key.length}`);
  }
  return key;
}

function activeKeyId(): string {
  return process.env['FIELD_ENCRYPTION_KEY_ID'] || 'k1';
}

/** Build the id→key map fresh from the environment on each call (cheap; keeps tests trivial). */
function keyMap(): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  const active = process.env['FIELD_ENCRYPTION_KEY'];
  if (active) m.set(activeKeyId(), decodeKey(active, activeKeyId()));
  const prev = process.env['FIELD_ENCRYPTION_KEY_PREV'];
  if (prev) {
    const prevId = process.env['FIELD_ENCRYPTION_KEY_PREV_ID'] || 'k0';
    m.set(prevId, decodeKey(prev, prevId));
  }
  if (m.size === 0) {
    throw new Error('FIELD_ENCRYPTION_KEY is required to encrypt/decrypt sensitive fields');
  }
  return m;
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(VERSION + '.');
}

export function encryptField(plaintext: string, aad: string): string {
  const id = activeKeyId();
  const key = keyMap().get(id);
  if (!key) throw new Error(`field-crypto: no active key for id '${id}'`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, id, b64url(iv), b64url(tag), b64url(ct)].join('.');
}

export function decryptField(envelope: string, aad: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('field-crypto: malformed ciphertext envelope');
  }
  const id = parts[1]!;
  const key = keyMap().get(id);
  if (!key) throw new Error(`field-crypto: no key for id '${id}'`);
  const decipher = createDecipheriv('aes-256-gcm', key, fromB64url(parts[2]!));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(fromB64url(parts[3]!));
  return Buffer.concat([decipher.update(fromB64url(parts[4]!)), decipher.final()]).toString('utf8');
}

/** Encrypt a nullable scalar. null/undefined/'' → null (never stored as ciphertext). */
export function maybeEncrypt(value: string | null | undefined, aad: string): string | null {
  if (value == null || value === '') return null;
  return encryptField(value, aad);
}

/** Decrypt a value that may be ciphertext, legacy plaintext, or null. */
export function maybeDecrypt(value: string | null | undefined, aad: string): string | null {
  if (value == null) return null;
  if (!isEncrypted(value)) return value; // legacy plaintext passthrough (rollout tolerance)
  return decryptField(value, aad);
}
