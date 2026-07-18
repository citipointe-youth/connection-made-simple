import { describe, it, expect, beforeAll } from 'vitest';
import {
  isEncrypted, encryptField, decryptField, maybeEncrypt, maybeDecrypt,
} from '../utils/field-crypto';

const KEY = Buffer.alloc(32, 1).toString('base64');
const KEY2 = Buffer.alloc(32, 2).toString('base64');

beforeAll(() => {
  process.env['FIELD_ENCRYPTION_KEY'] = KEY;
  process.env['FIELD_ENCRYPTION_KEY_ID'] = 'k1';
});

describe('field-crypto', () => {
  it('round-trips a value under matching AAD', () => {
    const ct = encryptField('0411928301', 'students:mobile:s_1');
    expect(isEncrypted(ct)).toBe(true);
    expect(ct.startsWith('v1.k1.')).toBe(true);
    expect(decryptField(ct, 'students:mobile:s_1')).toBe('0411928301');
  });

  it('produces a fresh IV each call (ciphertexts differ)', () => {
    const a = encryptField('x', 'students:mobile:s_1');
    const b = encryptField('x', 'students:mobile:s_1');
    expect(a).not.toBe(b);
  });

  it('rejects decryption under the wrong AAD (bound to row+column)', () => {
    const ct = encryptField('secret', 'students:mobile:s_1');
    expect(() => decryptField(ct, 'students:mobile:s_2')).toThrow();
  });

  it('rejects a tampered ciphertext (auth tag fails)', () => {
    const ct = encryptField('secret', 'students:parent_phone:s_1');
    const parts = ct.split('.');
    const flipped = parts[4]!.slice(0, -2) + (parts[4]!.endsWith('A') ? 'B' : 'A');
    const bad = [parts[0], parts[1], parts[2], parts[3], flipped].join('.');
    expect(() => decryptField(bad, 'students:parent_phone:s_1')).toThrow();
  });

  it('maybeEncrypt passes null/empty through as null', () => {
    expect(maybeEncrypt(null, 'a')).toBeNull();
    expect(maybeEncrypt(undefined, 'a')).toBeNull();
    expect(maybeEncrypt('', 'a')).toBeNull();
  });

  it('maybeDecrypt passes null and legacy plaintext through unchanged', () => {
    expect(maybeDecrypt(null, 'a')).toBeNull();
    expect(maybeDecrypt('0400111222', 'a')).toBe('0400111222');
  });

  it('decrypts ciphertext written under a now-PREV key', () => {
    const ct = encryptField('rotate me', 'students:parent_phone:s_9');
    process.env['FIELD_ENCRYPTION_KEY'] = KEY2;
    process.env['FIELD_ENCRYPTION_KEY_ID'] = 'k2';
    process.env['FIELD_ENCRYPTION_KEY_PREV'] = KEY;
    process.env['FIELD_ENCRYPTION_KEY_PREV_ID'] = 'k1';
    expect(decryptField(ct, 'students:parent_phone:s_9')).toBe('rotate me');
    process.env['FIELD_ENCRYPTION_KEY'] = KEY;
    process.env['FIELD_ENCRYPTION_KEY_ID'] = 'k1';
    delete process.env['FIELD_ENCRYPTION_KEY_PREV'];
    delete process.env['FIELD_ENCRYPTION_KEY_PREV_ID'];
  });
});
