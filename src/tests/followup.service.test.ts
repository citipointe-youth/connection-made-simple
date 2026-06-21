import { describe, it, expect } from 'vitest';
import {
  isBirthdayInWeek,
  isServiceEligible,
  isGroupEligible,
  buildFollowup,
} from '../services/followup.service';
import type { Student } from '../core/entities/student';

function student(over: Partial<Student>): Student {
  return {
    id: 'id', firstName: 'Test', lastName: 'Student', gender: 'female', grade: 9, quad: 'g79',
    mobile: null, parentPhone: null, dateOfBirth: null,
    svcAttended: 0, svcTotal: 0, grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
    prevSvcAttended: 0, prevSvcTotal: 0, prevGrpAttended: 0, prevGrpTotal: 0,
    atRiskStatus: null, dataSource: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('isBirthdayInWeek', () => {
  // Wednesday 2026-06-17 sits in the Mon 2026-06-15 .. Sun 2026-06-21 week.
  const wed = new Date(2026, 5, 17);
  it('true when the birthday month/day falls in the current Mon–Sun week', () => {
    expect(isBirthdayInWeek('2009-06-18', wed)).toBe(true); // Thursday this week
  });
  it('true on the Monday boundary', () => {
    expect(isBirthdayInWeek('2010-06-15', wed)).toBe(true);
  });
  it('true on the Sunday boundary', () => {
    expect(isBirthdayInWeek('2010-06-21', wed)).toBe(true);
  });
  it('false when outside the week', () => {
    expect(isBirthdayInWeek('2010-06-22', wed)).toBe(false);
  });
  it('false for null / malformed dates', () => {
    expect(isBirthdayInWeek(null, wed)).toBe(false);
    expect(isBirthdayInWeek('not-a-date', wed)).toBe(false);
  });
  it('ignores the birth year, matches on month/day only', () => {
    expect(isBirthdayInWeek('1999-06-19T00:00:00.000Z', wed)).toBe(true);
  });
});

describe('isServiceEligible', () => {
  it('true when attended at least once this term', () => {
    expect(isServiceEligible({ svcAttended: 1, prevSvcAttended: 0, prevSvcTotal: 0 })).toBe(true);
  });
  it('true when attended > 50% of previous term', () => {
    expect(isServiceEligible({ svcAttended: 0, prevSvcAttended: 6, prevSvcTotal: 10 })).toBe(true);
  });
  it('false at exactly 50% of previous term with none this term', () => {
    expect(isServiceEligible({ svcAttended: 0, prevSvcAttended: 5, prevSvcTotal: 10 })).toBe(false);
  });
  it('false when never attended either term', () => {
    expect(isServiceEligible({ svcAttended: 0, prevSvcAttended: 0, prevSvcTotal: 0 })).toBe(false);
  });
});

describe('isGroupEligible', () => {
  it('true when attended at least one group this term', () => {
    expect(isGroupEligible({ grpAttended: 1, prevGrpAttended: 0, prevGrpTotal: 0 })).toBe(true);
  });
  it('true when attended > 50% of groups previous term', () => {
    expect(isGroupEligible({ grpAttended: 0, prevGrpAttended: 7, prevGrpTotal: 10 })).toBe(true);
  });
  it('false at exactly 50% with none this term', () => {
    expect(isGroupEligible({ grpAttended: 0, prevGrpAttended: 5, prevGrpTotal: 10 })).toBe(false);
  });
});

describe('buildFollowup', () => {
  const wed = new Date(2026, 5, 17);
  const eligibleSeen = student({ id: 's1', firstName: 'Ann', svcAttended: 3, grpAttended: 2, dateOfBirth: '2009-06-18' });
  const eligibleMissed = student({ id: 's2', firstName: 'Bea', svcAttended: 2, grpAttended: 2 });
  const ineligible = student({ id: 's3', firstName: 'Cara', svcAttended: 0, grpAttended: 0 });

  it('birthdays list contains only students with a birthday this week', () => {
    const r = buildFollowup([eligibleSeen, eligibleMissed, ineligible], new Set(['s1']), new Set(['s1']), '2026-06-19', '2026-06-15', wed);
    expect(r.birthdays.map(s => s.id)).toEqual(['s1']);
  });
  it('notSeenService = eligible students NOT in the latest-service attendee set', () => {
    const r = buildFollowup([eligibleSeen, eligibleMissed, ineligible], new Set(['s1']), new Set(['s1']), '2026-06-19', '2026-06-15', wed);
    expect(r.notSeenService.map(s => s.id)).toEqual(['s2']);
  });
  it('notSeenGroup = group-eligible students NOT in the latest-week attendee set', () => {
    const r = buildFollowup([eligibleSeen, eligibleMissed, ineligible], new Set(['s1']), new Set(['s1']), '2026-06-19', '2026-06-15', wed);
    expect(r.notSeenGroup.map(s => s.id)).toEqual(['s2']);
  });
  it('returns empty service/group lists when there is no latest session/week', () => {
    const r = buildFollowup([eligibleMissed], new Set(), new Set(), null, null, wed);
    expect(r.notSeenService).toEqual([]);
    expect(r.notSeenGroup).toEqual([]);
  });
  it('lists are sorted by full name', () => {
    const zed = student({ id: 's9', firstName: 'Zed', svcAttended: 2 });
    const r = buildFollowup([zed, eligibleMissed], new Set(), new Set(), '2026-06-19', null, wed);
    expect(r.notSeenService.map(s => s.fullName)).toEqual(['Bea Student', 'Zed Student']);
  });
});

import { makeFollowupService } from '../services/followup.service';
import {
  InMemoryConnectionRepository,
  InMemoryStudentRepository,
  InMemoryLeaderRepository,
  InMemoryServiceSessionRepository,
  InMemoryServiceAttendanceRepository,
  InMemoryLifegroupWeekRepository,
  InMemoryLifegroupAttendanceRepository,
} from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';

const ADMIN: Actor = { id: 'a', role: 'admin' as any, displayName: 'A', grade: null as any, quad: null as any };

describe('makeFollowupService.leaderFollowup', () => {
  it('returns not-seen lists for connected, eligible students who missed the latest session/week', async () => {
    const connRepo = new InMemoryConnectionRepository();
    const studentRepo = new InMemoryStudentRepository();
    const leaderRepo = new InMemoryLeaderRepository();
    const sessionRepo = new InMemoryServiceSessionRepository();
    const svcAttRepo = new InMemoryServiceAttendanceRepository();
    const weekRepo = new InMemoryLifegroupWeekRepository();
    const grpAttRepo = new InMemoryLifegroupAttendanceRepository();
    for (const r of [connRepo, studentRepo, leaderRepo, sessionRepo, svcAttRepo, weekRepo, grpAttRepo]) await r.init();

    const leader = await leaderRepo.save({ id: 'L1', fullName: 'Em Leader', gender: 'female', grades: [9], active: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as any);
    const base = { gender: 'female', grade: 9, quad: 'g79', mobile: null, parentPhone: null, dateOfBirth: null, svcTotal: 4, grpTotal: 4, grpMetWeeks: 4, prevSvcAttended: 0, prevSvcTotal: 0, prevGrpAttended: 0, prevGrpTotal: 0, atRiskStatus: null, dataSource: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const seen = await studentRepo.save({ id: 'S1', firstName: 'Ann', lastName: 'A', svcAttended: 3, grpAttended: 3, ...base } as any);
    const missed = await studentRepo.save({ id: 'S2', firstName: 'Bea', lastName: 'B', svcAttended: 2, grpAttended: 2, ...base } as any);
    await connRepo.save({ id: 'C1', studentId: seen.id, leaderId: leader.id, createdAt: '2026-01-01T00:00:00.000Z' } as any);
    await connRepo.save({ id: 'C2', studentId: missed.id, leaderId: leader.id, createdAt: '2026-01-01T00:00:00.000Z' } as any);

    const older = await sessionRepo.save({ id: 'SS0', importId: 'i', sessionDate: '2026-06-05', sessionName: 'old', isRegular: true, isValid: true, totalAttendance: 200, sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z' } as any);
    const latest = await sessionRepo.save({ id: 'SS1', importId: 'i', sessionDate: '2026-06-12', sessionName: 'latest', isRegular: true, isValid: true, totalAttendance: 200, sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' } as any);
    void older;
    await svcAttRepo.saveMany([{ studentId: seen.id, sessionId: latest.id, attended: true }]); // missed has no record for latest

    const week = await weekRepo.save({ id: 'W1', importId: 'i', weekNum: 1, weekKey: '2026-06-08', weekStart: '2026-06-08', weekEnd: '2026-06-14' } as any);
    await grpAttRepo.saveMany([{ studentId: seen.id, weekId: week.id, lifegroupId: 'g', groupMet: true, attended: true }]);

    const svc = makeFollowupService(connRepo, studentRepo, leaderRepo, sessionRepo, svcAttRepo, weekRepo, grpAttRepo);
    const out = await svc.leaderFollowup(ADMIN, leader.id);

    expect(out.leader.fullName).toBe('Em Leader');
    expect(out.latestSvcDate).toBe('2026-06-12');
    expect(out.latestGrpDate).toBe('2026-06-08');
    expect(out.notSeenService.map((s) => s.id)).toEqual(['S2']);
    expect(out.notSeenGroup.map((s) => s.id)).toEqual(['S2']);
  });
});
