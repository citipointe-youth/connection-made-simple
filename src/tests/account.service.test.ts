import { describe, it, expect } from 'vitest';
import { makeAccountService } from '../services/account.service';
import { InMemoryUserRepository, InMemorySettingsRepository } from '../repositories/in-memory';
import { hashPassword } from '../utils/crypto';
import type { Actor } from '../core/entities/user';
import { BadRequestError, UnauthorizedError, NotFoundError, ForbiddenError } from '../core/errors/app-error';

function actorFor(id: string, role: string): Actor {
  return { id, role: role as any, displayName: 'Test', grade: null as any, quad: null as any };
}

async function buildService() {
  const users = new InMemoryUserRepository();
  await users.init();
  const now = new Date().toISOString();
  const grade = await users.save({
    id: 'u-grade', displayName: 'Grade Leader', email: 'grade7g', role: 'grade',
    grade: 7, quad: null, status: 'active', passwordHash: await hashPassword('correcthorse1'),
    mustChangePassword: true, createdAt: now, updatedAt: now,
  });
  const settings = new InMemorySettingsRepository();
  await settings.init();
  const svc = makeAccountService(users, settings);
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

  it('clears mustChangePassword on a successful self-change', async () => {
    const { svc, users, grade } = await buildService();
    expect(grade.mustChangePassword).toBe(true);
    await svc.changeOwnPassword(actorFor(grade.id, 'grade'), 'correcthorse1', 'newpassword1');
    const updated = await users.findById(grade.id);
    expect(updated?.mustChangePassword).toBe(false);
  });

  it('leaves mustChangePassword untouched when the current password is wrong', async () => {
    const { svc, users, grade } = await buildService();
    await expect(
      svc.changeOwnPassword(actorFor(grade.id, 'grade'), 'wrongpassword', 'newpassword1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    const unchanged = await users.findById(grade.id);
    expect(unchanged?.mustChangePassword).toBe(true);
  });
});

describe('Account Service — create() defaults mustChangePassword to false', () => {
  it('a freshly admin-created account is not flagged', async () => {
    const users = new InMemoryUserRepository();
    await users.init();
    const settings = new InMemorySettingsRepository();
    await settings.init();
    const svc = makeAccountService(users, settings);
    const admin = actorFor('u-admin', 'admin');
    const created = await svc.create(admin, {
      displayName: 'New Leader', email: 'newleader', password: 'longenoughpw',
      role: 'grade', grade: 8, gender: 'female',
    });
    const stored = await users.findById(created.id);
    expect(stored?.mustChangePassword).toBe(false);
  });
});

describe('Account Service — the protected admin account (username "admin") is always protected', () => {
  // Sets up TWO admin-role accounts: one with username "admin" (the protected
  // one) and a second, differently-named admin ("Ops Admin") that should
  // remain freely manageable — the guard must key off username/email, not role.
  async function buildTwoAdmins() {
    const users = new InMemoryUserRepository();
    await users.init();
    const now = new Date().toISOString();
    const admin = await users.save({
      id: 'u-admin-named', displayName: 'Admin', email: 'admin', role: 'admin',
      grade: null, quad: null, status: 'active', passwordHash: await hashPassword('correcthorse1'),
      mustChangePassword: false, createdAt: now, updatedAt: now,
    });
    const opsAdmin = await users.save({
      id: 'u-admin-ops', displayName: 'Ops Admin', email: 'ops', role: 'admin',
      grade: null, quad: null, status: 'active', passwordHash: await hashPassword('correcthorse1'),
      mustChangePassword: false, createdAt: now, updatedAt: now,
    });
    const settings = new InMemorySettingsRepository();
    await settings.init();
    const svc = makeAccountService(users, settings);
    const actor = actorFor(admin.id, 'admin');
    return { svc, users, admin, opsAdmin, actor };
  }

  it('cannot delete the account named "Admin", even with other admin accounts present', async () => {
    const { svc, actor, admin } = await buildTwoAdmins();
    await expect(svc.remove(actor, admin.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('cannot deactivate the account named "Admin", even with other admin accounts present', async () => {
    const { svc, actor, admin } = await buildTwoAdmins();
    await expect(svc.toggleStatus(actor, admin.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('cannot change the username of the protected admin account via update()', async () => {
    const { svc, actor, admin } = await buildTwoAdmins();
    await expect(
      svc.update(actor, admin.id, { email: 'notadmin' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('other fields on the protected admin account (e.g. displayName) remain freely editable', async () => {
    const { svc, users, actor, admin } = await buildTwoAdmins();
    const updated = await svc.update(actor, admin.id, { displayName: 'Youth Pastor' });
    expect(updated.displayName).toBe('Youth Pastor');
    const stored = await users.findById(admin.id);
    expect(stored?.email).toBe('admin');
  });

  it('submitting username unchanged ("admin") via update() is not blocked', async () => {
    const { svc, actor, admin } = await buildTwoAdmins();
    const updated = await svc.update(actor, admin.id, { email: 'admin', displayName: 'Head Admin' });
    expect(updated.email).toBe('admin');
    expect(updated.displayName).toBe('Head Admin');
  });

  it('a second admin account with a different display name CAN be deleted', async () => {
    const { svc, users, actor, opsAdmin } = await buildTwoAdmins();
    await svc.remove(actor, opsAdmin.id);
    expect(await users.findById(opsAdmin.id)).toBeNull();
  });

  it('a second admin account with a different display name CAN be deactivated', async () => {
    const { svc, actor, opsAdmin } = await buildTwoAdmins();
    const updated = await svc.toggleStatus(actor, opsAdmin.id);
    expect(updated.status).toBe('inactive');
  });

  it('a second admin account with a different display name CAN be renamed', async () => {
    const { svc, actor, opsAdmin } = await buildTwoAdmins();
    const updated = await svc.update(actor, opsAdmin.id, { displayName: 'Renamed Ops Admin' });
    expect(updated.displayName).toBe('Renamed Ops Admin');
  });

  it('back-compat: an account already renamed away from username "admin" (under the old displayName-locked rules) is still protected by its displayName', async () => {
    const users = new InMemoryUserRepository();
    await users.init();
    const now = new Date().toISOString();
    const renamedAdmin = await users.save({
      id: 'u-renamed-admin', displayName: 'Admin', email: 'headoffice', role: 'admin',
      grade: null, quad: null, status: 'active', passwordHash: await hashPassword('correcthorse1'),
      mustChangePassword: false, createdAt: now, updatedAt: now,
    });
    const settings = new InMemorySettingsRepository();
    await settings.init();
    const svc = makeAccountService(users, settings);
    const actor = actorFor(renamedAdmin.id, 'admin');
    await expect(svc.remove(actor, renamedAdmin.id)).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      svc.update(actor, renamedAdmin.id, { email: 'somethingelse' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('a second, freely-named admin account CAN be created alongside the protected "Admin" one', async () => {
    const { svc, actor } = await buildTwoAdmins();
    const created = await svc.create(actor, {
      displayName: 'Yet Another Admin', email: 'yetanother', password: 'longenoughpw',
      role: 'admin',
    });
    expect(created.role).toBe('admin');
    expect(created.displayName).toBe('Yet Another Admin');
  });

  it('the pre-existing "last remaining admin" guard still blocks deleting the sole admin, unchanged', async () => {
    // Only ONE admin account total, and it is NOT named "Admin" — this must
    // still be blocked by guardAdmin's last-admin check, proving that guard
    // is untouched by the new displayName-based protection.
    const users = new InMemoryUserRepository();
    await users.init();
    const now = new Date().toISOString();
    const sole = await users.save({
      id: 'u-sole-admin', displayName: 'Sole Admin', email: 'sole', role: 'admin',
      grade: null, quad: null, status: 'active', passwordHash: await hashPassword('correcthorse1'),
      mustChangePassword: false, createdAt: now, updatedAt: now,
    });
    const settings = new InMemorySettingsRepository();
    await settings.init();
    const svc = makeAccountService(users, settings);
    const actor = actorFor(sole.id, 'admin');
    await expect(svc.remove(actor, sole.id)).rejects.toBeInstanceOf(BadRequestError);
    await expect(svc.toggleStatus(actor, sole.id)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('the last-remaining-admin guard still allows deleting a non-"Admin"-named admin once a second admin exists', async () => {
    const { svc, users, actor, admin, opsAdmin } = await buildTwoAdmins();
    // Two admins exist ("Admin" + "Ops Admin"); deleting the non-protected one
    // should succeed under both guards (not the last admin, not named "Admin").
    await svc.remove(actor, opsAdmin.id);
    expect(await users.findById(opsAdmin.id)).toBeNull();
    // The protected "Admin" account must still be present and undeletable now
    // that it actually IS the last remaining admin too.
    await expect(svc.remove(actor, admin.id)).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('Account Service — cohort account layout (bug 8)', () => {
  const admin = actorFor('adm', 'admin');

  it('plan is a pure dry-run — nothing is written', async () => {
    const { svc, users } = await buildService();
    const plan = await svc.planCohortLayout(admin, 'none');
    expect(plan.toCreate).toHaveLength(6);
    expect(await users.findAll()).toHaveLength(1); // just the seeded grade7g account from buildService()
  });

  it('apply creates the target accounts with one-time passwords and mustChangePassword: true', async () => {
    const { svc, users } = await buildService();
    const report = await svc.applyCohortLayout(admin, 'none');
    expect(report.created).toHaveLength(6);
    expect(report.created.every((c) => c.password.length >= 8)).toBe(true);
    const created = await users.findByEmail('grade78g');
    expect(created?.mustChangePassword).toBe(true);
    expect(created?.gender).toBe('female');
    expect(created?.grades).toEqual([7, 8]);
  });

  it('re-applying the same layout is a no-op the second time', async () => {
    const { svc } = await buildService();
    await svc.applyCohortLayout(admin, 'none');
    const second = await svc.applyCohortLayout(admin, 'none');
    expect(second.created).toHaveLength(0);
    expect(second.deactivated).toHaveLength(0);
  });

  it('applying Complex deactivates the pre-existing grade7g seed account (outside the 12-grade+quad target only if not matching) — verifies matching, not blanket wipe', async () => {
    const { svc, users } = await buildService();
    // grade7g already matches the Complex layout's own username convention,
    // so it must be left alone, not deactivated.
    await svc.applyCohortLayout(admin, 'grades-quads');
    const stillActive = await users.findByEmail('grade7g');
    expect(stillActive?.status).toBe('active');
  });

  it('rejects a non-admin caller', async () => {
    const { svc } = await buildService();
    const grade = actorFor('g', 'grade');
    await expect(svc.planCohortLayout(grade, 'none')).rejects.toBeInstanceOf(Error);
  });
});

describe('Account Service — previewAccount()', () => {
  async function buildPreviewFixtures() {
    const users = new InMemoryUserRepository();
    await users.init();
    const now = new Date().toISOString();
    const mk = (over: Partial<Parameters<typeof users.save>[0]>) => users.save({
      id: over.id!, displayName: over.displayName!, email: over.email!, role: over.role!,
      grade: over.grade ?? null, quad: over.quad ?? null, status: over.status ?? 'active',
      passwordHash: 'x', mustChangePassword: over.mustChangePassword ?? false,
      createdAt: now, updatedAt: now,
    });
    const gradeUser = await mk({ id: 'u-grade', displayName: 'Grade 9', email: 'grade9g', role: 'grade', grade: 9 });
    const quadUser = await mk({ id: 'u-quad', displayName: 'Girls Yr 7-9', email: 'g79', role: 'quad', quad: 'g79' });
    const inactiveGrade = await mk({ id: 'u-inactive', displayName: 'Grade 10', email: 'grade10g', role: 'grade', grade: 10, status: 'inactive' });
    const directorUser = await mk({ id: 'u-director', displayName: 'Director', email: 'director', role: 'director' });
    const leaderUser = await mk({ id: 'u-leader', displayName: 'Leader', email: 'leader1', role: 'leader' });
    const settings = new InMemorySettingsRepository();
    await settings.init();
    const svc = makeAccountService(users, settings);
    return { svc, gradeUser, quadUser, inactiveGrade, directorUser, leaderUser };
  }

  it('rejects a non-admin actor', async () => {
    const { svc, gradeUser } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-other-grade', 'grade'), gradeUser.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('404s for a missing account id', async () => {
    const { svc } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-admin', 'admin'), 'no-such-id'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an inactive account', async () => {
    const { svc, inactiveGrade } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-admin', 'admin'), inactiveGrade.id),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects a director account', async () => {
    const { svc, directorUser } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-admin', 'admin'), directorUser.id),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects a leader account', async () => {
    const { svc, leaderUser } = await buildPreviewFixtures();
    await expect(
      svc.previewAccount(actorFor('u-admin', 'admin'), leaderUser.id),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('returns a SafeUser (no passwordHash) for an active grade account', async () => {
    const { svc, gradeUser } = await buildPreviewFixtures();
    const result = await svc.previewAccount(actorFor('u-admin', 'admin'), gradeUser.id);
    expect(result.id).toBe(gradeUser.id);
    expect(result.role).toBe('grade');
    expect((result as any).passwordHash).toBeUndefined();
  });

  it('returns a SafeUser for an active quad account', async () => {
    const { svc, quadUser } = await buildPreviewFixtures();
    const result = await svc.previewAccount(actorFor('u-admin', 'admin'), quadUser.id);
    expect(result.id).toBe(quadUser.id);
    expect(result.role).toBe('quad');
  });
});
