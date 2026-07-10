import { describe, it, expect } from 'vitest';
import { saturdayOf, computeTerms, classifyDate } from '../services/terms';

// structure.serviceDayOfWeek (§5) generalises saturdayOf() from "the Saturday
// on/before" (a Friday service → Sat–Fri weeks) to "the start of the week that
// ends on the service day" for any service weekday. Default (5 = Friday) must be
// byte-identical to the old Sat–Fri bucketing.

const dow = (iso: string) => new Date(iso + 'T00:00:00Z').getUTCDay();

describe('saturdayOf(serviceDayOfWeek)', () => {
  it('default (Friday) buckets to the Saturday on/before — unchanged', () => {
    // A run of consecutive days; every one should map to the same Saturday-start.
    const week = ['2026-02-07', '2026-02-08', '2026-02-09', '2026-02-10', '2026-02-11', '2026-02-12', '2026-02-13'];
    // 2026-02-07 is a Saturday.
    expect(dow('2026-02-07')).toBe(6);
    for (const d of week) {
      expect(saturdayOf(d)).toBe('2026-02-07');       // default arg
      expect(saturdayOf(d, 5)).toBe('2026-02-07');    // explicit Friday
    }
    // The next Saturday starts a new bucket.
    expect(saturdayOf('2026-02-14')).toBe('2026-02-14');
  });

  it('a service-day date is the LAST day of its own week bucket', () => {
    // Friday service: the Friday buckets to the Saturday 6 days earlier.
    expect(saturdayOf('2026-02-13', 5)).toBe('2026-02-07');
    // Wednesday service: the Wednesday buckets to the Thursday 6 days earlier.
    expect(dow('2026-02-11')).toBe(3); // Wednesday
    expect(saturdayOf('2026-02-11', 3)).toBe('2026-02-05');
    expect(dow('2026-02-05')).toBe(4); // Thursday = week start for a Wed service
  });

  it('every service day yields a 7-long, non-overlapping bucketing', () => {
    for (let sd = 0; sd <= 6; sd++) {
      const weekStartDay = (sd + 1) % 7;
      // Take 14 consecutive days and confirm they fall into exactly 2 buckets,
      // each bucket starting on weekStartDay and covering 7 distinct days.
      const buckets = new Map<string, string[]>();
      for (let i = 0; i < 14; i++) {
        const d = new Date(Date.UTC(2026, 4, 3 + i)).toISOString().slice(0, 10);
        const b = saturdayOf(d, sd);
        expect(dow(b)).toBe(weekStartDay);   // bucket starts on the right weekday
        expect(b <= d).toBe(true);           // bucket is on/before the date
        (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(d);
      }
      for (const days of buckets.values()) expect(days.length).toBeLessThanOrEqual(7);
    }
  });

  it('computeTerms produces correct boundaries for a Wednesday-service ministry', () => {
    // Wednesday services, Term 1 (Feb) + ~5wk gap + Term 2 (Apr, current).
    const wednesdays = [
      '2026-02-04', '2026-02-11', '2026-02-18', '2026-02-25', // term 1
      '2026-04-15', '2026-04-22', '2026-04-29',               // term 2 (current)
    ];
    expect(wednesdays.every((d) => dow(d) === 3)).toBe(true);
    const buckets = wednesdays.map((d) => saturdayOf(d, 3));
    const terms = computeTerms(buckets, 14);
    // Boundaries land on the Thursday week-starts, split across the holiday gap.
    expect(terms.current).toEqual({ startDate: '2026-04-09', endDate: '2026-04-23' });
    expect(terms.previous).toEqual({ startDate: '2026-01-29', endDate: '2026-02-19' });
    // A mid-gap Wednesday classifies to neither term.
    expect(classifyDate(saturdayOf('2026-03-18', 3), terms)).toBeNull();
    // A current-term Wednesday classifies to current.
    expect(classifyDate(saturdayOf('2026-04-22', 3), terms)).toBe('current');
  });
});
