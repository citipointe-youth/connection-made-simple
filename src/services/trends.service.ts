import { assertCan, canAccessGrade, canAccessGender } from './access-control';
import type {
  IStudentRepository,
  IServiceSessionRepository,
  IServiceAttendanceRepository,
  ISettingsRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { Quad } from '../core/types/enums';
import { QUADS, QUAD_LABELS } from '../core/types/enums';

export interface SessionPoint {
  sessionId: string;
  sessionDate: string;
  sessionName: string;
  totalAttended: number;
  totalPresent: number;
  isOutlier: boolean;  // attendance < validThresholdPct% of recent average
}

export interface QuadTrend {
  quad: Quad;
  label: string;
  sessions: SessionPoint[];
  averageAttendance: number;
}

export interface GradeTrend {
  grade: number;
  sessions: SessionPoint[];
  averageAttendance: number;
}

export interface MinistryTrend {
  sessions: SessionPoint[];
  averageAttendance: number;
  peakAttendance: number;
  peakDate: string;
  recentTrend: 'up' | 'down' | 'stable';
}

export interface TrendsData {
  ministry: MinistryTrend;
  byQuad: QuadTrend[];
  byGrade: GradeTrend[];
  // Aggregated group attendance trend (derived from student grp fields, not session-level)
  groupSummary: {
    totalStudentsWithGroupData: number;
    avgGroupAttendance: number;
    studentsIncreasing: number;
    studentsDecreasing: number;
    studentsStable: number;
  };
  generatedAt: string;
}

export interface TrendsService {
  get(actor: Actor): Promise<TrendsData>;
}

function recentTrend(sessions: SessionPoint[]): 'up' | 'down' | 'stable' {
  const valid = sessions.filter((s) => !s.isOutlier);
  if (valid.length < 4) return 'stable';
  const half = Math.floor(valid.length / 2);
  const older = valid.slice(0, half);
  const newer = valid.slice(-half);
  const avgOlder = older.reduce((sum, s) => sum + s.totalAttended, 0) / older.length;
  const avgNewer = newer.reduce((sum, s) => sum + s.totalAttended, 0) / newer.length;
  const delta = (avgNewer - avgOlder) / Math.max(avgOlder, 1);
  if (delta > 0.05) return 'up';
  if (delta < -0.05) return 'down';
  return 'stable';
}

function averageOf(points: { totalAttended: number; isOutlier: boolean }[]): number {
  const valid = points.filter((p) => !p.isOutlier);
  return valid.length > 0
    ? Math.round(valid.reduce((s, p) => s + p.totalAttended, 0) / valid.length)
    : 0;
}

export function makeTrendsService(
  studentRepo: IStudentRepository,
  sessionRepo: IServiceSessionRepository,
  attendanceRepo: IServiceAttendanceRepository,
  settingsRepo: ISettingsRepository,
): TrendsService {
  return {
    async get(actor) {
      assertCan(actor, 'overview:read');

      const settings = await settingsRepo.getSettings();
      const minAttendance = settings.serviceMinAttendance;

      const allStudents = await studentRepo.findAll();
      const allSessions = await sessionRepo.findAll();
      const allAttendance = await attendanceRepo.findAll();

      // Scope students to actor
      const scopedStudents = allStudents.filter((s) => {
        if (actor.role === 'grade') return s.grade === actor.grade;
        if (actor.role === 'quad') {
          return canAccessGrade(actor, s.grade) && canAccessGender(actor, s.gender);
        }
        return true;
      });

      const scopedIds = new Set(scopedStudents.map((s) => s.id));

      // Sort sessions chronologically
      const sortedSessions = [...allSessions].sort(
        (a, b) => a.sessionDate.localeCompare(b.sessionDate),
      );

      // Build attendance index: sessionId -> Set<studentId>. This holds ALL
      // attendees (not scope-filtered) so session validity reflects the whole
      // Friday service.
      const attendedBySession = new Map<string, Set<string>>();
      for (const rec of allAttendance) {
        if (!rec.attended) continue;
        if (!attendedBySession.has(rec.sessionId)) attendedBySession.set(rec.sessionId, new Set());
        attendedBySession.get(rec.sessionId)!.add(rec.studentId);
      }

      // A session is "valid" iff the whole-ministry attendance that week is >=
      // the configured floor (default 100). Anything below — holidays, term
      // breaks, future-dated columns, cancelled services — is disregarded
      // entirely. This single global mask is applied to ministry, quad AND grade
      // averages so they share one denominator and stay additive. isOutlier on a
      // point means "not a valid service" (also hides it from the chart).
      const isValidSession = (sessionId: string): boolean =>
        (attendedBySession.get(sessionId)?.size ?? 0) >= minAttendance;

      const buildPoints = (memberIds: Set<string> | null, totalPresent: number): SessionPoint[] =>
        sortedSessions.map((sess) => {
          const attendedSet = attendedBySession.get(sess.id) ?? new Set<string>();
          const totalAttended = memberIds
            ? [...attendedSet].filter((id) => memberIds.has(id)).length
            : attendedSet.size;
          return {
            sessionId: sess.id,
            sessionDate: sess.sessionDate,
            sessionName: sess.sessionName,
            totalAttended,
            totalPresent,
            isOutlier: !isValidSession(sess.id),
          };
        });

      // ── Ministry-level trend (scoped to the actor) ──
      const ministryWithOutliers = buildPoints(scopedIds, scopedStudents.length);
      const validMinistry = ministryWithOutliers.filter((p) => !p.isOutlier);
      const avgMinistry = averageOf(ministryWithOutliers);
      const peakPoint = validMinistry.reduce((max, p) => p.totalAttended > (max?.totalAttended ?? 0) ? p : max, validMinistry[0]);

      const ministry: MinistryTrend = {
        sessions: ministryWithOutliers,
        averageAttendance: avgMinistry,
        peakAttendance: peakPoint?.totalAttended ?? 0,
        peakDate: peakPoint?.sessionDate ?? '',
        recentTrend: recentTrend(ministryWithOutliers),
      };

      // ── Per-quad trend (same valid-session mask) ──
      const byQuad: QuadTrend[] = QUADS.map((quad) => {
        const quadStudentIds = new Set(
          scopedStudents.filter((s) => s.quad === quad).map((s) => s.id),
        );
        const withOutliers = buildPoints(quadStudentIds, quadStudentIds.size);
        return { quad, label: QUAD_LABELS[quad], sessions: withOutliers, averageAttendance: averageOf(withOutliers) };
      });

      // ── Per-grade trend (same valid-session mask) ──
      const byGrade: GradeTrend[] = [7, 8, 9, 10, 11, 12].map((grade) => {
        const gradeStudentIds = new Set(
          scopedStudents.filter((s) => s.grade === grade).map((s) => s.id),
        );
        const withOutliers = buildPoints(gradeStudentIds, gradeStudentIds.size);
        return { grade, sessions: withOutliers, averageAttendance: averageOf(withOutliers) };
      });

      // ── Group attendance summary (derived from student aggregate fields) ──
      // We don't have session-level group data yet, so compute summary from student totals.
      const withGroupData = scopedStudents.filter((s) => s.grpTotal > 0);
      const avgGroupPct = withGroupData.length > 0
        ? withGroupData.reduce((sum, s) => sum + (s.grpAttended / s.grpTotal), 0) / withGroupData.length
        : 0;

      // Classify each student's group trend vs prev term
      let increasing = 0, decreasing = 0, stable = 0;
      for (const s of withGroupData) {
        const currRate = s.grpTotal > 0 ? s.grpAttended / s.grpTotal : 0;
        const prevRate = s.prevGrpTotal > 0 ? s.prevGrpAttended / s.prevGrpTotal : null;
        if (prevRate === null) { stable++; continue; }
        const delta = currRate - prevRate;
        if (delta > 0.05) increasing++;
        else if (delta < -0.05) decreasing++;
        else stable++;
      }

      return {
        ministry,
        byQuad,
        byGrade,
        groupSummary: {
          totalStudentsWithGroupData: withGroupData.length,
          avgGroupAttendance: Math.round(avgGroupPct * 100),
          studentsIncreasing: increasing,
          studentsDecreasing: decreasing,
          studentsStable: stable,
        },
        generatedAt: new Date().toISOString(),
      };
    },
  };
}
