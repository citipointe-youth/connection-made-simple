import { assertCan, canAccessStudent } from './access-control';
import type {
  IStudentRepository,
  ILeaderRepository,
  IConnectionRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { Quad } from '../core/types/enums';
import { QUADS, QUAD_LABELS } from '../core/types/enums';

export interface QuadStat {
  quad: Quad;
  label: string;
  totalStudents: number;
  connectedStudents: number;
  unconnectedStudents: number;
  leaderCount: number;
  atRiskCount: number;
}

export interface GradeStat {
  grade: number;
  totalStudents: number;
  connectedStudents: number;
  unconnectedStudents: number;
  atRiskCount: number;
}

export interface OverviewStats {
  ministryTotal: number;
  connectedTotal: number;
  unconnectedTotal: number;
  leaderCount: number;
  atRiskTotal: number;
  byQuad: QuadStat[];
  byGrade: GradeStat[];
}

const AT_RISK = new Set(['atrisk', 'stopped', 'declining', 'watch']);

export interface OverviewService {
  getStats(actor: Actor): Promise<OverviewStats>;
}

export function makeOverviewService(
  studentRepo: IStudentRepository,
  leaderRepo: ILeaderRepository,
  connRepo: IConnectionRepository,
): OverviewService {
  return {
    async getStats(actor) {
      assertCan(actor, 'overview:read');

      const allStudents = await studentRepo.findAll();
      const allLeaders = await leaderRepo.findActive();
      const allConns = await connRepo.findAll();

      const scoped = allStudents.filter((s) =>
        (actor.role === 'grade' || actor.role === 'quad')
          ? canAccessStudent(actor, s.grade, s.gender)
          : true,
      );

      const connectedIds = new Set(allConns.map((a) => a.studentId));

      // Connection metrics only count students who have ATTENDED a service or
      // lifegroup in the current or previous term — students who never attended
      // are not treated as "unconnected" (and shouldn't inflate the total).
      const attended = (s: { svcAttended: number; grpAttended: number; prevSvcAttended: number; prevGrpAttended: number }) =>
        s.svcAttended > 0 || s.grpAttended > 0 || s.prevSvcAttended > 0 || s.prevGrpAttended > 0;
      const connectable = scoped.filter(attended);

      // Leader-to-quad mapping: a leader belongs to a quad if their grade + gender aligns.
      // We use student quad membership (derived from grade+gender) so gender is unambiguous.
      const leaderQuadCounts: Record<Quad, number> = { g79: 0, b79: 0, g1012: 0, b1012: 0 };
      for (const l of allLeaders) {
        const seenQuads = new Set<Quad>();
        for (const g of l.grades) {
          // A leader can appear in up to 2 quads (male and female for a grade)
          // but in practice is gender-scoped. Use leader gender if set.
          if (l.gender === 'female' || l.gender == null) {
            const q = g >= 7 && g <= 9 ? 'g79' : g >= 10 && g <= 12 ? 'g1012' : null;
            if (q && !seenQuads.has(q)) { leaderQuadCounts[q]++; seenQuads.add(q); }
          }
          if (l.gender === 'male' || l.gender == null) {
            const q = g >= 7 && g <= 9 ? 'b79' : g >= 10 && g <= 12 ? 'b1012' : null;
            if (q && !seenQuads.has(q)) { leaderQuadCounts[q]++; seenQuads.add(q); }
          }
        }
        // Leaders with no grade focus are counted in all quads
        if (l.grades.length === 0) {
          (Object.keys(leaderQuadCounts) as Quad[]).forEach((q) => leaderQuadCounts[q]++);
        }
      }

      const byQuad: QuadStat[] = QUADS.map((quad) => {
        const qConn = connectable.filter((s) => s.quad === quad);
        return {
          quad,
          label: QUAD_LABELS[quad],
          totalStudents: qConn.length,
          connectedStudents: qConn.filter((s) => connectedIds.has(s.id)).length,
          unconnectedStudents: qConn.filter((s) => !connectedIds.has(s.id)).length,
          leaderCount: leaderQuadCounts[quad] ?? 0,
          atRiskCount: scoped.filter((s) => s.quad === quad && AT_RISK.has(s.atRiskStatus ?? '')).length,
        };
      });

      const byGrade: GradeStat[] = [7, 8, 9, 10, 11, 12].map((grade) => {
        const gConn = connectable.filter((s) => s.grade === grade);
        return {
          grade,
          totalStudents: gConn.length,
          connectedStudents: gConn.filter((s) => connectedIds.has(s.id)).length,
          unconnectedStudents: gConn.filter((s) => !connectedIds.has(s.id)).length,
          atRiskCount: scoped.filter((s) => s.grade === grade && AT_RISK.has(s.atRiskStatus ?? '')).length,
        };
      });

      return {
        ministryTotal: connectable.length,
        connectedTotal: connectable.filter((s) => connectedIds.has(s.id)).length,
        unconnectedTotal: connectable.filter((s) => !connectedIds.has(s.id)).length,
        leaderCount: allLeaders.length,
        atRiskTotal: scoped.filter((s) => AT_RISK.has(s.atRiskStatus ?? '')).length,
        byQuad,
        byGrade,
      };
    },
  };
}
