import { assertCan, canAccessStudent } from './access-control';
import type {
  IStudentRepository,
  IServiceSessionRepository,
  IServiceAttendanceRepository,
  ISettingsRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { Quad } from '../core/types/enums';
import { QUADS, QUAD_LABELS } from '../core/types/enums';
import { computeTerms, classifyDate, saturdayOf, type Terms } from './terms';
import { ResponseCache } from '../utils/response-cache';

// Module-level cache — survives across requests on the same warm serverless instance.
// Cleared on every import so data is never stale after a CSV upload.
const _cache = new ResponseCache<TrendsData>(60_000);

export function invalidateTrendsCache(): void {
  _cache.invalidateAll();
}

function _actorKey(actor: Actor): string {
  return `${actor.role}:${actor.grade ?? '_'}:${actor.quad ?? '_'}:${actor.gender ?? '_'}`;
}

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
  averageAttendance: number;       // current term, WHOLE ministry
  uniqueAttenders: number;         // current term, WHOLE ministry
  prevAverageAttendance: number;   // previous term, WHOLE ministry
  prevUniqueAttenders: number;     // previous term, WHOLE ministry
  peakAttendance: number;
  peakDate: string;
  recentTrend: 'up' | 'down' | 'stable';
}

export interface TrendsData {
  // Term boundaries (service-date gaps). Trends default to the CURRENT term; the
  // chart and every average below are scoped to it. Previous-term comparison
  // numbers are derived client-side from the student prev* fields.
  terms: Terms;
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
      const cacheKey = _actorKey(actor);
      const cached = _cache.get(cacheKey);
      if (cached) return cached;

      // Fetch in parallel — serial round-trips to the Supabase pooler dominate
      // this endpoint's cold latency (it's one of the slow Home/Trends deps).
      const [settings, allStudents, allSessions, allAttendance] = await Promise.all([
        settingsRepo.getSettings(),
        studentRepo.findAll(),
        sessionRepo.findAll(),
        attendanceRepo.findAll(),
      ]);
      const minAttendance = settings.serviceMinAttendance;

      // Scope students to actor (grade -> own grade + own gender; quad -> bracket + gender)
      const scopedStudents = allStudents.filter((s) =>
        (actor.role === 'grade' || actor.role === 'quad')
          ? canAccessStudent(actor, s.grade, s.gender)
          : true,
      );

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
      // entirely.
      const isValidSession = (sessionId: string): boolean =>
        (attendedBySession.get(sessionId)?.size ?? 0) >= minAttendance;

      // Term boundaries come from the valid service dates (Monday-bucketed), the
      // same rule the import uses. Trends default to the CURRENT term: a point is
      // shown/averaged only if it is a valid service AND falls in the current
      // term. isOutlier therefore means "not a current-term valid service" (also
      // hides it from the chart). This keeps the chart and every average — and the
      // home page that reads them — scoped to "this term".
      const validDates = sortedSessions
        .filter((s) => isValidSession(s.id))
        .map((s) => saturdayOf(s.sessionDate));
      const terms = computeTerms(validDates, settings.termGapDays);
      const isCurrentSession = (sess: { id: string; sessionDate: string }): boolean =>
        isValidSession(sess.id) && classifyDate(saturdayOf(sess.sessionDate), terms) === 'current';

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
            isOutlier: !isCurrentSession(sess),
          };
        });

      // ── Ministry-level trend — ALWAYS the WHOLE ministry, not scoped to the
      // actor. A grade/quad login still sees the ministry-wide unique + average
      // here (their own breakdown lives in byQuad/byGrade below). ──
      const ministryWithOutliers = buildPoints(null, allStudents.length);
      const validMinistry = ministryWithOutliers.filter((p) => !p.isOutlier);
      const avgMinistry = averageOf(ministryWithOutliers);
      const peakPoint = validMinistry.reduce((max, p) => p.totalAttended > (max?.totalAttended ?? 0) ? p : max, validMinistry[0]);

      // Current + previous term unique attenders / previous average (whole ministry).
      const curUniq = new Set<string>();
      const prevUniq = new Set<string>();
      let prevAtt = 0, prevWeeks = 0;
      for (const sess of sortedSessions) {
        if (!isValidSession(sess.id)) continue;
        const term = classifyDate(saturdayOf(sess.sessionDate), terms);
        const attended = attendedBySession.get(sess.id) ?? new Set<string>();
        if (term === 'current') { for (const id of attended) curUniq.add(id); }
        else if (term === 'previous') { prevAtt += attended.size; prevWeeks++; for (const id of attended) prevUniq.add(id); }
      }

      const ministry: MinistryTrend = {
        sessions: ministryWithOutliers,
        averageAttendance: avgMinistry,
        uniqueAttenders: curUniq.size,
        prevAverageAttendance: prevWeeks > 0 ? Math.round(prevAtt / prevWeeks) : 0,
        prevUniqueAttenders: prevUniq.size,
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
        // >= 20 percentage points vs previous term (raised from 5pts).
        if (delta > 0.20) increasing++;
        else if (delta < -0.20) decreasing++;
        else stable++;
      }

      const result: TrendsData = {
        terms,
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
      _cache.set(cacheKey, result);
      return result;
    },
  };
}
