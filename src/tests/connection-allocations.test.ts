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
