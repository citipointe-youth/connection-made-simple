import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan, can, canAccessGrade, canAccessGender } from './access-control';
import type { IStudentRepository } from '../repositories/interfaces/entity-repositories';
import type { Student } from '../core/entities/student';
import type { Actor } from '../core/entities/user';
import type { AtRiskStatus } from '../core/types/enums';
import { computeQuad } from '../core/types/enums';
import { NotFoundError, BadRequestError } from '../core/errors/app-error';

const CreateStudentSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  gender: z.enum(['male', 'female', 'other']),
  grade: z.number().int().min(7).max(12).nullable().optional(),
  mobile: z.string().nullable().optional(),
  parentPhone: z.string().nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),
  dataSource: z.string().nullable().optional(),
});

const AT_RISK_VALUES = ['regular', 'declining', 'atrisk', 'stopped', 'watch', 'new'] as const;

export interface StudentService {
  list(actor: Actor, filter?: { grade?: number; gender?: string; query?: string; unconnected?: boolean }): Promise<Student[]>;
  get(actor: Actor, id: string): Promise<Student>;
  create(actor: Actor, input: unknown): Promise<Student>;
  update(actor: Actor, id: string, input: unknown): Promise<Student>;
  updateAtRisk(actor: Actor, id: string, status: string): Promise<Student>;
  remove(actor: Actor, id: string): Promise<void>;
  search(actor: Actor, query: string): Promise<Student[]>;
}

function stripSensitive(s: Student): Student {
  return { ...s, mobile: null, parentPhone: null };
}

export function makeStudentService(repo: IStudentRepository): StudentService {
  return {
    async list(actor, filter) {
      assertCan(actor, 'student:read');
      let students = await repo.findAll();

      // Role-based scoping
      if (actor.role === 'grade') {
        students = students.filter((s) => s.grade === actor.grade);
      } else if (actor.role === 'quad') {
        students = students.filter(
          (s) => canAccessGrade(actor, s.grade) && canAccessGender(actor, s.gender),
        );
      }

      // Optional filters
      if (filter?.grade != null) students = students.filter((s) => s.grade === filter.grade);
      if (filter?.gender) {
        students = students.filter(
          (s) => s.gender.toLowerCase() === filter.gender!.toLowerCase(),
        );
      }
      if (filter?.query) {
        const q = filter.query.toLowerCase();
        students = students.filter((s) =>
          `${s.firstName} ${s.lastName}`.toLowerCase().includes(q),
        );
      }

      if (!can(actor, 'student:read:sensitive')) {
        students = students.map(stripSensitive);
      }

      return students.sort((a, b) => a.lastName.localeCompare(b.lastName));
    },

    async get(actor, id) {
      assertCan(actor, 'student:read');
      const s = await repo.findById(id);
      if (!s) throw new NotFoundError('Student not found');

      if (actor.role === 'grade' && s.grade !== actor.grade) {
        // Cross-grade access allowed for allocation purposes — no gender restriction at fetch layer.
        // The allocation layer enforces the leader gender match rule.
      }
      if (actor.role === 'quad') {
        if (!canAccessGrade(actor, s.grade) || !canAccessGender(actor, s.gender)) {
          throw new NotFoundError('Student not found');
        }
      }

      if (!can(actor, 'student:read:sensitive')) {
        return stripSensitive(s);
      }
      return s;
    },

    async create(actor, input) {
      assertCan(actor, 'student:write');
      const data = CreateStudentSchema.parse(input);
      const now = new Date().toISOString();
      const student: Student = {
        id: generateId(),
        firstName: data.firstName,
        lastName: data.lastName,
        gender: data.gender,
        grade: data.grade ?? null,
        quad: computeQuad(data.grade ?? null, data.gender),
        mobile: data.mobile ?? null,
        parentPhone: data.parentPhone ?? null,
        dateOfBirth: data.dateOfBirth ?? null,
        svcAttended: 0,
        svcTotal: 0,
        grpAttended: 0,
        grpTotal: 0,
        grpMetWeeks: 0,
        prevSvcAttended: 0,
        prevSvcTotal: 0,
        prevGrpAttended: 0,
        prevGrpTotal: 0,
        atRiskStatus: 'new',
        dataSource: data.dataSource ?? null,
        createdAt: now,
        updatedAt: now,
      };
      return repo.save(student);
    },

    async update(actor, id, input) {
      assertCan(actor, 'student:write');
      const existing = await repo.findById(id);
      if (!existing) throw new NotFoundError('Student not found');
      const patch = CreateStudentSchema.partial().parse(input);
      const gender = patch.gender ?? existing.gender;
      const grade = patch.grade !== undefined ? (patch.grade ?? null) : existing.grade;
      return repo.save({
        ...existing,
        ...patch,
        grade,
        gender,
        quad: computeQuad(grade, gender),
        updatedAt: new Date().toISOString(),
      });
    },

    async updateAtRisk(actor, id, status) {
      assertCan(actor, 'atrisk:read');
      if (!AT_RISK_VALUES.includes(status as AtRiskStatus)) {
        throw new BadRequestError(`Invalid at-risk status: ${status}`);
      }
      const existing = await repo.findById(id);
      if (!existing) throw new NotFoundError('Student not found');
      return repo.save({
        ...existing,
        atRiskStatus: status as AtRiskStatus,
        updatedAt: new Date().toISOString(),
      });
    },

    async remove(actor, id) {
      assertCan(actor, 'student:write');
      const deleted = await repo.delete(id);
      if (!deleted) throw new NotFoundError('Student not found');
    },

    async search(actor, query) {
      assertCan(actor, 'student:read');
      if (!query.trim()) throw new BadRequestError('Search query required');
      let results = await repo.search(query);

      // Quad is gender-scoped
      if (actor.role === 'quad') {
        results = results.filter((s) => canAccessGender(actor, s.gender));
      }

      if (!can(actor, 'student:read:sensitive')) {
        results = results.map(stripSensitive);
      }
      return results;
    },
  };
}
