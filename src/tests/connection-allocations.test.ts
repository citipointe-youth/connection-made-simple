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
