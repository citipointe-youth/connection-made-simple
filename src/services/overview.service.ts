import { assertCan, canAccessStudent } from './access-control';
import type {
  IStudentRepository,
  ILeaderRepository,
  IConnectionRepository,
  ISettingsRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { Quad } from '../core/types/enums';
import { QUADS, QUAD_LABELS } from '../core/types/enums';
import { gradeRange, MINISTRY_CONFIG_DEFAULTS } from '../core/ministry-config';
import { ResponseCache } from '../utils/response-cache';
import { actorKey } from './actor-key';

// Module-level cache — survives across requests on the same warm serverless instance.
// Any code path that writes students/leaders/connections must call
// invalidateOverviewCache() — there is no automatic invalidation.
const _cache = new ResponseCache<OverviewStats>(60_000);

export function invalidateOverviewCache(): void {
  _cache.invalidateAll();
}

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
  // Optional so existing test harnesses that construct without it keep today's
  // (all-defaults) behaviour; the container always supplies it in production.
  settingsRepo?: ISettingsRepository,
): OverviewService {
  return {
    async getStats(actor) {
      assertCan(actor, 'overview:read');
      const cacheKey = actorKey(actor);
      const cached = _cache.get(cacheKey);
      if (cached) return cached;

      // Fetch in parallel — serial round-trips to the Supabase pooler are a
      // meaningful slice of this endpoint's latency on a cold serverless call.
      const [settings, allStudents, allLeaders, allConns] = await Promise.all([
        settingsRepo ? settingsRepo.getSettings() : Promise.resolve(null),
        studentRepo.findAll(),
        leaderRepo.findActive(),
        connRepo.findAll(),
      ]);
      const structure = settings ? settings.ministryConfig.structure : MINISTRY_CONFIG_DEFAULTS.structure;
      const cohorted = structure.cohortModel !== 'none';

      const scoped = allStudents.filter((s) =>
        (actor.role === 'grade' || actor.role === 'quad')
          ? canAccessStudent(actor, s.grade, s.gender, structure)
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

      // Under cohortModel 'none' (Simple ministry — coarse brackets, no
      // quads) there's nothing meaningful to break down BY quad/grade, so
      // both are left empty and the SPA hides these sections. This is a
      // reporting-granularity choice only — per-actor scoping (`scoped`
      // above, via canAccessStudent) is unaffected and enforces the same way
      // under both cohort models (bug 8 follow-up, 2026-07-11).
      const byQuad: QuadStat[] = !cohorted ? [] : QUADS.map((quad) => {
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

      const byGrade: GradeStat[] = !cohorted ? [] : gradeRange(structure).map((grade) => {
        const gConn = connectable.filter((s) => s.grade === grade);
        return {
          grade,
          totalStudents: gConn.length,
          connectedStudents: gConn.filter((s) => connectedIds.has(s.id)).length,
          unconnectedStudents: gConn.filter((s) => !connectedIds.has(s.id)).length,
          atRiskCount: scoped.filter((s) => s.grade === grade && AT_RISK.has(s.atRiskStatus ?? '')).length,
        };
      });

      const result: OverviewStats = {
        ministryTotal: connectable.length,
        connectedTotal: connectable.filter((s) => connectedIds.has(s.id)).length,
        unconnectedTotal: connectable.filter((s) => !connectedIds.has(s.id)).length,
        leaderCount: allLeaders.length,
        atRiskTotal: scoped.filter((s) => AT_RISK.has(s.atRiskStatus ?? '')).length,
        byQuad,
        byGrade,
      };
      _cache.set(cacheKey, result);
      return result;
    },
  };
}
