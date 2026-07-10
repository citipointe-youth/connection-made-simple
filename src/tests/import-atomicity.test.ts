import { describe, it, expect, vi } from 'vitest';
import { makeImportService } from '../services/import.service';
import {
  InMemoryStudentRepository,
  InMemoryServiceSessionRepository,
  InMemoryServiceAttendanceRepository,
  InMemoryImportRepository,
  InMemorySettingsRepository,
  InMemoryLifegroupRepository,
  InMemoryLifegroupWeekRepository,
  InMemoryLifegroupAttendanceRepository,
  InMemoryLeaderRepository,
} from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';

// bindImportRepos normally constructs real Supabase*Repository instances bound
// to a postgres.js transaction. Mocked here to instead hand back the SAME
// in-memory repos this test already built — letting us drive the exact
// `if (sql) { sql.begin(...) }` code path in import.service.ts without a real
// Postgres connection, while a fake `sql.begin` simulates the ROLLBACK a real
// transaction would perform if a write throws partway through.
vi.mock('../repositories/supabase/with-transaction', () => ({
  bindImportRepos: vi.fn(),
}));
import { bindImportRepos } from '../repositories/supabase/with-transaction';

function actor(): Actor {
  return { id: 'a-test', role: 'admin' as any, displayName: 'T', grade: null as any, quad: null as any };
}

// Shallow snapshot/restore of a repo's internal store — safe because repo
// methods always replace entries wholesale (clone-on-write), never mutate a
// stored object in place. Most in-memory repos key a Map by id
// (InMemoryBaseRepository); the attendance repos instead hold a plain array
// (no natural single-column id) — handle both shapes.
function snapshot(repo: { store: Map<string, unknown> | unknown[] }): Map<string, unknown> | unknown[] {
  return Array.isArray(repo.store) ? [...repo.store] : new Map(repo.store);
}
function restore(repo: { store: Map<string, unknown> | unknown[] }, snap: Map<string, unknown> | unknown[]) {
  if (Array.isArray(repo.store)) {
    repo.store.length = 0;
    repo.store.push(...(snap as unknown[]));
  } else {
    repo.store.clear();
    for (const [k, v] of snap as Map<string, unknown>) repo.store.set(k, v);
  }
}

async function buildHarness() {
  const students = new InMemoryStudentRepository();
  const sessions = new InMemoryServiceSessionRepository();
  const attendance = new InMemoryServiceAttendanceRepository();
  const imports = new InMemoryImportRepository();
  const settings = new InMemorySettingsRepository();
  const lifegroups = new InMemoryLifegroupRepository();
  const lifegroupWeeks = new InMemoryLifegroupWeekRepository();
  const lifegroupAttendance = new InMemoryLifegroupAttendanceRepository();
  const leaders = new InMemoryLeaderRepository();
  await Promise.all([
    students.init(), sessions.init(), attendance.init(), imports.init(), settings.init(),
    lifegroups.init(), lifegroupWeeks.init(), lifegroupAttendance.init(), leaders.init(),
  ]);
  await settings.updateSettings({ serviceMinAttendance: 1 });

  const repos = { students, sessions, attendance, imports, lifegroups, lifegroupWeeks, lifegroupAttendance, leaders };
  vi.mocked(bindImportRepos).mockReturnValue(repos as any);

  // Fake transactional sql client: begin() snapshots every repo this import
  // touches, runs the callback, and — on ANY throw — restores every snapshot
  // before re-throwing, exactly mirroring a real `ROLLBACK`.
  const fakeSql = {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snaps = Object.values(repos).map((r) => [r, snapshot(r as any)] as const);
      try {
        return await fn({});
      } catch (err) {
        for (const [r, snap] of snaps) restore(r as any, snap);
        throw err;
      }
    },
  };

  const service = makeImportService(
    students, sessions, attendance, imports, settings,
    lifegroups, lifegroupWeeks, lifegroupAttendance, leaders,
    fakeSql as any,
  );
  return { service, repos };
}

