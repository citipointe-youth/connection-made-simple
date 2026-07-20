import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan, can, canAccessGender, canAccessStudent, type StructureScope } from './access-control';
import type { IStudentRepository, ISettingsRepository, IConnectionRepository, IPrayerRepository } from '../repositories/interfaces/entity-repositories';
import type { Student } from '../core/entities/student';
import type { Actor } from '../core/entities/user';
import type { AtRiskStatus } from '../core/types/enums';
import { computeQuad } from '../core/types/enums';
import { MINISTRY_CONFIG_DEFAULTS } from '../core/ministry-config';
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

export function makeStudentService(
  repo: IStudentRepository,
  settingsRepo?: ISettingsRepository,
  connRepo?: IConnectionRepository,
  // M1 (2026-07-19): optional so existing test constructors (makeStudentService(repo)
  // / (repo, settingsRepo) / (repo, settingsRepo, connRepo)) keep working unchanged —
  // the container always supplies it in production. When absent, remove() simply
  // doesn't cascade-delete prayers (today's pre-M1 behaviour).
  prayerRepo?: IPrayerRepository,
): StudentService {
  // Structure config for scoping (cohortModel/genderPolicy, §5). Optional repo so
  // existing test harnesses constructing makeStudentService(repo) keep today's
  // all-defaults behaviour; the container always supplies it in production.
  async function structureScope(): Promise<StructureScope> {
    if (!settingsRepo) return MINISTRY_CONFIG_DEFAULTS.structure;
    return (await settingsRepo.getSettings()).ministryConfig.structure;
  }
  // Junior leaders (§5.2) see ONLY students connected to their linked leader
  // record. Returns null for every other role (or when no connRepo is wired).
  async function leaderStudentIds(actor: Actor): Promise<Set<string> | null> {
    if (actor.role !== 'leader' || !connRepo) return null;
    if (!actor.leaderId) return new Set();
    const conns = await connRepo.findByLeader(actor.leaderId);
    return new Set(conns.map((c) => c.studentId));
  }
  return {
    async list(actor, filter) {
      assertCan(actor, 'student:read');
      const [students0, structure, myIds] = await Promise.all([repo.findAll(), structureScope(), leaderStudentIds(actor)]);
      let students = students0;

      // Junior leader: only their own connected students (§5.2).
      if (myIds) students = students.filter((s) => myIds.has(s.id));
      // Role-based scoping (grade -> own grade(s) + own gender; quad -> bracket +
      // gender). cohortModel/genderPolicy from config relax this appropriately.
      // `crossGrade` widens this to "own gender only" — used by Connect Setup's Add
      // Students picker so a leader whose grades have been broadened (self-service,
      // see updateGrades) can actually be offered students from that other grade.
      else if (actor.role === 'grade' || actor.role === 'quad') {
        students = filter?.crossGrade
          ? students.filter((s) => canAccessGender(actor, s.gender, structure))
          : students.filter((s) => canAccessStudent(actor, s.grade, s.gender, structure));
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

      // Junior leader may only fetch a student connected to them.
      if (actor.role === 'leader') {
        const myIds = await leaderStudentIds(actor);
        if (!myIds || !myIds.has(s.id)) throw new NotFoundError('Student not found');
      }
      // Grade logins may fetch a student of ANY grade (the cross-grade connect
      // exception) but only of their OWN gender.
      const structure = await structureScope();
      if (actor.role === 'grade' && !canAccessGender(actor, s.gender, structure)) {
        throw new NotFoundError('Student not found');
      }
      if (actor.role === 'quad' && !canAccessStudent(actor, s.grade, s.gender, structure)) {
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
      // M1: cascade-delete this student's prayers — otherwise they persist
      // forever, invisible (list() skips an orphan) and undeletable (edit/
      // delete throws NotFound for one). General (null-student) prayers are
      // untouched — deleteByStudent's WHERE clause never matches them.
      if (prayerRepo) await prayerRepo.deleteByStudent(id);
    },

    async search(actor, query) {
      assertCan(actor, 'student:read');
      if (!query.trim()) throw new BadRequestError('Search query required');
      const [results0, structure, myIds] = await Promise.all([repo.search(query), structureScope(), leaderStudentIds(actor)]);
      let results = results0;

      // Junior leader: only their own connected students.
      if (myIds) results = results.filter((s) => myIds.has(s.id));
      // Gender-scoped for grade + quad (cross-grade allowed — the connect exception).
      else if (actor.role === 'quad' || actor.role === 'grade') {
        results = results.filter((s) => canAccessGender(actor, s.gender, structure));
      }

      if (!can(actor, 'student:read:sensitive')) {
        results = results.map(stripSensitive);
      }
      return results;
    },
  };
}
