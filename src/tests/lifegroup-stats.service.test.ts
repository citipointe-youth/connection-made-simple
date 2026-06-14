import { describe, it, expect } from 'vitest';
import { makeLifegroupStatsService } from '../services/lifegroup-stats.service';
import { makeImportService } from '../services/import.service';
import {
  InMemoryStudentRepository,
  InMemoryLeaderRepository,
  InMemoryServiceSessionRepository,
  InMemoryServiceAttendanceRepository,
  InMemoryLifegroupRepository,
  InMemoryLifegroupWeekRepository,
  InMemoryLifegroupAttendanceRepository,
  InMemoryImportRepository,
  InMemorySettingsRepository,
} from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';

const ADMIN: Actor = { id: 'u-admin', role: 'admin', displayName: 'Admin', grade: null, quad: null };
const DIR: Actor = { id: 'u-dir', role: 'director', displayName: 'Dir', grade: null, quad: null };

function makeRepos() {
  return {
    students: new InMemoryStudentRepository(),
    sessions: new InMemoryServiceSessionRepository(),
    attendance: new InMemoryServiceAttendanceRepository(),
    imports: new InMemoryImportRepository(),
    settings: new InMemorySettingsRepository(),
    lifegroups: new InMemoryLifegroupRepository(),
    lifegroupWeeks: new InMemoryLifegroupWeekRepository(),
    lifegroupAttendance: new InMemoryLifegroupAttendanceRepository(),
    leaders: new InMemoryLeaderRepository(),
  };
}

async function setup() {
  const r = makeRepos();
  await Promise.all([
    r.students.init(), r.sessions.init(), r.attendance.init(), r.imports.init(), r.settings.init(),
    r.lifegroups.init(), r.lifegroupWeeks.init(), r.lifegroupAttendance.init(), r.leaders.init(),
  ]);
  await r.settings.updateSettings({ serviceMinAttendance: 1 });
  const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance, r.leaders);

  // Service import establishes Term 1 (Feb) + Term 2 (Apr, current) boundaries and
  // gives the students a known grade/gender.
  await svc.importServiceCsv(ADMIN, [
    { first_name: 'Amy', last_name: 'A', gender: 'female', grade: 9,
      '2026-02-06': true, '2026-02-13': true, '2026-04-17': true, '2026-04-24': true },
    { first_name: 'Bea', last_name: 'B', gender: 'female', grade: 9,
      '2026-02-06': true, '2026-04-17': true, '2026-04-24': true },
  ], 'svc.csv');

  // One grade-9 girls lifegroup running across both terms.
  await svc.importGroupCsv(DIR, {
    groups: [{
      name: 'Grade 9 Girls Lifegroup',
      meetings: ['2026-02-09', '2026-04-13', '2026-04-20'],
      members: [
        { first_name: 'Amy', last_name: 'A', attendance: [true, true, true] },   // prev 1/1, cur 2/2
        { first_name: 'Bea', last_name: 'B', attendance: [false, true, false] }, // prev 0, cur 1/2
      ],
    }],
  }, 'grp.csv');

  const statsSvc = makeLifegroupStatsService(r.students, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance, r.sessions, r.settings);
  return { r, statsSvc };
}

