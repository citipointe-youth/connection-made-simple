import { describe, it, expect } from 'vitest';
import { makeAuthService } from '../services/auth.service';
import { InMemoryUserRepository } from '../repositories/in-memory';
import { hashPassword } from '../utils/crypto';

async function seedUser(mustChangePassword: boolean) {
  const users = new InMemoryUserRepository();
  await users.init();
  const now = new Date().toISOString();
  await users.save({
    id: 'u-1', displayName: 'Director', email: 'director', role: 'director',
    grade: null, quad: null, status: 'active', passwordHash: await hashPassword('correcthorse1'),
    mustChangePassword, createdAt: now, updatedAt: now,
  });
  return { users, auth: makeAuthService(users) };
}

describe('Auth Service — mustChangePassword in the session', () => {
  it('embeds mustChangePassword: true in the token for a flagged account', async () => {
    const { auth } = await seedUser(true);
    const { token } = await auth.login({ email: 'director', password: 'correcthorse1' });
    const actor = await auth.resolveToken(token);
    expect(actor?.mustChangePassword).toBe(true);
  });

  it('embeds mustChangePassword: false for a normal account', async () => {
    const { auth } = await seedUser(false);
    const { token } = await auth.login({ email: 'director', password: 'correcthorse1' });
    const actor = await auth.resolveToken(token);
    expect(actor?.mustChangePassword).toBe(false);
  });

  it('issueTokenFor mints a token reflecting the CURRENT DB state, not the old one', async () => {
    const { users, auth } = await seedUser(true);
    const { token: staleToken } = await auth.login({ email: 'director', password: 'correcthorse1' });
    expect((await auth.resolveToken(staleToken))?.mustChangePassword).toBe(true);

    // Simulate changeOwnPassword() clearing the flag in the DB — the old token
    // is still trusted as-is (that's the bug this covers) until a fresh one is issued.
    const existing = await users.findById('u-1');
    await users.save({ ...existing!, mustChangePassword: false });
    expect((await auth.resolveToken(staleToken))?.mustChangePassword).toBe(true);

    const freshToken = await auth.issueTokenFor('u-1');
    expect(freshToken).not.toBeNull();
    expect((await auth.resolveToken(freshToken!))?.mustChangePassword).toBe(false);
  });

  it('issueTokenFor returns null for a missing or inactive user', async () => {
    const { users, auth } = await seedUser(false);
    expect(await auth.issueTokenFor('no-such-id')).toBeNull();

    const existing = await users.findById('u-1');
    await users.save({ ...existing!, status: 'inactive' });
    expect(await auth.issueTokenFor('u-1')).toBeNull();
  });

  it('issueTokenFor applies actorOverrides on top of the DB state', async () => {
    const { users, auth } = await seedUser(true); // mustChangePassword: true in the DB
    const token = await auth.issueTokenFor('u-1', { mustChangePassword: false });
    expect(token).not.toBeNull();
    const actor = await auth.resolveToken(token!);
    expect(actor?.mustChangePassword).toBe(false);
    // The override is token-only — it must not have touched the DB record.
    const stored = await users.findById('u-1');
    expect(stored?.mustChangePassword).toBe(true);
  });

  it('issueTokenFor honours a custom ttlMs instead of the default 12h (used by account preview for a short-lived token)', async () => {
    const { auth } = await seedUser(false);
    // A token minted with an already-elapsed TTL must resolve as expired
    // immediately — proving ttlMs actually governs expiry, not the default.
    const shortLived = await auth.issueTokenFor('u-1', undefined, -1);
    expect(shortLived).not.toBeNull();
    expect(await auth.resolveToken(shortLived!)).toBeNull();

    const longLived = await auth.issueTokenFor('u-1', undefined, 60_000);
    expect(await auth.resolveToken(longLived!)).not.toBeNull();
  });
});
