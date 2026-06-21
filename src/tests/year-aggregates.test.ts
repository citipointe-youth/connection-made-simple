import { describe, it, expect } from 'vitest';
import { computeYearAggregates } from '../services/year-aggregates';
import type { AggregateInput } from '../services/aggregates';

function input(): AggregateInput {
  return {
    termGapDays: 14,
    serviceSessions: [
      { id: 's1', date: '2026-02-06', valid: true },  // T1
      { id: 's2', date: '2026-02-13', valid: true },  // T1
      { id: 's3', date: '2026-04-24', valid: true },  // T2 (after a gap)
    ],
    serviceAttendance: [
      { studentId: 'a', sessionId: 's1', attended: true },
      { studentId: 'a', sessionId: 's3', attended: true },
      { studentId: 'b', sessionId: 's1', attended: true },
    ],
    weekStartById: new Map(),
    lifegroupAttendance: [],
  };
}

describe('computeYearAggregates', () => {
  it('buckets each session and attendance into its own term', () => {
    const r = computeYearAggregates(input());
    expect(r.terms.map((t) => t.key)).toEqual(['2026-T1', '2026-T2']);
    expect(r.perTerm.get('2026-T1')!.svcTotal).toBe(2);
    expect(r.perTerm.get('2026-T2')!.svcTotal).toBe(1);
    expect(r.perTerm.get('2026-T1')!.byStudent.get('a')!.svcAttended).toBe(1);
    expect(r.perTerm.get('2026-T2')!.byStudent.get('a')!.svcAttended).toBe(1);
    expect(r.perTerm.get('2026-T1')!.byStudent.get('b')!.svcAttended).toBe(1);
  });

  it('ignores invalid sessions', () => {
    const i = input();
    i.serviceSessions[0]!.valid = false; // s1 invalid
    const r = computeYearAggregates(i);
    expect(r.perTerm.get('2026-T1')!.svcTotal).toBe(1); // only s2 remains valid in T1
  });
});
