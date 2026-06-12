import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan, canAccessGrade, canAccessGender } from './access-control';
import type {
  IConnectionRepository,
  IStudentRepository,
  ILeaderRepository,
  ISettingsRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Connection } from '../core/entities/connection';
import type { Actor } from '../core/entities/user';
import { NotFoundError, BadRequestError, ConflictError, ForbiddenError } from '../core/errors/app-error';

export interface ConnectionWithNames {
  id: string;
  studentId: string;
  studentName: string;
  leaderId: string;
  leaderName: string;
  assignedByRole: string;
  createdAt: string;
}

export interface ExportRow {
  leaderName: string;
  leaderGender: string | null;
  leaderGrades: string;
  studentName: string;
  studentGrade: number | null;
  studentGender: string;
  svcAttended: number;
  svcTotal: number;
  svcPct: string;
  atRiskStatus: string | null;
}

export interface ConnectionService {
  listByStudent(actor: Actor, studentId: string): Promise<ConnectionWithNames[]>;
  listByLeader(actor: Actor, leaderId: string): Promise<ConnectionWithNames[]>;
  listAll(actor: Actor): Promise<ConnectionWithNames[]>;
  assign(actor: Actor, input: unknown): Promise<Connection>;
  unassign(actor: Actor, studentId: string, leaderId: string): Promise<void>;
  leaderSummary(actor: Actor, leaderId: string): Promise<{ students: ReturnType<typeof summariseStudent>[]; leader: { id: string; fullName: string } }>;
  exportCsv(actor: Actor): Promise<ExportRow[]>;
}

function summariseStudent(s: {
  id: string; firstName: string; lastName: string; grade: number | null; gender: string;
  mobile: string | null; parentPhone: string | null; svcAttended: number; svcTotal: number;
  grpAttended: number; grpTotal: number;
}) {
  return {
    id: s.id,
    fullName: `${s.firstName} ${s.lastName}`,
    grade: s.grade,
    gender: s.gender,
    mobile: s.mobile,
    parentPhone: s.parentPhone,
    svcAttended: s.svcAttended,
    svcTotal: s.svcTotal,
    grpAttended: s.grpAttended,
    grpTotal: s.grpTotal,
  };
}

const AssignSchema = z.object({
  studentId: z.string().min(1),
  leaderId: z.string().min(1),
});

async function checkLock(settingsRepo: ISettingsRepository, actor: Actor): Promise<void> {
  if (actor.role === 'admin') return;
  const settings = await settingsRepo.getSettings();
  if (!settings.connectionLockDate) return;
  const lockDate = new Date(settings.connectionLockDate);
  if (new Date() >= lockDate) {
    throw new ForbiddenError(
      `Connections are locked as of ${lockDate.toLocaleDateString()}. Contact your admin to make changes.`,
    );
  }
}

export function makeConnectionService(
  connRepo: IConnectionRepository,
  studentRepo: IStudentRepository,
  leaderRepo: ILeaderRepository,
  settingsRepo: ISettingsRepository,
): ConnectionService {
  async function enrich(conns: Connection[]): Promise<ConnectionWithNames[]> {
    const results: ConnectionWithNames[] = [];
    for (const a of conns) {
      const student = await studentRepo.findById(a.studentId);
      const leader = await leaderRepo.findById(a.leaderId);
      results.push({
        ...a,
        studentName: student ? `${student.firstName} ${student.lastName}` : 'Unknown',
        leaderName: leader?.fullName ?? 'Unknown',
      });
    }
    return results;
  }

  return {
    async listByStudent(actor, studentId) {
      assertCan(actor, 'student:read');
      return enrich(await connRepo.findByStudent(studentId));
    },

    async listByLeader(actor, leaderId) {
      assertCan(actor, 'leader:read');
      return enrich(await connRepo.findByLeader(leaderId));
    },

    async listAll(actor) {
      assertCan(actor, 'student:read');
      const all = await connRepo.findAll();
      const filtered: Connection[] = [];
      for (const a of all) {
        const student = await studentRepo.findById(a.studentId);
        if (!student) continue;
        if (actor.role === 'grade' && student.grade !== actor.grade) continue;
        if (actor.role === 'quad') {
          if (!canAccessGrade(actor, student.grade) || !canAccessGender(actor, student.gender)) continue;
        }
        filtered.push(a);
      }
      return enrich(filtered);
    },

    async assign(actor, input) {
      assertCan(actor, 'connection:write');
      await checkLock(settingsRepo, actor);

      const { studentId, leaderId } = AssignSchema.parse(input);
      const student = await studentRepo.findById(studentId);
      if (!student) throw new NotFoundError('Student not found');
      const leader = await leaderRepo.findById(leaderId);
      if (!leader) throw new NotFoundError('Leader not found');

      if (actor.role === 'grade') {
        const ownGrade = student.grade === actor.grade;
        if (!ownGrade) {
          if (!leader.gender || student.gender !== leader.gender) {
            throw new BadRequestError('Cross-grade connection requires student and leader to share gender');
          }
        }
      }

      const existing = await connRepo.findByStudentAndLeader(studentId, leaderId);
      if (existing) throw new ConflictError('Connection already exists');

      return connRepo.save({
        id: generateId(),
        studentId,
        leaderId,
        assignedByRole: actor.role,
        createdAt: new Date().toISOString(),
      });
    },

    async unassign(actor, studentId, leaderId) {
      assertCan(actor, 'connection:write');
      await checkLock(settingsRepo, actor);
      const deleted = await connRepo.deleteByStudentAndLeader(studentId, leaderId);
      if (!deleted) throw new NotFoundError('Connection not found');
    },

    async leaderSummary(actor, leaderId) {
      assertCan(actor, 'leader:read');
      const leader = await leaderRepo.findById(leaderId);
      if (!leader) throw new NotFoundError('Leader not found');
      const conns = await connRepo.findByLeader(leaderId);
      const students = [];
      for (const a of conns) {
        const s = await studentRepo.findById(a.studentId);
        if (s) students.push(summariseStudent(s));
      }
      return { leader: { id: leader.id, fullName: leader.fullName }, students };
    },

    async exportCsv(actor) {
      assertCan(actor, 'student:read');
      const all = await connRepo.findAll();
      const rows: ExportRow[] = [];
      for (const a of all) {
        const student = await studentRepo.findById(a.studentId);
        const leader = await leaderRepo.findById(a.leaderId);
        if (!student || !leader) continue;
        if (actor.role === 'grade' && student.grade !== actor.grade) continue;
        if (actor.role === 'quad') {
          if (!canAccessGrade(actor, student.grade) || !canAccessGender(actor, student.gender)) continue;
        }
        const pct = student.svcTotal > 0
          ? Math.round((student.svcAttended / student.svcTotal) * 100) + '%'
          : '—';
        rows.push({
          leaderName: leader.fullName,
          leaderGender: leader.gender,
          leaderGrades: leader.grades.length ? leader.grades.join('; ') : 'All',
          studentName: `${student.firstName} ${student.lastName}`,
          studentGrade: student.grade,
          studentGender: student.gender,
          svcAttended: student.svcAttended,
          svcTotal: student.svcTotal,
          svcPct: pct,
          atRiskStatus: student.atRiskStatus,
        });
      }
      return rows.sort((a, b) => a.leaderName.localeCompare(b.leaderName) || a.studentName.localeCompare(b.studentName));
    },
  };
}
