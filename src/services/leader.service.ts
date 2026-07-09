import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan, canAccessGrade, canAccessGender, quadGenderOf, quadGradesOf } from './access-control';
import type { ILeaderRepository } from '../repositories/interfaces/entity-repositories';
import type { Leader } from '../core/entities/leader';
import type { Actor } from '../core/entities/user';
import type { Grade } from '../core/types/enums';
import { NotFoundError, ForbiddenError, BadRequestError } from '../core/errors/app-error';

const CreateLeaderSchema = z.object({
  fullName: z.string().min(1).max(100),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  grades: z.array(z.number().int().min(7).max(12)).optional(),
  smsTemplate: z.string().max(500).nullable().optional(),
});

export interface LeaderService {
  list(actor: Actor): Promise<Leader[]>;
  get(actor: Actor, id: string): Promise<Leader>;
  create(actor: Actor, input: unknown): Promise<Leader>;
  update(actor: Actor, id: string, input: unknown): Promise<Leader>;
  remove(actor: Actor, id: string): Promise<void>;
  updateSmsTemplate(actor: Actor, id: string, smsTemplate: unknown): Promise<Leader>;
  // Self-service grade broadening: a leader (grade/quad login self-identifying
  // as this record) can add OTHER grades to their own coverage so they can see
  // and connect students from those grades too. Deliberately skips the
  // creator/quad-scope ownership checks used by update() — same rationale as
  // updateSmsTemplate() (no server-side binding between an Actor and "the
  // leader they identify as"; most real leaders are auto-created by CSV
  // import). Gender is NEVER touched here — that lock stays enforced by
  // simply not accepting it as an input.
  updateGrades(actor: Actor, id: string, grades: unknown): Promise<Leader>;
}

/** A quad may only manage leaders within its gender + year bracket. */
function assertLeaderInQuadScope(actor: Actor, leader: Leader): void {
  const bracket = quadGradesOf(actor.quad);
  const qg = quadGenderOf(actor.quad);
  const gradeOk = leader.grades.length === 0 || leader.grades.some((g) => bracket.includes(g));
  const genderOk = leader.gender == null || leader.gender === qg;
  if (!gradeOk || !genderOk) {
    throw new ForbiddenError('You can only manage leaders in your quad');
  }
}

