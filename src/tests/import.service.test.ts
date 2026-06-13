import { describe, it, expect, beforeEach } from 'vitest';
import { makeImportService } from '../services/import.service';
import {
  InMemoryStudentRepository,
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
  };
}

async function initRepos(r: ReturnType<typeof makeRepos>) {
  await Promise.all([
    r.students.init(), r.sessions.init(), r.attendance.init(),
    r.imports.init(), r.settings.init(),
    r.lifegroups.init(), r.lifegroupWeeks.init(), r.lifegroupAttendance.init(),
  ]);
  // Tiny test datasets: treat any session with >=1 attendee as a valid service
  // (production default is 100). Individual tests can override.
  await r.settings.updateSettings({ serviceMinAttendance: 1 });
}

// ── TC55 — Outlier detection: sessions < 50% of average are flagged ──
describe('Import Service', () => {
  it('TC55: validThresholdPct defaults to 25 (holiday cutoff vs median week)', async () => {
    const r = makeRepos();
    await initRepos(r);
    const settings = await r.settings.getSettings();
    expect(settings.validThresholdPct).toBe(25);
  });

  // ── TC56 — ISO date columns are imported correctly ──
  it('TC56: ISO date columns are recognised and sessions created', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    const rows = [
      { first_name: 'Alice', last_name: 'Smith', gender: 'female', grade: 9,
        '2025-02-07': true, '2025-02-14': false },
    ];
    const result = await svc.importServiceCsv(ADMIN, rows, 'test.csv');
    expect(result.sessionsAdded).toBe(2);
    expect(result.studentsAdded).toBe(1);
    const students = await r.students.findAll();
    // Valid services = sessions with >=floor attendance. 2025-02-07 has 1 attendee
    // (valid); 2025-02-14 has 0 (Alice absent -> not a valid service). So svcTotal
    // counts the 1 valid service, which Alice attended.
    expect(students[0]?.svcAttended).toBe(1);
    expect(students[0]?.svcTotal).toBe(1);
  });

  // ── TC57 — Excel short-date columns (DD-MMM) are normalised to ISO ──
  it('TC57: Excel short-date columns are normalised and imported', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    const rows = [
      { first_name: 'Bob', last_name: 'Jones', gender: 'male', grade: 10,
        '7-Feb': true, '14-Feb': true, '21-Feb': false },
    ];
    const result = await svc.importServiceCsv(ADMIN, rows, 'export.csv');
    expect(result.sessionsAdded).toBe(3);
    const sessions = await r.sessions.findAll();
    // All session dates should be full ISO strings
    for (const s of sessions) {
      expect(s.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const students = await r.students.findAll();
    // Bob attends 7-Feb + 14-Feb (valid); 21-Feb has 0 attendees (not a valid service).
    expect(students[0]?.svcAttended).toBe(2);
    expect(students[0]?.svcTotal).toBe(2);
  });

  // ── TC58 — Excel short-date with explicit 2-digit year suffix ──
  it('TC58: Excel short-date with year suffix (7-Feb-25) is normalised', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    const rows = [
      { first_name: 'Carol', last_name: 'White', gender: 'female', grade: 8,
        '7-Feb-25': true, '14-Feb-25': false },
    ];
    const result = await svc.importServiceCsv(ADMIN, rows, 'export.csv');
    expect(result.sessionsAdded).toBe(2);
    const sessions = await r.sessions.findAll();
    expect(sessions.some(s => s.sessionDate === '2025-02-07')).toBe(true);
    expect(sessions.some(s => s.sessionDate === '2025-02-14')).toBe(true);
  });

  // ── TC59 — birthday column persisted ──
  it('TC59: date_of_birth column is saved to student', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    const rows = [
      { first_name: 'Dana', last_name: 'Lee', gender: 'female', grade: 11,
        date_of_birth: '2007-06-15', '2025-02-07': true },
    ];
    await svc.importServiceCsv(ADMIN, rows, 'test.csv');
    const students = await r.students.findAll();
    expect(students[0]?.dateOfBirth).toBe('2007-06-15');
  });

  // ── TC60 — birthday alias column persisted ──
  it('TC60: birthday alias column is saved to student', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    const rows = [
      { first_name: 'Eve', last_name: 'Brown', gender: 'female', grade: 7,
        birthday: '2011-03-22', '2025-02-07': false },
    ];
    await svc.importServiceCsv(ADMIN, rows, 'test.csv');
    const students = await r.students.findAll();
    expect(students[0]?.dateOfBirth).toBe('2011-03-22');
  });

  // ── TC61 — parent_phone column persisted ──
  it('TC61: parent_phone column is saved to student', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    const rows = [
      { first_name: 'Frank', last_name: 'Clark', gender: 'male', grade: 9,
        parent_phone: '0412345678', '2025-02-07': true },
    ];
    await svc.importServiceCsv(ADMIN, rows, 'test.csv');
    const students = await r.students.findAll();
    expect(students[0]?.parentPhone).toBe('0412345678');
  });

  // ── TC62 — guardian_phone alias persisted ──
  it('TC62: guardian_phone alias is saved to student', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    const rows = [
      { first_name: 'Grace', last_name: 'Hall', gender: 'female', grade: 12,
        guardian_phone: '0487654321', '2025-02-07': false },
    ];
    await svc.importServiceCsv(ADMIN, rows, 'test.csv');
    const students = await r.students.findAll();
    expect(students[0]?.parentPhone).toBe('0487654321');
  });

  // ── TC63 — re-import updates dateOfBirth on existing student ──
  it('TC63: re-importing a known student updates their dateOfBirth', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    // First import — no birthday
    await svc.importServiceCsv(ADMIN, [
      { first_name: 'Harry', last_name: 'Potter', gender: 'male', grade: 8, '2025-02-07': true },
    ], 'first.csv');
    const before = await r.students.findAll();
    expect(before[0]?.dateOfBirth).toBeNull();
    // Second import — birthday provided
    await svc.importServiceCsv(ADMIN, [
      { first_name: 'Harry', last_name: 'Potter', gender: 'male', grade: 8,
        birthday: '2010-07-31', '2025-02-14': true },
    ], 'second.csv');
    const after = await r.students.findAll();
    expect(after[0]?.dateOfBirth).toBe('2010-07-31');
    // Each service import is authoritative (a full-year export), so svc counts
    // reflect the latest import's valid services rather than accumulating.
    expect(after[0]?.svcTotal).toBe(1);
    expect(after[0]?.svcAttended).toBe(1);
  });

  // ── TC64 — rows without optional columns don't fail ──
  it('TC64: import with no optional columns succeeds without errors', async () => {
    const r = makeRepos();
    await initRepos(r);
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    const rows = [
      { first_name: 'Ivy', last_name: 'Green', gender: 'female', grade: 7, '2025-03-07': true },
      { first_name: 'Jack', last_name: 'Blue', gender: 'male', grade: 7, '2025-03-07': false },
    ];
    const result = await svc.importServiceCsv(ADMIN, rows, 'minimal.csv');
    expect(result.studentsAdded).toBe(2);
    const students = await r.students.findAll();
    expect(students.every(s => s.dateOfBirth === null)).toBe(true);
    expect(students.every(s => s.parentPhone === null)).toBe(true);
  });

  // ── TC65 — Sub-floor sessions are excluded from the trends average ──
  it('TC65: trends service excludes sub-floor sessions from averageAttendance', async () => {
    const r = makeRepos();
    await initRepos(r);
    // Floor of 5: the 1-attendee session is below it (invalid); the 12-attendee
    // sessions are valid.
    await r.settings.updateSettings({ serviceMinAttendance: 5 });
    // Import 5 sessions: 4 with 12 attending, 1 sub-floor with 1 attending
    const svc = makeImportService(r.students, r.sessions, r.attendance, r.imports, r.settings, r.lifegroups, r.lifegroupWeeks, r.lifegroupAttendance);
    // Create 12 students first
    const names = ['A','B','C','D','E','F','G','H','I','J','K','L'];
    const baseRows = names.map(n => ({
      first_name: n, last_name: 'Test', gender: 'male', grade: 9,
      '2025-02-07': true, '2025-02-14': true, '2025-02-21': true, '2025-02-28': true,
      '2025-03-07': false, // outlier: only 0 attended this week
    }));
    // Override the outlier session for most — only 1 attends the outlier session
    baseRows[0]!['2025-03-07'] = true; // only 1/12 attends outlier = ~8% of avg (12 -> outlier)
    await svc.importServiceCsv(ADMIN, baseRows, 'test.csv');

    const { makeTrendsService } = await import('../services/trends.service');
    const trendsSvc = makeTrendsService(r.students, r.sessions, r.attendance, r.settings);
    const actor: Actor = { id: 'u-admin', role: 'admin', displayName: 'Admin', grade: null, quad: null };
    const data = await trendsSvc.get(actor);

    // The outlier session (2025-03-07, 1 attendee) should be flagged
    const outlierSession = data.ministry.sessions.find(s => s.sessionDate === '2025-03-07');
    expect(outlierSession?.isOutlier).toBe(true);

    // Average should be computed only from non-outlier sessions (all 12 attending = 12)
    expect(data.ministry.averageAttendance).toBe(12);
  });
});
