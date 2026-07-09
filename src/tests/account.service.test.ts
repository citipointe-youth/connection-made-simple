import { describe, it, expect } from 'vitest';
import { makeAccountService } from '../services/account.service';
import { InMemoryUserRepository } from '../repositories/in-memory';
import { hashPassword } from '../utils/crypto';
import type { Actor } from '../core/entities/user';
import { BadRequestError, UnauthorizedError } from '../core/errors/app-error';

function actorFor(id: string, role: string): Actor {
  return { id, role: role as any, displayName: 'Test', grade: null as any, quad: null as any };
}

async function buildService() {
  const users = new InMemoryUserRepository();
  await users.init();
  const now = new Date().toISOString();
  const grade = await users.save({
    id: 'u-grade', displayName: 'Grade Leader', email: 'grade7g@youth.ministry', role: 'grade',
    grade: 7, quad: null, status: 'active', passwordHash: await hashPassword('correcthorse1'),
    createdAt: now, updatedAt: now,
  });
  const svc = makeAccountService(users);
  return { svc, users, grade };
}

describe('Account Service — self-service password change', () => {
  it('rejects an incorrect current password', async () => {
    const { svc, grade } = await buildService();
    await expect(
      svc.changeOwnPassword(actorFor(grade.id, 'grade'), 'wrongpassword', 'newpassword1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a new password under 8 characters', async () => {
    const { svc, grade } = await buildService();
    await expect(
      svc.changeOwnPassword(actorFor(grade.id, 'grade'), 'correcthorse1', 'short'),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('changes the password when the current one is correct, without requiring admin:manage', async () => {
    const { svc, users, grade } = await buildService();
    await svc.changeOwnPassword(actorFor(grade.id, 'grade'), 'correcthorse1', 'newpassword1');
    const updated = await users.findById(grade.id);
    expect(updated?.passwordHash).not.toBe(grade.passwordHash);
  });
});
