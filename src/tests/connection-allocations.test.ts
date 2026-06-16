import { describe, it, expect } from 'vitest';
import { can } from '../services/access-control';
import type { Actor } from '../core/entities/user';
import { parseAllocationRows } from '../services/connection-allocations';

function actor(role: string): Actor {
  return { id: 'a', role: role as any, displayName: 'T', grade: null as any, quad: null as any };
}

describe('connection:import capability', () => {
  it('is granted to admin only', () => {
    expect(can(actor('admin'), 'connection:import')).toBe(true);
    expect(can(actor('director'), 'connection:import')).toBe(false);
    expect(can(actor('quad'), 'connection:import')).toBe(false);
    expect(can(actor('grade'), 'connection:import')).toBe(false);
  });
});

describe('parseAllocationRows', () => {
  it('reads First Name / Last Name / Leader columns and ignores grade+gender', () => {
    const rows = [
      { 'first name': 'John', 'last name': 'Smith', grade: '9', gender: 'male', leader: 'Jane Doe' },
      { 'first name': 'John', 'last name': 'Smith', grade: '9', gender: 'male', leader: 'Bob Lee' },
    ];
    const out = parseAllocationRows(rows);
    expect(out).toEqual([
      { rowNum: 1, firstName: 'John', lastName: 'Smith', leaderName: 'Jane Doe' },
      { rowNum: 2, firstName: 'John', lastName: 'Smith', leaderName: 'Bob Lee' },
    ]);
  });

  it('works with no grade/gender columns present', () => {
    const out = parseAllocationRows([{ 'first name': 'Amy', 'last name': 'Ng', leader: 'Sue Park' }]);
    expect(out).toEqual([{ rowNum: 1, firstName: 'Amy', lastName: 'Ng', leaderName: 'Sue Park' }]);
  });

  it('falls back to a single Student/Name column split on first space', () => {
    const out = parseAllocationRows([{ student: 'Mary Jane Watson', leader: 'Sue Park' }]);
    expect(out).toEqual([{ rowNum: 1, firstName: 'Mary', lastName: 'Jane Watson', leaderName: 'Sue Park' }]);
  });

  it('keeps blank-leader rows but drops rows with no name', () => {
    const out = parseAllocationRows([
      { 'first name': 'Tim', 'last name': 'Allen', leader: '' },
      { 'first name': '', 'last name': '', leader: '' },
    ]);
    expect(out).toEqual([{ rowNum: 1, firstName: 'Tim', lastName: 'Allen', leaderName: '' }]);
  });
});

import { planAllocationSync } from '../services/connection-allocations';

const STUDENTS = [
  { id: 's1', firstName: 'John', lastName: 'Smith' },
  { id: 's2', firstName: 'Mary', lastName: 'Jones' },
  { id: 's3', firstName: 'John', lastName: 'Smith' }, // duplicate name -> ambiguous
];
const LEADERS = [
  { id: 'l1', fullName: 'Jane Doe' },
  { id: 'l2', fullName: 'Bob Lee' },
  { id: 'l3', fullName: 'Bob Lee' }, // duplicate name -> ambiguous
];

function row(rowNum: number, firstName: string, lastName: string, leaderName: string) {
  return { rowNum, firstName, lastName, leaderName };
}

