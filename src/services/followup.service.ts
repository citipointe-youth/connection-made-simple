import type { Student } from '../core/entities/student';
import type {
  IConnectionRepository,
  IStudentRepository,
  ILeaderRepository,
  IServiceSessionRepository,
  IServiceAttendanceRepository,
  ILifegroupWeekRepository,
  ILifegroupAttendanceRepository,
} from '../repositories/interfaces';
import type { Actor } from '../core/entities/user';
import { assertCan } from './access-control';
import { NotFoundError } from '../core/errors/app-error';

export interface FollowupStudent {
  id: string;
  fullName: string;
  grade: number | null;
  gender: string;
  dateOfBirth: string | null;
  mobile: string | null;
  parentPhone: string | null;
}

// True if the student's birthday (month + day, year ignored) lands in the
// Mon–Sun week containing `today`. Iterating the 7 days of the week makes this
// correct across month/year boundaries.
export function isBirthdayInWeek(dob: string | null, today: Date): boolean {
  if (!dob) return false;
  const parts = String(dob).slice(0, 10).split('-');
  if (parts.length !== 3) return false;
  const bMonth = Number(parts[1]);
  const bDay = Number(parts[2]);
  if (!bMonth || !bDay) return false;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const mondayOffset = (base.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(base);
  monday.setDate(base.getDate() - mondayOffset);
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    if (day.getMonth() + 1 === bMonth && day.getDate() === bDay) return true;
  }
  return false;
}

// Eligible for the "Not seen at Friday" list: a normally-attending student —
// attended at least once this term, OR more than 50% of services last term.
export function isServiceEligible(s: { svcAttended: number; prevSvcAttended: number; prevSvcTotal: number }): boolean {
  if (s.svcAttended >= 1) return true;
  return s.prevSvcTotal > 0 && s.prevSvcAttended / s.prevSvcTotal > 0.5;
}

// Eligible for the "Not seen at Lifegroup" list: attended at least one group
// this term, OR more than 50% of groups last term.
export function isGroupEligible(s: { grpAttended: number; prevGrpAttended: number; prevGrpTotal: number }): boolean {
  if (s.grpAttended >= 1) return true;
  return s.prevGrpTotal > 0 && s.prevGrpAttended / s.prevGrpTotal > 0.5;
}

function toFollowup(s: Student): FollowupStudent {
  return {
    id: s.id,
    fullName: `${s.firstName} ${s.lastName}`,
    grade: s.grade,
    gender: s.gender,
    dateOfBirth: s.dateOfBirth,
    mobile: s.mobile,
    parentPhone: s.parentPhone,
  };
}

const byName = (a: FollowupStudent, b: FollowupStudent) => a.fullName.localeCompare(b.fullName);

// Assemble the three follow-up lists from the leader's students plus the
// attendee sets for the most recent service session and lifegroup week.
export function buildFollowup(
  students: Student[],
  latestSvcAttendees: Set<string>,
  latestGrpAttendees: Set<string>,
  latestSvcDate: string | null,
  latestGrpDate: string | null,
  today: Date,
): { birthdays: FollowupStudent[]; notSeenService: FollowupStudent[]; notSeenGroup: FollowupStudent[] } {
  const birthdays = students.filter((s) => isBirthdayInWeek(s.dateOfBirth, today)).map(toFollowup).sort(byName);
  const notSeenService = latestSvcDate
    ? students.filter((s) => isServiceEligible(s) && !latestSvcAttendees.has(s.id)).map(toFollowup).sort(byName)
    : [];
  const notSeenGroup = latestGrpDate
    ? students.filter((s) => isGroupEligible(s) && !latestGrpAttendees.has(s.id)).map(toFollowup).sort(byName)
    : [];
  return { birthdays, notSeenService, notSeenGroup };
}

export interface LeaderFollowup {
  leader: { id: string; fullName: string };
  latestSvcDate: string | null;
  latestGrpDate: string | null;
  birthdays: FollowupStudent[];
  notSeenService: FollowupStudent[];
  notSeenGroup: FollowupStudent[];
}

export interface FollowupService {
  leaderFollowup(actor: Actor, leaderId: string): Promise<LeaderFollowup>;
}

export function makeFollowupService(
  connRepo: IConnectionRepository,
  studentRepo: IStudentRepository,
  leaderRepo: ILeaderRepository,
  sessionRepo: IServiceSessionRepository,
  svcAttRepo: IServiceAttendanceRepository,
  weekRepo: ILifegroupWeekRepository,
  grpAttRepo: ILifegroupAttendanceRepository,
): FollowupService {
  return {
    async leaderFollowup(actor, leaderId) {
      assertCan(actor, 'leader:read');
      const [leader, conns, allStudents] = await Promise.all([
        leaderRepo.findById(leaderId),
        connRepo.findByLeader(leaderId),
        studentRepo.findAll(),
      ]);
      if (!leader) throw new NotFoundError('Leader not found');
      const connectedIds = new Set(conns.map((c) => c.studentId));
      const myStudents = allStudents.filter((s) => connectedIds.has(s.id));

      // Most recent VALID service session (ignores holiday/low-attendance Fridays).
      const validSessions = await sessionRepo.findValid();
      const latestSession = validSessions.reduce<(typeof validSessions)[number] | null>(
        (max, s) => (!max || s.sessionDate > max.sessionDate ? s : max),
        null,
      );
      let latestSvcAttendees = new Set<string>();
      if (latestSession) {
        const recs = await svcAttRepo.findBySession(latestSession.id);
        latestSvcAttendees = new Set(recs.filter((r) => r.attended).map((r) => r.studentId));
      }

      // Most recent lifegroup week (by weekStart).
      const weeks = await weekRepo.findAll();
      const latestWeek = weeks.reduce<(typeof weeks)[number] | null>(
        (max, w) => (!max || w.weekStart > max.weekStart ? w : max),
        null,
      );
      let latestGrpAttendees = new Set<string>();
      if (latestWeek) {
        const recs = await grpAttRepo.findByWeek(latestWeek.id);
        latestGrpAttendees = new Set(recs.filter((r) => r.attended).map((r) => r.studentId));
      }

      const lists = buildFollowup(
        myStudents,
        latestSvcAttendees,
        latestGrpAttendees,
        latestSession ? latestSession.sessionDate : null,
        latestWeek ? latestWeek.weekStart : null,
        new Date(),
      );
      return {
        leader: { id: leader.id, fullName: leader.fullName },
        latestSvcDate: latestSession ? latestSession.sessionDate : null,
        latestGrpDate: latestWeek ? latestWeek.weekStart : null,
        ...lists,
      };
    },
  };
}
