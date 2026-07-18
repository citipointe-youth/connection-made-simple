import { describe, it, expect } from 'vitest';
import { buildPrayerCsvRows, parsePrayerRows, planPrayerImport } from '../services/prayer-allocations';
import type { PrayerRequest } from '../core/entities/prayer';
import type { Student } from '../core/entities/student';

const student = (id: string, first: string, grade: number, gender: string): Student => ({
  id, firstName: first, lastName: 'Smith', gender: gender as any, grade, quad: null,
  mobile: null, parentPhone: null, dateOfBirth: null,
  svcAttended: 0, svcTotal: 0, grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
  prevSvcAttended: 0, prevSvcTotal: 0, prevGrpAttended: 0, prevGrpTotal: 0,
  atRiskStatus: null, dataSource: null, createdAt: '', updatedAt: '',
});
const prayer = (id: string, sid: string | null, text: string): PrayerRequest => ({
  id, studentId: sid, text, status: 'open', answerNote: null,
  createdByLabel: 'Sarah', createdByRole: 'grade',
  createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', answeredAt: null,
});

describe('prayer CSV round-trip', () => {
  it('export produces one row per prayer with the student name', () => {
    const rows = buildPrayerCsvRows([prayer('p1', 's1', 'exams')], [student('s1', 'Ava', 9, 'female')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstName: 'Ava', lastName: 'Smith', grade: 9, gender: 'female', prayer: 'exams', status: 'open' });
  });

  it('import name-matches and adds new prayers, skipping duplicates', () => {
    const students = [student('s1', 'Ava', 9, 'female')];
    const existing = [prayer('p1', 's1', 'exams')];
    const parsed = parsePrayerRows([
      { 'first name': 'Ava', 'last name': 'Smith', prayer: 'exams', status: 'open' },      // dup -> skip
      { 'first name': 'Ava', 'last name': 'Smith', prayer: 'new one', status: 'open' },     // add
      { 'first name': 'Ghost', 'last name': 'X', prayer: 'p', status: 'open' },             // unmatched
    ]);
    const plan = planPrayerImport(parsed, students, existing);
    expect(plan.toAdd).toHaveLength(1);
    expect(plan.toAdd[0]!.studentId).toBe('s1');
    expect(plan.toAdd[0]!.text).toBe('new one');
    expect(plan.report.added).toBe(1);
    expect(plan.report.skippedDuplicates).toBe(1);
    expect(plan.report.unmatched.map((u) => u.name)).toEqual(['Ghost X']);
  });

  it('exports a general (no-student) prayer with blank name fields', () => {
    const rows = buildPrayerCsvRows([prayer('p1', null, 'pray for the group')], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstName: '', lastName: '', grade: null, gender: '', prayer: 'pray for the group' });
  });

  it('a blank-name row round-trips into a general prayer, not an unmatched student', () => {
    const parsed = parsePrayerRows([
      { 'first name': '', 'last name': '', prayer: 'pray for the group', status: 'open' },
    ]);
    const plan = planPrayerImport(parsed, [student('s1', 'Ava', 9, 'female')], []);
    expect(plan.toAdd).toHaveLength(1);
    expect(plan.toAdd[0]!.studentId).toBeNull();
    expect(plan.report.unmatched).toHaveLength(0);
    expect(plan.report.added).toBe(1);
  });
});
