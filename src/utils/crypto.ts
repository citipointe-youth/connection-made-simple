import bcrypt from 'bcryptjs';
import { createHash, timingSafeEqual } from 'node:crypto';

const BCRYPT_ROUNDS = 12;

// Bcrypt hashes always start with "$2b$" or "$2a$".
// Legacy hashes are "hex-salt:sha256-hex".
export function needsRehash(stored: string): boolean {
  return !stored.startsWith('$2b$') && !stored.startsWith('$2a$');
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!needsRehash(stored)) {
    return bcrypt.compare(password, stored);
  }
  // Legacy SHA-256+salt format: "salt:hash"
  const colon = stored.indexOf(':');
  if (colon === -1) return false;
  const salt = stored.slice(0, colon);
  const hash = stored.slice(colon + 1);
  const candidate = createHash('sha256').update(salt + password).digest('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
