import { assertCan, canAccessGrade, canAccessGender, canAccessStudent, quadGenderOf, quadGradesOf } from './access-control';
import type {
  IStudentRepository,
  ILifegroupRepository,
  ILifegroupWeekRepository,
  ILifegroupAttendanceRepository,
  IServiceSessionRepository,
  ISettingsRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { Quad } from '../core/types/enums';
import { QUADS, QUAD_LABELS } from '../core/types/enums';
import { computeTerms, classifyDate, mondayOf, type Terms } from './terms';
import { ResponseCache } from '../utils/response-cache';

const _cache = new ResponseCache<LifegroupStatsData>(60_000);

export function invalidateLgStatsCache(): void {
  _cache.invalidateAll();
}

function _actorKey(actor: Actor): string {
  return `${actor.role}:${actor.grade ?? '_'}:${actor.quad ?? '_'}:${actor.gender ?? '_'}`;
}

// One term's worth of lifegroup numbers for a scope (a single group, a grade, a
// quad, or the whole ministry).
export interface TermAgg {
  uniqueAttenders: number; // distinct individuals who attended >=1 week this term
  avgPerWeek: number;      // mean individuals attending each week the scope ran
  weeksRan: number;        // distinct weeks the scope ran this term
  members: number;         // distinct students the scope ran for this term (enrolled)
  totalVisits: number;     // total attended visits this term (sum over weeks of attenders)
}

export interface LifegroupStat {
  lifegroupId: string;
  name: string;
  grade: number | null;
  gender: string | null;
  current: TermAgg;  // meanAttendees == current.avgPerWeek (avg attendees over weeks this group ran)
  previous: TermAgg;
}

export interface GradeLifegroupStat {
  grade: number;
  current: TermAgg;
  previous: TermAgg;
  lifegroups: LifegroupStat[];
}

export interface QuadLifegroupStat {
  quad: Quad;
  label: string;
  current: TermAgg;
  previous: TermAgg;
  // Per-grade breakdown scoped to THIS quad's gender + bracket (so a gendered
  // quad's grade rows are gendered, not combined across both genders).
  grades: GradeLifegroupStat[];
}

export interface WeekPoint {
  weekStart: string;
  attended: number; // distinct visible individuals attending a lifegroup that week
}

export interface LifegroupStatsData {
  terms: Terms;
  overall: { current: TermAgg; previous: TermAgg; weekly: WeekPoint[] };
  byQuad: QuadLifegroupStat[];
  byGrade: GradeLifegroupStat[];
  generatedAt: string;
}

export interface LifegroupStatsService {
  get(actor: Actor): Promise<LifegroupStatsData>;
}

// A lifegroup attendance row joined with its week date and the attender's grade/quad.
interface JoinedRow {
  lifegroupId: string;
  weekStart: string;
  studentId: string;
  attended: boolean;
  grade: number | null;
  quad: Quad | null;
}

export function makeLifegroupStatsService(
  studentRepo: IStudentRepository,
  lifegroupRepo: ILifegroupRepository,
  lifegroupWeekRepo: ILifegroupWeekRepository,
  lifegroupAttendanceRepo: ILifegroupAttendanceRepository,
  sessionRepo: IServiceSessionRepository,
  settingsRepo: ISettingsRepository,
): LifegroupStatsService {
  return {
    async get(actor) {
      assertCan(actor, 'overview:read');
      const cacheKey = _actorKey(actor);
      const cached = _cache.get(cacheKey);
      if (cached) return cached;

      const [settings, students, lifegroups, weeks, attendance, sessions] = await Promise.all([
        settingsRepo.getSettings(),
        studentRepo.findAll(),
        lifegroupRepo.findAll(),
        lifegroupWeekRepo.findAll(),
        lifegroupAttendanceRepo.findAll(),
        sessionRepo.findAll(),
      ]);

      const studentById = new Map(students.map((s) => [s.id, s]));
      const weekStartById = new Map(weeks.map((w) => [w.id, w.weekStart]));
      const lifegroupById = new Map(lifegroups.map((l) => [l.id, l]));

      // Term boundaries: valid service dates (Monday-bucketed) are authoritative;
      // fall back to lifegroup-week dates when there is no service data.
      const validDates = sessions.filter((s) => s.isValid).map((s) => mondayOf(s.sessionDate));
      const boundarySource = validDates.length > 0 ? validDates : [...weekStartById.values()];
      const terms = computeTerms(boundarySource, settings.termGapDays);

      // Number of VALID services (Fridays meeting the floor) per term — the group
      // averages divide by this (not by the weeks lifegroups ran), so group avg/wk
      // is normalised to the same calendar as the service average.
      let validSvcCurrent = 0, validSvcPrevious = 0;
      for (const s of sessions) {
        if (!s.isValid) continue;
        const t = classifyDate(mondayOf(s.sessionDate), terms);
        if (t === 'current') validSvcCurrent++;
        else if (t === 'previous') validSvcPrevious++;
      }

      // Visibility — which lifegroups/students this login may see.
      const lifegroupVisible = (lgId: string): boolean => {
        const lg = lifegroupById.get(lgId);
        if (!lg) return false;
        if (!canAccessGrade(actor, lg.grade)) return false;
        // Gender-scope for grade AND quad logins (admin/director see all).
        if (lg.gender && !canAccessGender(actor, lg.gender)) return false;
        return true;
      };
      const studentVisible = (sid: string): boolean => {
        const s = studentById.get(sid);
        if (!s) return false;
        return (actor.role === 'grade' || actor.role === 'quad')
          ? canAccessStudent(actor, s.grade, s.gender)
          : true;
      };

      // Join rows once (visible groups only).
      const rows: JoinedRow[] = [];
      for (const r of attendance) {
        if (!lifegroupVisible(r.lifegroupId)) continue;
        const weekStart = weekStartById.get(r.weekId);
        if (!weekStart) continue;
        const st = studentById.get(r.studentId);
        rows.push({
          lifegroupId: r.lifegroupId,
          weekStart,
          studentId: r.studentId,
          attended: r.attended,
          grade: st?.grade ?? null,
          quad: st?.quad ?? null,
        });
      }

      // Core aggregation: over the rows whose group is in `groupScope` and whose
      // attender passes `studentFilter`, compute unique/avg/weeksRan for a term.
      // "weeks ran" counts every week the scoped groups met (even 0-attender
      // weeks); the average is over those weeks so it reflects true cadence.
      const termAgg = (
        groupScope: (lgId: string) => boolean,
        studentFilter: (row: JoinedRow) => boolean,
        term: 'current' | 'previous',
        divideByWeeksRan = false,
      ): TermAgg => {
        const weeksRan = new Set<string>();
        const attendersByWeek = new Map<string, Set<string>>();
        const unique = new Set<string>();
        const members = new Set<string>();
        for (const row of rows) {
          if (!groupScope(row.lifegroupId)) continue;
          if (classifyDate(row.weekStart, terms) !== term) continue;
          weeksRan.add(row.weekStart);
          if (!studentFilter(row)) continue;
          members.add(row.studentId); // enrolled: the group ran for them this term
          if (!row.attended) continue;
          unique.add(row.studentId);
          let set = attendersByWeek.get(row.weekStart);
          if (!set) { set = new Set(); attendersByWeek.set(row.weekStart, set); }
          set.add(row.studentId);
        }
        let sum = 0;
        for (const w of weeksRan) sum += attendersByWeek.get(w)?.size ?? 0;
        const n = weeksRan.size;
        // Denominator depends on the scope:
        //  - grade / quad / overall normalise to the VALID SERVICES in the term
        //    (valid Fridays), falling back to the weeks the scope ran when there
        //    is no service data — keeps those averages on the service calendar.
        //  - an INDIVIDUAL lifegroup divides by the number of times THAT group
        //    actually met (`divideByWeeksRan`), so its average reflects its own
        //    cadence rather than the service calendar.
        const validSvc = term === 'current' ? validSvcCurrent : validSvcPrevious;
        const denom = divideByWeeksRan ? n : (validSvc > 0 ? validSvc : n);
        return {
          uniqueAttenders: unique.size,
          avgPerWeek: denom > 0 ? Math.round(sum / denom) : 0,
          weeksRan: n,
          members: members.size,
          totalVisits: sum,
        };
      };

      // ── Per-lifegroup (the group itself is the scope; all its attenders count) ──
      const statForGroup = (lgId: string): LifegroupStat => {
        const lg = lifegroupById.get(lgId)!;
        const scope = (id: string) => id === lgId;
        return {
          lifegroupId: lgId,
          name: lg.shortName || lg.fullName,
          grade: lg.grade,
          gender: lg.gender,
          // Per-group average divides by the weeks THIS group met (not valid services).
          current: termAgg(scope, () => true, 'current', true),
          previous: termAgg(scope, () => true, 'previous', true),
        };
      };

      // Visible grades/quads for this login.
      const allGrades = [7, 8, 9, 10, 11, 12];
      const visibleGrades = actor.role === 'grade'
        ? (actor.grade != null ? [actor.grade] : [])
        : actor.role === 'quad'
          ? quadGradesOf(actor.quad)
          : allGrades;
      const visibleQuads: Quad[] = actor.role === 'grade'
        ? []
        : actor.role === 'quad'
          ? (actor.quad ? [actor.quad] : [])
          : [...QUADS];

      // A per-grade stat, optionally constrained to a gender (for the per-quad
      // breakdown). `gender` null = any gender (used for the top-level byGrade,
      // which is already gender-scoped for quad/grade logins via lifegroupVisible).
      // `studentFilter` picks which attenders count toward the grade average.
      const gradeStatFor = (
        grade: number,
        gender: 'male' | 'female' | null,
        studentFilter: (row: JoinedRow) => boolean,
      ): GradeLifegroupStat => {
        const matchGender = (g: string | null) => gender == null || !g || g === gender;
        const groupsOfGrade = lifegroups.filter((l) => l.grade === grade && lifegroupVisible(l.id) && matchGender(l.gender));
        const inGrade = (id: string) => { const lg = lifegroupById.get(id); return lg?.grade === grade && matchGender(lg.gender); };
        const lifegroupStats = groupsOfGrade
          .map((l) => statForGroup(l.id))
          .filter((s) => s.current.weeksRan > 0 || s.previous.weeksRan > 0)
          .sort((a, b) => b.current.uniqueAttenders - a.current.uniqueAttenders || a.name.localeCompare(b.name));
        return {
          grade,
          current: termAgg(inGrade, studentFilter, 'current'),
          previous: termAgg(inGrade, studentFilter, 'previous'),
          lifegroups: lifegroupStats,
        };
      };
      const isEmptyGrade = (g: GradeLifegroupStat) =>
        g.current.weeksRan === 0 && g.previous.weeksRan === 0 && g.lifegroups.length === 0;

      // ── Per-grade (top level): individuals OF THAT GRADE attending each week. ──
      const byGrade: GradeLifegroupStat[] = [];
      for (const grade of visibleGrades) {
        const gs = gradeStatFor(grade, null, (row) => row.grade === grade);
        if (isEmptyGrade(gs)) continue;
        byGrade.push(gs);
      }

      // ── Per-quad: individuals OF THAT QUAD attending each week, with a GENDERED
      //    per-grade breakdown underneath (grade + the quad's gender). ──
      const byQuad: QuadLifegroupStat[] = [];
      for (const quad of visibleQuads) {
        const grades = quadGradesOf(quad);
        const gender = quadGenderOf(quad);
        const inQuad = (id: string) => {
          const lg = lifegroupById.get(id);
          if (!lg || lg.grade == null || !grades.includes(lg.grade)) return false;
          // A group with a known gender must match the quad's gender.
          return !lg.gender || lg.gender === gender;
        };
        const quadStudent = (row: JoinedRow) => row.quad === quad;
        const current = termAgg(inQuad, quadStudent, 'current');
        const previous = termAgg(inQuad, quadStudent, 'previous');
        const quadGrades = grades
          .map((g) => gradeStatFor(g, gender, (row) => row.quad === quad && row.grade === g))
          .filter((g) => !isEmptyGrade(g));
        if (current.weeksRan === 0 && previous.weeksRan === 0 && quadGrades.length === 0) continue;
        byQuad.push({ quad, label: QUAD_LABELS[quad], current, previous, grades: quadGrades });
      }

      // ── Overall (scoped to the login): all visible groups, all visible students ──
      const overallCurrent = termAgg(lifegroupVisible, (row) => studentVisible(row.studentId), 'current');
      const overallPrevious = termAgg(lifegroupVisible, (row) => studentVisible(row.studentId), 'previous');

      // Weekly series for the current term (one bar per week any visible lifegroup
      // ran; value = distinct visible individuals who attended that week).
      const weekMap = new Map<string, Set<string>>();
      for (const row of rows) {
        if (classifyDate(row.weekStart, terms) !== 'current') continue;
        let set = weekMap.get(row.weekStart);
        if (!set) { set = new Set(); weekMap.set(row.weekStart, set); }
        if (row.attended && studentVisible(row.studentId)) set.add(row.studentId);
      }
      const weekly: WeekPoint[] = [...weekMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([weekStart, set]) => ({ weekStart, attended: set.size }));

      const result: LifegroupStatsData = {
        terms,
        overall: { current: overallCurrent, previous: overallPrevious, weekly },
        byQuad,
        byGrade,
        generatedAt: new Date().toISOString(),
      };
      _cache.set(cacheKey, result);
      return result;
    },
  };
}
