import { describe, it, expect } from 'vitest';
import { computeAllTerms } from '../services/year-terms';

describe('computeAllTerms', () => {
  it('returns empty for no dates', () => {
    expect(computeAllTerms([], 14)).toEqual([]);
  });

  it('groups one continuous run as a single term', () => {
    const t = computeAllTerms(['2026-02-06', '2026-02-13', '2026-02-20'], 14);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ key: '2026-T1', label: 'Term 1 2026', year: 2026, ordinal: 1, startDate: '2026-02-06', endDate: '2026-02-20' });
  });

  it('splits on a gap greater than termGapDays and increments ordinal within the year', () => {
    // Two runs separated by ~5 weeks (a holiday break)
    const t = computeAllTerms(['2026-02-06', '2026-02-13', '2026-04-24', '2026-05-01'], 14);
    expect(t).toHaveLength(2);
    expect(t[0]!.key).toBe('2026-T1');
    expect(t[1]!.key).toBe('2026-T2');
    expect(t[1]!.startDate).toBe('2026-04-24');
  });

  it('resets ordinal per calendar year across a year boundary', () => {
    const t = computeAllTerms(['2025-10-31', '2025-11-07', '2026-02-06', '2026-02-13'], 14);
    expect(t.map((x) => x.key)).toEqual(['2025-T1', '2026-T1']);
  });
});
