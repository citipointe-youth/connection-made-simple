import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { generateId } from '../utils/id';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { assertCan } from './access-control';
import type { IUserRepository, ISettingsRepository } from '../repositories/interfaces/entity-repositories';
import type { User, SafeUser } from '../core/entities/user';
import type { Actor } from '../core/entities/user';
import type { UserRole, Grade, Quad } from '../core/types/enums';
import { NotFoundError, BadRequestError, ConflictError, UnauthorizedError } from '../core/errors/app-error';
import { planCohortAccountLayout, type CohortLayoutPlan } from './cohort-account-layout';

const CohortModelSchema = z.enum(['grades-quads', 'none']);

const CreateUserSchema = z.object({
  displayName: z.string().min(1),
  email: z.string().min(1),
  password: z.string().min(8),
  role: z.enum(['leader', 'grade', 'quad', 'director', 'admin']),
  // For a `leader` (junior leader) account — the Leader record it is bound to.
  leaderId: z.string().nullable().optional(),
  // Legacy single-grade field (back-compat). New account forms send `grades`.
  grade: z.number().int().min(7).max(12).nullable().optional(),
  // Multi-grade grade accounts (§5.1a): one or more grades. When present it is
  // authoritative and `grade` is derived from it.
  grades: z.array(z.number().int().min(7).max(12)).nullable().optional(),
  // Explicit gender scope for a grade login (null = both). Required in practice
  // for a >1-grade account; optional for single-grade ones (email convention).
  gender: z.enum(['male', 'female']).nullable().optional(),
  quad: z.enum(['g79', 'b79', 'g1012', 'b1012']).nullable().optional(),
});

/**
 * Normalise the incoming grade/grades pair into the stored representation:
 * `grades` is the full deduped, sorted set; `grade` is the single-grade
 * back-compat anchor (set only when exactly one grade, else null). Returns
 * undefined when neither field was supplied (so a partial update leaves them
 * untouched).
 */
function normaliseGrades(
  grade: number | null | undefined,
  grades: number[] | null | undefined,
): { grade: Grade | null; grades: Grade[] } | undefined {
  let list: number[] | undefined;
  if (grades !== undefined && grades !== null) list = grades;
  else if (grade !== undefined && grade !== null) list = [grade];
  else if (grades === null || grade === null) list = [];
  else return undefined;
  const uniq = [...new Set(list)].sort((a, b) => a - b) as Grade[];
  return { grade: (uniq.length === 1 ? uniq[0]! : null) as Grade | null, grades: uniq };
}

function toSafe(u: User): SafeUser {
  const { passwordHash: _pw, ...safe } = u;
  return safe as SafeUser;
}

// The bootstrap admin account (seeded username "admin") can never be deleted or
// deactivated, and its USERNAME can never be changed — that's the stable login
// identity. Its display name is freely editable like any other account's (bug 9,
// 2026-07-12 — the lock used to be on displayName instead, which was backwards:
// a display name is a human-friendly label, the username is the actual
// credential). Also matches on displayName === 'Admin' for back-compat with any
// account that was already renamed away from the literal username "admin" back
// when email was the freely-editable field — so a prior rename can't accidentally
// strip protection from the real bootstrap account.
function isProtectedAdmin(u: User): boolean {
  return u.email === 'admin' || u.displayName === 'Admin';
}

export interface CohortLayoutApplyReport {
  created: { username: string; displayName: string; password: string }[];
  deactivated: { username: string; displayName: string }[];
}

export interface AccountService {
  list(actor: Actor): Promise<SafeUser[]>;
  create(actor: Actor, input: unknown): Promise<SafeUser>;
  update(actor: Actor, id: string, input: unknown): Promise<SafeUser>;
  setPassword(actor: Actor, id: string, newPassword: string): Promise<void>;
  // Self-service password change: any authenticated actor may change their OWN
  // password by proving they know the current one — no admin:manage permission
  // needed. Distinct from setPassword() above, which is the admin-managing-
  // another-account flow and is untouched by this.
  changeOwnPassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void>;
  toggleStatus(actor: Actor, id: string): Promise<SafeUser>;
  // Admin-only: validates `id` is an active grade/quad account and returns it, for the
  // account-preview feature (Admin -> Accounts "Preview"). Does NOT mint a token itself —
  // the controller separately calls AuthService.issueTokenFor for that.
  previewAccount(actor: Actor, id: string): Promise<SafeUser>;
  remove(actor: Actor, id: string): Promise<void>;
  // Bug 8 (admin bug list, 2026-07-11): "Apply account layout" — a separate,
  // explicit, typed-confirm action in Youth Setup (not tied to Save) that
  // reconciles Accounts with the target cohort model. planCohortLayout is the
  // dry-run preview; applyCohortLayout actually creates/deactivates accounts.
  planCohortLayout(actor: Actor, targetCohort: unknown): Promise<CohortLayoutPlan>;
  applyCohortLayout(actor: Actor, targetCohort: unknown): Promise<CohortLayoutApplyReport>;
}

