import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan, can, canAccessGender, canAccessStudent } from './access-control';
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
  list(actor: Actor, filter?: { grade?: number; gender?: string; query?: string; unconnected?: boolean; crossGrade?: boolean }): Promise<Student[]>;
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

      // Role-based scoping (grade -> own grade + own gender; quad -> bracket + gender).
      // `crossGrade` widens this to "own gender only" — used by Connect Setup's Add
      // Students picker so a leader whose grades have been broadened (self-service,
      // see updateGrades) can actually be offered students from that other grade.
      if (actor.role === 'grade' || actor.role === 'quad') {
        students = filter?.crossGrade
          ? students.filter((s) => canAccessGender(actor, s.gender))
          : students.filter((s) => canAccessStudent(actor, s.grade, s.gender));
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

      // Grade logins may fetch a student of ANY grade (the cross-grade connect
      // exception) but only of their OWN gender.
      if (actor.role === 'grade' && !canAccessGender(actor, s.gender)) {
        throw new NotFoundError('Student not found');
      }
      if (actor.role === 'quad' && !canAccessStudent(actor, s.grade, s.gender)) {
        throw new NotFoundError('Student not found');
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

      // Gender-scoped for grade + quad (cross-grade allowed — the connect exception).
      if (actor.role === 'quad' || actor.role === 'grade') {
        results = results.filter((s) => canAccessGender(actor, s.gender));
      }

      if (!can(actor, 'student:read:sensitive')) {
        results = results.map(stripSensitive);
      }
      return results;
    },
  };
}