describe('Lifegroup Stats Service', () => {
  it('computes per-lifegroup mean attendees, unique, and weeks ran per term', async () => {
    const { statsSvc } = await setup();
    const data = await statsSvc.get(ADMIN);

    const grade9 = data.byGrade.find((g) => g.grade === 9)!;
    expect(grade9).toBeDefined();
    const lg = grade9.lifegroups[0]!;

    // Current term: 2 weeks ran (Apr 13, Apr 20). Week Apr13: Amy+Bea=2; Apr20: Amy=1 → mean 1.5 → round 2.
    expect(lg.current.weeksRan).toBe(2);
    expect(lg.current.uniqueAttenders).toBe(2);
    expect(lg.current.avgPerWeek).toBe(2); // round(3/2)

    // Previous term: 1 week ran (Feb 9). Amy attended, Bea didn't → 1 attender.
    expect(lg.previous.weeksRan).toBe(1);
    expect(lg.previous.uniqueAttenders).toBe(1);
    expect(lg.previous.avgPerWeek).toBe(1);
  });

  it('computes per-grade average individuals attending each week', async () => {
    const { statsSvc } = await setup();
    const data = await statsSvc.get(ADMIN);
    const grade9 = data.byGrade.find((g) => g.grade === 9)!;
    expect(grade9.current.uniqueAttenders).toBe(2);
    expect(grade9.current.weeksRan).toBe(2);
    expect(grade9.current.avgPerWeek).toBe(2);
    expect(grade9.previous.uniqueAttenders).toBe(1);
  });

  it('rolls grade stats up into the quad', async () => {
    const { statsSvc } = await setup();
    const data = await statsSvc.get(ADMIN);
    const g79 = data.byQuad.find((q) => q.quad === 'g79')!;
    expect(g79).toBeDefined();
    expect(g79.current.uniqueAttenders).toBe(2);
    expect(g79.current.weeksRan).toBe(2);
  });

  it('scopes to a single grade for a grade login', async () => {
    const { statsSvc } = await setup();
    const gradeActor: Actor = { id: 'g9', role: 'grade', displayName: 'G9', grade: 9, quad: null };
    const data = await statsSvc.get(gradeActor);
    expect(data.byGrade.map((g) => g.grade)).toEqual([9]);
    expect(data.byQuad).toHaveLength(0); // grade logins don't get a quad breakdown
  });

  it('group average divides by VALID SERVICES in the term, not weeks the group ran', async () => {
    const r = makeRepos();
    await Promise.all([
      r.students.init(), r.sessions.init(), r.attendance.init(), r.imports.init(), r.settings.init(),
      r.lifegroups.init(), r.lifegroupWeeks.init(), r.lifegroupAttendance.init(), r.leaders.init(),
    ]);
    await r.settings.updateSettings({ serviceMinAttendance: 1 });
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance, r.leaders);
    // 4 valid Fridays this term; 3 girls attend them all.
    await svc.importServiceCsv(ADMIN, [
      { first_name: 'A', last_name: 'A', gender: 'female', grade: 9, '2026-04-03': true, '2026-04-10': true, '2026-04-17': true, '2026-04-24': true },
      { first_name: 'B', last_name: 'B', gender: 'female', grade: 9, '2026-04-03': true, '2026-04-10': true, '2026-04-17': true, '2026-04-24': true },
      { first_name: 'C', last_name: 'C', gender: 'female', grade: 9, '2026-04-03': true, '2026-04-10': true, '2026-04-17': true, '2026-04-24': true },
    ], 'svc.csv');
    // The lifegroup only ran 2 of those 4 weeks; all 3 attend both.
    await svc.importGroupCsv(DIR, {
      groups: [{ name: 'Grade 9 Girls Lifegroup', meetings: ['2026-04-13', '2026-04-20'], members: [
        { first_name: 'A', last_name: 'A', attendance: [true, true] },
        { first_name: 'B', last_name: 'B', attendance: [true, true] },
        { first_name: 'C', last_name: 'C', attendance: [true, true] },
      ] }],
    }, 'grp.csv');

    const statsSvc = makeLifegroupStatsService(r.students, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance, r.sessions, r.settings);
    const lg = (await statsSvc.get(ADMIN)).byGrade.find(g => g.grade === 9)!.lifegroups[0]!;
    // total visits = 6 (3 each over 2 weeks). weeks ran = 2.
    expect(lg.current.weeksRan).toBe(2);
    expect(lg.current.totalVisits).toBe(6);
    // NEW: divide by 4 valid services -> round(6/4)=2 (old behaviour /2 weeks ran = 3).
    expect(lg.current.avgPerWeek).toBe(2);
  });

  it('per-quad grade breakdown is GENDERED (g79 grade 9 excludes the boys group)', async () => {
    const r = makeRepos();
    await Promise.all([
      r.students.init(), r.sessions.init(), r.attendance.init(), r.imports.init(), r.settings.init(),
      r.lifegroups.init(), r.lifegroupWeeks.init(), r.lifegroupAttendance.init(), r.leaders.init(),
    ]);
    await r.settings.updateSettings({ serviceMinAttendance: 1 });
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance, r.leaders);
    await svc.importServiceCsv(ADMIN, [
      { first_name: 'Amy', last_name: 'A', gender: 'female', grade: 9, '2026-04-17': true, '2026-04-24': true },
      { first_name: 'Ben', last_name: 'B', gender: 'male', grade: 9, '2026-04-17': true, '2026-04-24': true },
    ], 'svc.csv');
    await svc.importGroupCsv(DIR, {
      groups: [
        { name: 'Grade 9 Girls Lifegroup', meetings: ['2026-04-13', '2026-04-20'], members: [{ first_name: 'Amy', last_name: 'A', attendance: [true, true] }] },
        { name: 'Grade 9 Boys Lifegroup', meetings: ['2026-04-13', '2026-04-20'], members: [{ first_name: 'Ben', last_name: 'B', attendance: [true, true] }] },
      ],
    }, 'grp.csv');

    const statsSvc = makeLifegroupStatsService(r.students, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance, r.sessions, r.settings);
    const data = await statsSvc.get(ADMIN);
    const g79 = data.byQuad.find((q) => q.quad === 'g79')!;
    const grade9 = g79.grades.find((g) => g.grade === 9)!;
    // Only the girls' group + Amy should be counted under g79 / grade 9.
    expect(grade9.lifegroups.map((l) => l.name)).toEqual(['Grade 9 Girls Lifegroup']);
    expect(grade9.current.uniqueAttenders).toBe(1);
    const b79 = data.byQuad.find((q) => q.quad === 'b79')!;
    expect(b79.grades.find((g) => g.grade === 9)!.lifegroups.map((l) => l.name)).toEqual(['Grade 9 Boys Lifegroup']);
  });
});