export function makeLeaderService(repo: ILeaderRepository): LeaderService {
  return {
    async list(actor) {
      assertCan(actor, 'leader:read');
      const all = await repo.findActive();

      if (actor.role === 'grade') {
        // Grade login sees only leaders of their own GENDER that are for their
        // grade (or all-grades / created by them).
        return all.filter(
          (l) =>
            (l.gender == null || canAccessGender(actor, l.gender)) &&
            (l.createdByGrade === actor.grade ||
              l.grades.length === 0 ||
              l.grades.includes(actor.grade as Grade)),
        );
      }
      if (actor.role === 'quad') {
        // Quad login sees only leaders within their quad's gender AND year bracket.
        const qg = quadGenderOf(actor.quad);
        return all.filter(
          (l) =>
            (l.gender == null || l.gender === qg) &&
            (l.grades.length === 0 || l.grades.some((g) => canAccessGrade(actor, g))),
        );
      }
      return all;
    },

    async get(actor, id) {
      assertCan(actor, 'leader:read');
      const l = await repo.findById(id);
      if (!l) throw new NotFoundError('Leader not found');
      return l;
    },

    async create(actor, input) {
      assertCan(actor, 'leader:write');
      const data = CreateLeaderSchema.parse(input);

      // Grade login: leader is automatically scoped to their grade
      let grades: Grade[];
      let leaderGender: Leader['gender'] = (data.gender ?? null) as Leader['gender'];
      if (actor.role === 'grade') {
        if (actor.grade == null) throw new BadRequestError('Grade login has no grade assigned');
        grades = [actor.grade];
      } else if (actor.role === 'quad') {
        // Quad login: new leaders auto-set to the quad's gender; year focus limited to the bracket.
        const bracket = quadGradesOf(actor.quad) as Grade[];
        if (!bracket.length) throw new BadRequestError('Quad login has no quad assigned');
        const requested = (data.grades ?? []) as Grade[];
        const scoped = requested.filter((g) => bracket.includes(g));
        if (requested.length > 0 && scoped.length === 0) {
          throw new BadRequestError('Grades must be within your year bracket');
        }
        grades = scoped.length ? scoped : bracket;
        leaderGender = quadGenderOf(actor.quad);
      } else {
        grades = (data.grades ?? []) as Grade[];
      }

      const now = new Date().toISOString();
      const leader: Leader = {
        id: generateId(),
        fullName: data.fullName,
        gender: leaderGender,
        grades,
        active: true,
        createdByGrade: actor.role === 'grade' ? actor.grade : null,
        smsTemplate: data.smsTemplate ?? null,
        createdAt: now,
        updatedAt: now,
      };
      return repo.save(leader);
    },

    async update(actor, id, input) {
      assertCan(actor, 'leader:write');
      const existing = await repo.findById(id);
      if (!existing) throw new NotFoundError('Leader not found');

      // Grade login can only update leaders they created
      if (actor.role === 'grade' && existing.createdByGrade !== actor.grade) {
        throw new ForbiddenError('You can only edit leaders you created');
      }
      // Quad login can only edit leaders within their gender + year bracket
      if (actor.role === 'quad') {
        assertLeaderInQuadScope(actor, existing);
      }

      const patch = CreateLeaderSchema.extend({ active: z.boolean().optional() }).partial().parse(input);
      let nextGender: Leader['gender'] =
        patch.gender !== undefined ? ((patch.gender ?? null) as Leader['gender']) : existing.gender;
      let nextGrades: Grade[] = patch.grades !== undefined ? (patch.grades as Grade[]) : existing.grades;
      // Quad cannot move a leader outside their gender + bracket
      if (actor.role === 'quad') {
        const bracket = quadGradesOf(actor.quad) as Grade[];
        nextGender = quadGenderOf(actor.quad);
        if (patch.grades !== undefined) {
          const scoped = nextGrades.filter((g) => bracket.includes(g));
          if (nextGrades.length > 0 && scoped.length === 0) {
            throw new BadRequestError('Grades must be within your year bracket');
          }
          nextGrades = scoped.length ? scoped : bracket;
        }
      }
      const updated: Leader = {
        ...existing,
        fullName: patch.fullName ?? existing.fullName,
        gender: nextGender,
        grades: nextGrades,
        active: patch.active !== undefined ? patch.active : existing.active,
        smsTemplate: patch.smsTemplate !== undefined ? patch.smsTemplate : existing.smsTemplate,
        updatedAt: new Date().toISOString(),
      };
      return repo.save(updated);
    },

    async remove(actor, id) {
      assertCan(actor, 'leader:write');
      const existing = await repo.findById(id);
      if (!existing) throw new NotFoundError('Leader not found');
      if (actor.role === 'grade' && existing.createdByGrade !== actor.grade) {
        throw new ForbiddenError('You can only delete leaders you created');
      }
      if (actor.role === 'quad') {
        assertLeaderInQuadScope(actor, existing);
      }
      await repo.delete(id);
    },

    // Self-service edit of the call-sheet "Message Custom" template. Deliberately
    // skips the creator/quad-scope ownership checks used by update(): there is no
    // server-side binding between an Actor and "the leader they identify as"
    // (getMyLeaderId() is a client-side convenience), and most self-identified
    // leaders were auto-created by CSV import (createdByGrade: null), which the
    // grade-role ownership check in update() would otherwise reject. The template
    // is a low-stakes preference field — it doesn't affect grade/gender/active
    // scoping — so any actor who can see the leader may set it.
    async updateSmsTemplate(actor, id, smsTemplate) {
      assertCan(actor, 'leader:write');
      const existing = await repo.findById(id);
      if (!existing) throw new NotFoundError('Leader not found');
      const parsed = z.string().max(500).nullable().parse(smsTemplate);
      const updated: Leader = { ...existing, smsTemplate: parsed, updatedAt: new Date().toISOString() };
      return repo.save(updated);
    },

    async updateGrades(actor, id, grades) {
      assertCan(actor, 'leader:write');
      const existing = await repo.findById(id);
      if (!existing) throw new NotFoundError('Leader not found');
      const parsed = z.array(z.number().int().min(7).max(12)).parse(grades);
      const updated: Leader = { ...existing, grades: parsed as Grade[], updatedAt: new Date().toISOString() };
      return repo.save(updated);
    },
  };
}