function serviceRow(overrides: Record<string, unknown> = {}) {
  return { first_name: 'Ava', last_name: 'Okafor', gender: 'female', grade: 9, '2026-02-06': 'Y', ...overrides };
}

describe('Import atomicity — kill mid-import leaves prior data intact', () => {
  it('service import: a throw during the write phase rolls back BOTH the truncate and the partial repopulate', async () => {
    const { service, repos } = await buildHarness();

    // Establish a baseline via a normal, successful import.
    const first = await service.importServiceCsv(actor(), [serviceRow()], 'first.csv');
    expect(first.studentsAdded).toBe(1);
    const baselineStudents = await repos.students.findAll();
    const baselineSessions = await repos.sessions.findAll();
    expect(baselineStudents).toHaveLength(1);
    expect(baselineSessions).toHaveLength(1);

    // Simulate a crash partway through the SECOND import's write phase — after
    // the truncate has already run, but before the repopulate finishes.
    const saveManySpy = vi.spyOn(repos.students, 'saveMany').mockRejectedValueOnce(new Error('simulated crash mid-import'));

    await expect(
      service.importServiceCsv(actor(), [serviceRow({ first_name: 'Ben', last_name: 'Lee', '2026-02-13': 'Y' })], 'second.csv'),
    ).rejects.toThrow('simulated crash mid-import');

    saveManySpy.mockRestore();

    // Prior data must be intact — not truncated, not partially replaced.
    const afterStudents = await repos.students.findAll();
    const afterSessions = await repos.sessions.findAll();
    const afterAttendance = await repos.attendance.findAll();
    expect(afterStudents).toHaveLength(1);
    expect(afterStudents[0]!.firstName).toBe('Ava');
    expect(afterSessions).toHaveLength(1);
    expect(afterAttendance.length).toBeGreaterThan(0);

    // And a subsequent, healthy import still works normally afterward. Student
    // rows are cumulative under replace semantics (absent students keep their
    // row, just with zeroed service counts) — Ava from the first import is
    // still there alongside the new student.
    const third = await service.importServiceCsv(actor(), [serviceRow({ first_name: 'Cara', last_name: 'Diaz' })], 'third.csv');
    expect(third.studentsAdded).toBe(1);
    const finalStudents = await repos.students.findAll();
    expect(finalStudents).toHaveLength(2);
    expect(finalStudents.map((s) => s.firstName).sort()).toEqual(['Ava', 'Cara']);
  });

  it('group import: a throw during the write phase rolls back the lifegroup truncate too', async () => {
    const { service, repos } = await buildHarness();

    const firstGroupPayload = {
      groups: [{
        name: 'Grade 9 Girls Lifegroup',
        meetings: ['2026-02-06'],
        members: [{ first_name: 'Ava', last_name: 'Okafor', attendance: [true] }],
      }],
    };
    const first = await service.importGroupCsv(actor(), firstGroupPayload, 'first-group.csv');
    expect(first.groupsAdded).toBe(1);
    const baselineLifegroups = await repos.lifegroups.findAll();
    expect(baselineLifegroups).toHaveLength(1);

    const spy = vi.spyOn(repos.lifegroupWeeks, 'saveMany').mockRejectedValueOnce(new Error('simulated crash mid-group-import'));

    const secondPayload = {
      groups: [{
        name: 'Grade 10 Boys Lifegroup',
        meetings: ['2026-02-13'],
        members: [{ first_name: 'Ben', last_name: 'Lee', attendance: [true] }],
      }],
    };
    await expect(service.importGroupCsv(actor(), secondPayload, 'second-group.csv')).rejects.toThrow('simulated crash mid-group-import');
    spy.mockRestore();

    const afterLifegroups = await repos.lifegroups.findAll();
    expect(afterLifegroups).toHaveLength(1);
    expect(afterLifegroups[0]!.fullName).toBe('Grade 9 Girls Lifegroup');
  });
});
