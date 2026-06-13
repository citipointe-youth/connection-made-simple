import { assertCan, canAccessGrade, canAccessGender, quadGenderOf, quadGradesOf } from './access-control';
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

// One term's worth of lifegroup numbers for a scope (a single group, a grade, a
// quad, or the whole ministry).
export interface TermAgg {
  uniqueAttenders: number; // distinct individuals who attended >=1 week this term
  avgPerWeek: number;      // mean individuals attending each week the scope ran
  weeksRan: number;        // distinct weeks the scope ran this term
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
}

export interface LifegroupStatsData {
  terms: Terms;
  overall: { current: TermAgg; previous: TermAgg };
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

      // Visibility — which lifegroups/students this login may see.
      const lifegroupVisible = (lgId: string): boolean => {
        const lg = lifegroupById.get(lgId);
        if (!lg) return false;
        if (!canAccessGrade(actor, lg.grade)) return false;
        if (actor.role === 'quad' && lg.gender) return canAccessGender(actor, lg.gender);
        return true;
      };
      const studentVisible = (sid: string): boolean => {
        const s = studentById.get(sid);
        if (!s) return false;
        if (actor.role === 'grade') return s.grade === actor.grade;
        if (actor.role === 'quad') return canAccessGrade(actor, s.grade) && canAccessGender(actor, s.gender);
        return true;
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
      ): TermAgg => {
        const weeksRan = new Set<string>();
        const attendersByWeek = new Map<string, Set<string>>();
        const unique = new Set<string>();
        for (const row of rows) {
          if (!groupScope(row.lifegroupId)) continue;
          if (classifyDate(row.weekStart, terms) !== term) continue;
          weeksRan.add(row.weekStart);
          if (!row.attended || !studentFilter(row)) continue;
          unique.add(row.studentId);
          let set = attendersByWeek.get(row.weekStart);
          if (!set) { set = new Set(); attendersByWeek.set(row.weekStart, set); }
          set.add(row.studentId);
        }
        let sum = 0;
        for (const w of weeksRan) sum += attendersByWeek.get(w)?.size ?? 0;
        const n = weeksRan.size;
        return {
          uniqueAttenders: unique.size,
          avgPerWeek: n > 0 ? Math.round(sum / n) : 0,
          weeksRan: n,
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
          current: termAgg(scope, () => true, 'current'),
          previous: termAgg(scope, () => true, 'previous'),
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

      // ── Per-grade: average = individuals OF THAT GRADE attending any lifegroup
      //    each week the grade's groups ran; lifegroups listed underneath. ──
      const byGrade: GradeLifegroupStat[] = [];
      for (const grade of visibleGrades) {
        const groupsOfGrade = lifegroups.filter((l) => l.grade === grade && lifegroupVisible(l.id));
        if (groupsOfGrade.length === 0) continue;
        const inGrade = (id: string) => { const lg = lifegroupById.get(id); return lg?.grade === grade; };
        const gradeStudent = (row: JoinedRow) => row.grade === grade;
        const lifegroupStats = groupsOfGrade
          .map((l) => statForGroup(l.id))
          .filter((s) => s.current.weeksRan > 0 || s.previous.weeksRan > 0)
          .sort((a, b) => b.current.uniqueAttenders - a.current.uniqueAttenders || a.name.localeCompare(b.name));
        const current = termAgg(inGrade, gradeStudent, 'current');
        const previous = termAgg(inGrade, gradeStudent, 'previous');
        if (current.weeksRan === 0 && previous.weeksRan === 0 && lifegroupStats.length === 0) continue;
        byGrade.push({ grade, current, previous, lifegroups: lifegroupStats });
      }

      // ── Per-quad: individuals OF THAT QUAD attending any quad lifegroup each week ──
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
        if (current.weeksRan === 0 && previous.weeksRan === 0) continue;
        byQuad.push({ quad, label: QUAD_LABELS[quad], current, previous });
      }

      // ── Overall (scoped to the login): all visible groups, all visible students ──
      const overallCurrent = termAgg(lifegroupVisible, (row) => studentVisible(row.studentId), 'current');
      const overallPrevious = termAgg(lifegroupVisible, (row) => studentVisible(row.studentId), 'previous');

      return {
        terms,
        overall: { current: overallCurrent, previous: overallPrevious },
        byQuad,
        byGrade,
        generatedAt: new Date().toISOString(),
      };
    },
  };
}
