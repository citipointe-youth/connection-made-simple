import { describe, it, expect } from 'vitest';
import { computeStudentAggregates, emptyStudentAggregate } from '../services/aggregates';

// Two terms split by a holiday gap. Valid sessions drive the term boundaries.
const sessions = [
  { id: 's1', date: '2026-02-06', valid: true },  // previous term
  { id: 's2', date: '2026-02-13', valid: true },  // previous term
  { id: 's3', date: '2026-02-20', valid: true },  // previous term
  { id: 's4', date: '2026-04-17', valid: true },  // current term
  { id: 's5', date: '2026-04-24', valid: true },  // current term
  { id: 's6', date: '2026-05-01', valid: false }, // current term but sub-floor → ignored
];

describe('computeStudentAggregates — service', () => {
  it('splits svc attendance into current and previous term over valid sessions only', () => {
    const r = computeStudentAggregates({
      termGapDays: 14,
      serviceSessions: sessions,
      serviceAttendance: [
        // Alice: prev 3/3, current 2/2 (s6 ignored: invalid)
        { studentId: 'a', sessionId: 's1', attended: true },
        { studentId: 'a', sessionId: 's2', attended: true },
        { studentId: 'a', sessionId: 's3', attended: true },
        { studentId: 'a', sessionId: 's4', attended: true },
        { studentId: 'a', sessionId: 's5', attended: true },
        { studentId: 'a', sessionId: 's6', attended: true },
        // Bob: prev 1/3, current 0/2
        { studentId: 'b', sessionId: 's1', attended: true },
        { studentId: 'b', sessionId: 's4', attended: false },
      ],
      weekStartById: new Map(),
      lifegroupAttendance: [],
    });

    expect(r.svcTotal).toBe(2);      // s4, s5
    expect(r.prevSvcTotal).toBe(3);  // s1, s2, s3

    const a = r.byStudent.get('a')!;
    expect(a.svcAttended).toBe(2);
    expect(a.prevSvcAttended).toBe(3);

    const b = r.byStudent.get('b')!;
    expect(b.svcAttended).toBe(0);
    expect(b.prevSvcAttended).toBe(1);
  });
});

describe('computeStudentAggregates — lifegroup', () => {
  const weekStartById = new Map<string, string>([
    ['w-prev', '2026-02-07'],   // previous term (Sat of 2026-02-13 week)
    ['w-gap', '2026-03-14'],    // holiday gap → excluded
    ['w-cur1', '2026-04-11'],   // current term
    ['w-cur2', '2026-04-18'],   // current term
  ]);

  it('counts grp weeks per term and excludes holiday-gap weeks', () => {
    const r = computeStudentAggregates({
      termGapDays: 14,
      serviceSessions: sessions,
      serviceAttendance: [],
      weekStartById,
      lifegroupAttendance: [
        // Alice: prev attended 1/1; gap week (excluded); current 2/2
        { studentId: 'a', weekId: 'w-prev', attended: true },
        { studentId: 'a', weekId: 'w-gap', attended: true },
        { studentId: 'a', weekId: 'w-cur1', attended: true },
        { studentId: 'a', weekId: 'w-cur2', attended: true },
        // Bob: current ran 2 weeks, attended 1
        { studentId: 'b', weekId: 'w-cur1', attended: true },
        { studentId: 'b', weekId: 'w-cur2', attended: false },
      ],
    });

    const a = r.byStudent.get('a')!;
    expect(a.grpTotal).toBe(2);        // w-cur1, w-cur2 (gap excluded)
    expect(a.grpAttended).toBe(2);
    expect(a.grpMetWeeks).toBe(2);
    expect(a.prevGrpTotal).toBe(1);
    expect(a.prevGrpAttended).toBe(1);

    const b = r.byStudent.get('b')!;
    expect(b.grpTotal).toBe(2);
    expect(b.grpAttended).toBe(1);
    expect(b.prevGrpTotal).toBe(0);
  });

  it('falls back to lifegroup-week gaps for term boundaries when no valid service data', () => {
    // Clean two-term week set (no intermediate gap week that would create a 3rd term).
    const wk = new Map<string, string>([
      ['w-prev', '2026-02-07'],   // previous term (single week)
      ['w-cur1', '2026-04-11'],   // current term
      ['w-cur2', '2026-04-18'],   // current term
    ]);
    const r = computeStudentAggregates({
      termGapDays: 14,
      serviceSessions: [],          // no service data at all
      serviceAttendance: [],
      weekStartById: wk,
      lifegroupAttendance: [
        { studentId: 'a', weekId: 'w-prev', attended: true },
        { studentId: 'a', weekId: 'w-cur1', attended: true },
      ],
    });
    // Boundaries derived from week dates: w-prev is its own (previous) term,
    // w-cur1/w-cur2 the current term.
    expect(r.terms.current).not.toBeNull();
    expect(r.terms.previous).not.toBeNull();
    const a = r.byStudent.get('a')!;
    expect(a.grpAttended).toBe(1);
    expect(a.prevGrpAttended).toBe(1);
  });
});

describe('emptyStudentAggregate', () => {
  it('is all zeros', () => {
    expect(emptyStudentAggregate()).toEqual({
      svcAttended: 0, prevSvcAttended: 0,
      grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
      prevGrpAttended: 0, prevGrpTotal: 0,
    });
  });
});
