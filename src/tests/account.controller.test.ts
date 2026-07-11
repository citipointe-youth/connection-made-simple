import { describe, it, expect } from 'vitest';
import { makeAccountController } from '../api/controllers/account.controller';
import { PREVIEW_TOKEN_TTL_MS } from '../services/auth.service';
import { UnauthorizedError } from '../core/errors/app-error';
import type { Actor, SafeUser } from '../core/entities/user';
import type { HttpRequest } from '../api/http/types';

function actor(role = 'admin'): Actor {
  return { id: 'u-admin', role: role as any, displayName: 'Admin', grade: null as any, quad: null as any };
}

function req(id: string, ctx: Actor | null = actor()): HttpRequest {
  return { ctx, params: { id }, query: {}, body: undefined };
}

const targetUser: SafeUser = {
  id: 'u-grade', displayName: 'Grade 9', email: 'grade9g', role: 'grade', grade: 9 as any,
  quad: null, status: 'active', mustChangePassword: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeStubbed() {
  const calls: { previewAccountId?: string; issueTokenForArgs?: [string, unknown, unknown] } = {};
  const deps = {
    account: {
      previewAccount: async (_actor: Actor, id: string) => { calls.previewAccountId = id; return targetUser; },
    },
    auth: {
      issueTokenFor: async (userId: string, overrides: unknown, ttlMs: unknown) => {
        calls.issueTokenForArgs = [userId, overrides, ttlMs];
        return 'fake-preview-token';
      },
    },
  } as unknown as Parameters<typeof makeAccountController>[0];
  return { ctrl: makeAccountController(deps), calls };
}

describe('account controller — preview', () => {
  it('throws UnauthorizedError with no ctx', async () => {
    const { ctrl } = makeStubbed();
    await expect(ctrl.preview(req('u-grade', null))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('delegates to account.previewAccount with the target id, then mints a short-lived token forcing mustChangePassword:false', async () => {
    const { ctrl, calls } = makeStubbed();
    await ctrl.preview(req('u-grade'));
    expect(calls.previewAccountId).toBe('u-grade');
    expect(calls.issueTokenForArgs).toEqual(['u-grade', { mustChangePassword: false }, PREVIEW_TOKEN_TTL_MS]);
    // Preview tokens must use a materially shorter TTL than a normal 12h login.
    expect(PREVIEW_TOKEN_TTL_MS).toBeLessThan(12 * 60 * 60 * 1000);
  });

  it('returns the token and a user object with mustChangePassword forced false, even though the DB record has it true', async () => {
    const { ctrl } = makeStubbed();
    const result = await ctrl.preview(req('u-grade')) as { token: string; user: SafeUser };
    expect(result.token).toBe('fake-preview-token');
    expect(result.user.mustChangePassword).toBe(false);
    expect(result.user.id).toBe('u-grade');
  });
});
