import { describe, it, expect } from 'vitest';
import { buildPrayerCsvRows, parsePrayerRows, planPrayerImport } from '../services/prayer-allocations';
import type { PrayerCsvRow } from '../services/prayer-allocations';
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
  createdByGrades: null, createdByGender: null,
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

  // H1/M3 (2026-07-19): export -> import must reproduce a general prayer's
  // creator scope AND real timestamps, not silently widen scope to
  // ministry-wide / reset createdAt+answeredAt to now. Turns a PrayerCsvRow
  // back into the header-keyed Record<string, unknown> shape a real parsed
  // CSV file would have (mirrors how the SPA's CSV reader keys rows).
  function csvRowToFileRow(r: PrayerCsvRow): Record<string, unknown> {
    return {
      'first name': r.firstName,
      'last name': r.lastName,
      prayer: r.prayer,
      status: r.status,
      'answer note': r.answerNote,
      'added by': r.addedBy,
      'created by grades': r.createdByGrades,
      'created by gender': r.createdByGender,
      'created at': r.createdAt,
      'answered at': r.answeredAt,
    };
  }

  it("H1/M3: round-trips a general prayer's NON-null creator scope AND real timestamps through export -> import", () => {
    const scoped: PrayerRequest = {
      id: 'p1', studentId: null, text: 'pray for grade 9 girls', status: 'answered',
      answerNote: 'praise report', createdByLabel: 'Sarah', createdByRole: 'grade',
      createdByGrades: [9], createdByGender: 'female',
      createdAt: '2026-01-15T03:22:10.123Z', updatedAt: '2026-01-15T03:22:10.123Z',
      answeredAt: '2026-02-01T10:00:00.000Z',
    };
    const csvRows = buildPrayerCsvRows([scoped], []);
    expect(csvRows).toHaveLength(1);
    expect(csvRows[0]).toMatchObject({
      createdByGrades: '9', createdByGender: 'female',
      createdAt: '2026-01-15T03:22:10.123Z', answeredAt: '2026-02-01T10:00:00.000Z',
    });

    const parsed = parsePrayerRows([csvRowToFileRow(csvRows[0]!)]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.createdByGrades).toEqual([9]);
    expect(parsed[0]!.createdByGender).toBe('female');
    expect(parsed[0]!.createdAt).toBe('2026-01-15T03:22:10.123Z');
    expect(parsed[0]!.answeredAt).toBe('2026-02-01T10:00:00.000Z');

    const plan = planPrayerImport(parsed, [], []);
    expect(plan.toAdd).toHaveLength(1);
    expect(plan.toAdd[0]!.createdByGrades).toEqual([9]);
    expect(plan.toAdd[0]!.createdByGender).toBe('female');
    expect(plan.toAdd[0]!.createdAt).toBe('2026-01-15T03:22:10.123Z');
    expect(plan.toAdd[0]!.answeredAt).toBe('2026-02-01T10:00:00.000Z');
  });

  it('H1/M3: a CSV without the fidelity columns leaves them undefined (old-CSV / hand-made-file fallback)', () => {
    const parsed = parsePrayerRows([
      { 'first name': '', 'last name': '', prayer: 'pray for the group', status: 'open' },
    ]);
    expect(parsed[0]!.createdByGrades).toBeUndefined();
    expect(parsed[0]!.createdByGender).toBeUndefined();
    expect(parsed[0]!.createdAt).toBeUndefined();
    expect(parsed[0]!.answeredAt).toBeUndefined();

    const plan = planPrayerImport(parsed, [], []);
    expect(plan.toAdd[0]!.createdByGrades).toBeUndefined();
    expect(plan.toAdd[0]!.createdByGender).toBeUndefined();
    expect(plan.toAdd[0]!.createdAt).toBeUndefined();
    expect(plan.toAdd[0]!.answeredAt).toBeUndefined();
  });

  // L3 (2026-07-19): a blank-text row used to be dropped before rowsInFile
  // was even computed, undercounting the report with no way for an admin to
  // tell rows were skipped.
  it('L3: blank-text rows are counted in rowsInFile/skippedBlank, not silently dropped', () => {
    const parsed = parsePrayerRows([
      { 'first name': 'Ava', 'last name': 'Smith', prayer: '', status: 'open' },
      { 'first name': 'Ava', 'last name': 'Smith', prayer: '   ', status: 'open' },
      { 'first name': 'Ava', 'last name': 'Smith', prayer: 'exams', status: 'open' },
    ]);
    expect(parsed).toHaveLength(3); // blank-text rows stay in the parsed output now
    const plan = planPrayerImport(parsed, [student('s1', 'Ava', 9, 'female')], []);
    expect(plan.report.rowsInFile).toBe(3);
    expect(plan.report.skippedBlank).toBe(2);
    expect(plan.report.added).toBe(1);
    // Totals reconcile.
    const { report } = plan;
    expect(report.added + report.skippedDuplicates + report.skippedBlank + report.unmatched.length + report.ambiguous.length)
      .toBe(report.rowsInFile);
  });
});