function generateTempPassword(): string {
  // 12 base64url chars (72 bits) — comfortably over the 8-char minimum and
  // never contains characters that need escaping when shown/copied.
  return randomBytes(9).toString('base64url');
}

export function makeAccountService(users: IUserRepository, settings: ISettingsRepository): AccountService {
  async function guardAdmin(id: string, action: string) {
    const admins = await users.findByRole('admin');
    if (admins.length <= 1) {
      throw new BadRequestError(`Cannot ${action} the only admin account`);
    }
  }

  return {
    async list(actor) {
      assertCan(actor, 'admin:manage');
      const all = await users.findAll();
      return all
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map(toSafe);
    },

    async create(actor, input) {
      assertCan(actor, 'admin:manage');
      const data = CreateUserSchema.parse(input);
      const existing = await users.findByEmail(data.email);
      if (existing) throw new ConflictError('Username already in use');

      const gradeSet = normaliseGrades(data.grade, data.grades);
      if (data.role === 'grade' && (!gradeSet || gradeSet.grades.length === 0)) {
        throw new BadRequestError('Grade login requires at least one grade');
      }
      if (data.role === 'grade' && data.gender == null) {
        throw new BadRequestError('Grade login requires a gender scope');
      }
      if (data.role === 'quad' && data.quad == null) {
        throw new BadRequestError('Quad login requires a quad');
      }
      if (data.role === 'leader' && !data.leaderId) {
        throw new BadRequestError('Junior leader login requires a linked leader record');
      }

      const passwordHash = await hashPassword(data.password);
      const now = new Date().toISOString();
      const user: User = {
        id: generateId(),
        displayName: data.displayName,
        email: data.email,
        role: data.role as UserRole,
        grade: gradeSet ? gradeSet.grade : ((data.grade ?? null) as Grade | null),
        grades: gradeSet ? gradeSet.grades : null,
        gender: data.role === 'grade' ? (data.gender ?? null) : null,
        quad: (data.quad ?? null) as Quad | null,
        leaderId: data.role === 'leader' ? (data.leaderId ?? null) : null,
        status: 'active',
        passwordHash,
        mustChangePassword: false,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await users.save(user);
      return toSafe(saved);
    },

    async update(actor, id, input) {
      assertCan(actor, 'admin:manage');
      const existing = await users.findById(id);
      if (!existing) throw new NotFoundError('User not found');
      if (existing.role === 'admin') await guardAdmin(id, 'modify');
      const patch = CreateUserSchema.omit({ password: true }).partial().parse(input);
      // The protected admin account's username is its stable login identity — it
      // can never be changed, unlike its display name (see isProtectedAdmin above).
      if (isProtectedAdmin(existing) && patch.email !== undefined && patch.email !== existing.email) {
        throw new BadRequestError("This account's username cannot be changed");
      }
      // Email is editable (so grade logins can be renamed, e.g. grade7g / grade7b),
      // but must stay unique across accounts.
      if (patch.email && patch.email !== existing.email) {
        const other = await users.findByEmail(patch.email);
        if (other && other.id !== id) throw new ConflictError('Username already in use');
      }
      const gradeSet = normaliseGrades(patch.grade, patch.grades);
      const nextRole = (patch.role ?? existing.role) as UserRole;
      const nextGrades = gradeSet ? gradeSet.grades : (existing.grades ?? (existing.grade != null ? [existing.grade] : []));
      if (nextRole === 'grade' && nextGrades.length === 0) {
        throw new BadRequestError('Grade login requires at least one grade');
      }
      const nextGender = patch.gender !== undefined ? patch.gender : existing.gender;
      if (nextRole === 'grade' && nextGender == null) {
        throw new BadRequestError('Grade login requires a gender scope');
      }
      const nextLeaderId = patch.leaderId !== undefined ? (patch.leaderId ?? null) : (existing.leaderId ?? null);
      if (nextRole === 'leader' && !nextLeaderId) {
        throw new BadRequestError('Junior leader login requires a linked leader record');
      }
      const updated: User = {
        ...existing,
        ...(patch.displayName ? { displayName: patch.displayName } : {}),
        ...(patch.email ? { email: patch.email } : {}),
        ...(patch.role ? { role: patch.role as UserRole } : {}),
        ...(gradeSet ? { grade: gradeSet.grade, grades: gradeSet.grades } : {}),
        ...(patch.gender !== undefined ? { gender: (patch.gender ?? null) } : {}),
        ...(patch.quad !== undefined ? { quad: patch.quad as Quad | null } : {}),
        // Bind/unbind the leader record; cleared when the role is no longer 'leader'.
        leaderId: nextRole === 'leader' ? nextLeaderId : null,
        updatedAt: new Date().toISOString(),
      };
      return toSafe(await users.save(updated));
    },

    async setPassword(actor, id, newPassword) {
      assertCan(actor, 'admin:manage');
      const existing = await users.findById(id);
      if (!existing) throw new NotFoundError('User not found');
      if (newPassword.length < 8) throw new BadRequestError('Password must be at least 8 characters');
      const passwordHash = await hashPassword(newPassword);
      await users.save({ ...existing, passwordHash, updatedAt: new Date().toISOString() });
    },

    async changeOwnPassword(actor, currentPassword, newPassword) {
      const existing = await users.findById(actor.id);
      if (!existing) throw new NotFoundError('User not found');
      if (!existing.passwordHash || !(await verifyPassword(currentPassword, existing.passwordHash))) {
        throw new UnauthorizedError('Current password is incorrect');
      }
      if (newPassword.length < 8) throw new BadRequestError('Password must be at least 8 characters');
      const passwordHash = await hashPassword(newPassword);
      // Proving the current password and choosing a new one yourself is what clears
      // mustChangePassword — an admin-set/seeded password never does.
      await users.save({ ...existing, passwordHash, mustChangePassword: false, updatedAt: new Date().toISOString() });
    },

    async toggleStatus(actor, id) {
      assertCan(actor, 'admin:manage');
      const existing = await users.findById(id);
      if (!existing) throw new NotFoundError('User not found');
      if (existing.role === 'admin' && existing.status === 'active') {
        await guardAdmin(id, 'deactivate');
      }
      if (isProtectedAdmin(existing) && existing.status === 'active') {
        throw new BadRequestError(`The "${existing.displayName}" account cannot be deactivated`);
      }
      const updated = await users.save({
        ...existing,
        status: existing.status === 'active' ? 'inactive' : 'active',
        updatedAt: new Date().toISOString(),
      });
      return toSafe(updated);
    },

    async previewAccount(actor, id) {
      assertCan(actor, 'admin:manage');
      const existing = await users.findById(id);
      if (!existing) throw new NotFoundError('Account not found');
      if (existing.status !== 'active') {
        throw new BadRequestError('Only active accounts can be previewed');
      }
      if (existing.role !== 'grade' && existing.role !== 'quad') {
        throw new BadRequestError('Only grade/quad accounts can be previewed');
      }
      return toSafe(existing);
    },

    async remove(actor, id) {
      assertCan(actor, 'admin:manage');
      const existing = await users.findById(id);
      if (!existing) throw new NotFoundError('User not found');
      if (existing.role === 'admin') await guardAdmin(id, 'delete');
      if (isProtectedAdmin(existing)) {
        throw new BadRequestError(`The "${existing.displayName}" account cannot be deleted`);
      }
      await users.delete(id);
    },

    async planCohortLayout(actor, targetCohortInput) {
      assertCan(actor, 'admin:manage');
      const targetCohort = CohortModelSchema.parse(targetCohortInput);
      const [current, all] = await Promise.all([settings.getSettings(), users.findAll()]);
      const structure = current.ministryConfig.structure;
      return planCohortAccountLayout(
        targetCohort,
        structure.gradeMin,
        structure.gradeMax,
        structure.gradeLabel,
        all.map((u) => ({
          id: u.id, role: u.role, email: u.email, displayName: u.displayName, status: u.status,
          grades: u.grades ?? (u.grade != null ? [u.grade] : []), gender: u.gender, quad: u.quad,
        })),
      );
    },

    async applyCohortLayout(actor, targetCohortInput) {
      assertCan(actor, 'admin:manage');
      const targetCohort = CohortModelSchema.parse(targetCohortInput);
      const [current, all] = await Promise.all([settings.getSettings(), users.findAll()]);
      const structure = current.ministryConfig.structure;
      const plan = planCohortAccountLayout(
        targetCohort,
        structure.gradeMin,
        structure.gradeMax,
        structure.gradeLabel,
        all.map((u) => ({
          id: u.id, role: u.role, email: u.email, displayName: u.displayName, status: u.status,
          grades: u.grades ?? (u.grade != null ? [u.grade] : []), gender: u.gender, quad: u.quad,
        })),
      );

      const now = new Date().toISOString();
      const created: CohortLayoutApplyReport['created'] = [];
      for (const spec of plan.toCreate) {
        const password = generateTempPassword();
        const passwordHash = await hashPassword(password);
        const user: User =
          spec.role === 'grade'
            ? {
                id: generateId(), displayName: spec.displayName, email: spec.username, role: 'grade',
                grade: (spec.grades.length === 1 ? spec.grades[0]! : null) as Grade | null,
                grades: spec.grades as Grade[], gender: spec.gender, quad: null, leaderId: null,
                status: 'active', passwordHash, mustChangePassword: true, createdAt: now, updatedAt: now,
              }
            : {
                id: generateId(), displayName: spec.displayName, email: spec.username, role: 'quad',
                grade: null, grades: null, gender: null, quad: spec.quad as Quad, leaderId: null,
                status: 'active', passwordHash, mustChangePassword: true, createdAt: now, updatedAt: now,
              };
        await users.save(user);
        created.push({ username: spec.username, displayName: spec.displayName, password });
      }

      const deactivated: CohortLayoutApplyReport['deactivated'] = [];
      for (const d of plan.toDeactivate) {
        const existing = await users.findById(d.id);
        if (!existing || existing.status !== 'active') continue;
        await users.save({ ...existing, status: 'inactive', updatedAt: now });
        deactivated.push({ username: d.username, displayName: d.displayName });
      }

      return { created, deactivated };
    },
  };
}