describe('planAllocationSync', () => {
  it('adds a missing pair and removes a pair not listed (per-student sync)', () => {
    const parsed = [row(1, 'Mary', 'Jones', 'Jane Doe')];
    const existing = [{ studentId: 's2', leaderId: 'l2' }]; // Mary -> Bob Lee
    const plan = planAllocationSync(parsed, STUDENTS, LEADERS, existing);
    expect(plan.toAdd).toEqual([{ studentId: 's2', leaderId: 'l1' }]);
    expect(plan.toRemove).toEqual([{ studentId: 's2', leaderId: 'l2' }]);
    expect(plan.report.connectionsAdded).toBe(1);
    expect(plan.report.connectionsRemoved).toBe(1);
    expect(plan.report.studentsInFile).toBe(1);
  });

  it('round-trip is a no-op when the file matches the DB', () => {
    const parsed = [row(1, 'Mary', 'Jones', 'Jane Doe')];
    const existing = [{ studentId: 's2', leaderId: 'l1' }];
    const plan = planAllocationSync(parsed, STUDENTS, LEADERS, existing);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.toRemove).toHaveLength(0);
    expect(plan.report.connectionsUnchanged).toBe(1);
  });

  it('leaves students absent from the file untouched', () => {
    const parsed = [row(1, 'Mary', 'Jones', 'Jane Doe')]; // only Mary (s2) is in the file
    const existing = [
      { studentId: 's2', leaderId: 'l1' }, // Mary -> Jane Doe (matches desired; unchanged)
      { studentId: 's1', leaderId: 'l2' }, // John Smith (s1) is NOT in the file -> must be untouched
    ];
    const plan = planAllocationSync(parsed, STUDENTS, LEADERS, existing);
    expect(plan.toRemove).toHaveLength(0);       // s1's connection is never removed
    expect(plan.toAdd).toHaveLength(0);          // Mary already connected to Jane Doe
    expect(plan.report.studentsInFile).toBe(1);  // only Mary is in the file
  });

  it('typo-safety: an unmatched leader skips that student’s removals but keeps adds', () => {
    const parsed = [row(1, 'Mary', 'Jones', 'Jane Doe'), row(2, 'Mary', 'Jones', 'Jane Doh')];
    const existing = [{ studentId: 's2', leaderId: 'l2' }]; // Mary -> Bob Lee (would be removed if no typo)
    const plan = planAllocationSync(parsed, STUDENTS, LEADERS, existing);
    expect(plan.toAdd).toEqual([{ studentId: 's2', leaderId: 'l1' }]); // Jane Doe still added
    expect(plan.toRemove).toHaveLength(0); // removals skipped
    expect(plan.report.unmatchedLeaders).toEqual([{ row: 2, name: 'Jane Doh', student: 'Mary Jones' }]);
    expect(plan.report.studentsWithSkippedRemovals).toEqual(['Mary Jones']);
  });

  it('reports unmatched students with row numbers', () => {
    const parsed = [row(1, 'Nobody', 'Here', 'Jane Doe')];
    const plan = planAllocationSync(parsed, STUDENTS, LEADERS, []);
    expect(plan.report.unmatchedStudents).toEqual([{ row: 1, name: 'Nobody Here' }]);
    expect(plan.report.studentsInFile).toBe(0);
  });

  it('reports ambiguous student and leader names', () => {
    const parsedStudent = [row(1, 'John', 'Smith', 'Jane Doe')];
    const ps = planAllocationSync(parsedStudent, STUDENTS, LEADERS, []);
    expect(ps.report.ambiguousStudents).toEqual([{ row: 1, name: 'John Smith' }]);

    const parsedLeader = [row(1, 'Mary', 'Jones', 'Bob Lee')];
    const pl = planAllocationSync(parsedLeader, STUDENTS, LEADERS, []);
    expect(pl.report.ambiguousLeaders).toEqual([{ row: 1, name: 'Bob Lee' }]);
    expect(pl.report.studentsWithSkippedRemovals).toEqual(['Mary Jones']);
  });

  it('blank-leader-only row clears a connected student', () => {
    const parsed = [row(1, 'Mary', 'Jones', '')];
    const existing = [{ studentId: 's2', leaderId: 'l1' }];
    const plan = planAllocationSync(parsed, STUDENTS, LEADERS, existing);
    expect(plan.toRemove).toEqual([{ studentId: 's2', leaderId: 'l1' }]);
    expect(plan.report.connectionsRemoved).toBe(1);
  });
});

import { buildAllocationExportRows } from '../services/connection-allocations';

describe('buildAllocationExportRows', () => {
  const students = [
    { id: 's1', firstName: 'Zoe', lastName: 'Ash', grade: 9, gender: 'female' },
    { id: 's2', firstName: 'Amy', lastName: 'Bell', grade: 9, gender: 'female' },
    { id: 's3', firstName: 'Tom', lastName: 'Cole', grade: 7, gender: 'male' },
    { id: 's4', firstName: 'No', lastName: 'Grade', grade: null, gender: 'other' },
  ];
  const leaders = [{ id: 'l1', fullName: 'Bob Lee' }, { id: 'l2', fullName: 'Jane Doe' }];

  it('emits one row per pair, a blank-leader row for unconnected students, sorted gender>grade>name>leader', () => {
    const conns = [
      { studentId: 's1', leaderId: 'l2' }, // Zoe Ash -> Jane Doe
      { studentId: 's1', leaderId: 'l1' }, // Zoe Ash -> Bob Lee
      { studentId: 's3', leaderId: 'l1' }, // Tom Cole -> Bob Lee
      // s2 Amy Bell unconnected; s4 No Grade unconnected
    ];
    const rows = buildAllocationExportRows(students, leaders, conns);
    expect(rows).toEqual([
      // female first; grade 9 ascending; by last name Ash before Bell; Zoe's leaders sorted Bob<Jane
      { firstName: 'Zoe', lastName: 'Ash', grade: 9, gender: 'female', leader: 'Bob Lee' },
      { firstName: 'Zoe', lastName: 'Ash', grade: 9, gender: 'female', leader: 'Jane Doe' },
      { firstName: 'Amy', lastName: 'Bell', grade: 9, gender: 'female', leader: '' },
      // male next; grade 7
      { firstName: 'Tom', lastName: 'Cole', grade: 7, gender: 'male', leader: 'Bob Lee' },
      // other gender + null grade sorts last
      { firstName: 'No', lastName: 'Grade', grade: null, gender: 'other', leader: '' },
    ]);
  });
});

import { makeConnectionService } from '../services/connection.service';
import { makeStudentService } from '../services/student.service';
import { makeLeaderService } from '../services/leader.service';
import {
  InMemoryStudentRepository,
  InMemoryLeaderRepository,
  InMemoryConnectionRepository,
  InMemorySettingsRepository,
} from '../repositories/in-memory';
import { ForbiddenError } from '../core/errors/app-error';

const ADMIN: Actor = { id: 'admin', role: 'admin' as any, displayName: 'Admin', grade: null as any, quad: null as any };
const DIRECTOR: Actor = { id: 'dir', role: 'director' as any, displayName: 'Dir', grade: null as any, quad: null as any };

async function buildAllocSvc() {
  const studentRepo = new InMemoryStudentRepository();
  const leaderRepo = new InMemoryLeaderRepository();
  const connRepo = new InMemoryConnectionRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await studentRepo.init(); await leaderRepo.init(); await connRepo.init(); await settingsRepo.init();
  const studentSvc = makeStudentService(studentRepo);
  const leaderSvc = makeLeaderService(leaderRepo);
  const connSvc = makeConnectionService(connRepo, studentRepo, leaderRepo, settingsRepo);
  const alice = await studentSvc.create(ADMIN, { firstName: 'Alice', lastName: 'Smith', gender: 'female', grade: 9 });
  const emma = await leaderSvc.create(ADMIN, { fullName: 'Emma Leader', gender: 'female', grades: [9] });
  return { connSvc, alice, emma };
}

describe('ConnectionService allocations', () => {
  it('exportAllocations emits a blank-leader row for an unconnected student', async () => {
    const { connSvc, alice } = await buildAllocSvc();
    const rows = await connSvc.exportAllocations(ADMIN);
    expect(rows).toEqual([{ firstName: 'Alice', lastName: 'Smith', grade: 9, gender: 'female', leader: '' }]);
    void alice;
  });

  it('importAllocations adds a matched connection and round-trips to a no-op', async () => {
    const { connSvc } = await buildAllocSvc();
    const r1 = await connSvc.importAllocations(ADMIN, [
      { 'first name': 'Alice', 'last name': 'Smith', leader: 'Emma Leader' },
    ]);
    expect(r1.connectionsAdded).toBe(1);
    const rows = await connSvc.exportAllocations(ADMIN);
    expect(rows).toEqual([{ firstName: 'Alice', lastName: 'Smith', grade: 9, gender: 'female', leader: 'Emma Leader' }]);
    // Re-import the same data -> no changes.
    const r2 = await connSvc.importAllocations(ADMIN, [
      { 'first name': 'Alice', 'last name': 'Smith', leader: 'Emma Leader' },
    ]);
    expect(r2.connectionsAdded).toBe(0);
    expect(r2.connectionsRemoved).toBe(0);
    expect(r2.connectionsUnchanged).toBe(1);
  });

  it('rejects non-admin callers', async () => {
    const { connSvc } = await buildAllocSvc();
    await expect(connSvc.exportAllocations(DIRECTOR)).rejects.toThrow(ForbiddenError);
    await expect(connSvc.importAllocations(DIRECTOR, [])).rejects.toThrow(ForbiddenError);
  });
});
