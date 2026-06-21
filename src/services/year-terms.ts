const MS_PER_DAY = 86_400_000;

export interface LabeledTerm {
  key: string;
  label: string;
  year: number;
  ordinal: number;
  startDate: string;
  endDate: string;
}

// All terms in chronological order. A term boundary is a gap > termGapDays
// between consecutive sorted dates (same rule as terms.ts), but every run is
// returned and labelled, not just the last two. Pass Monday-bucketed dates in
// for week-aligned boundaries (callers already do this).
export function computeAllTerms(dates: string[], termGapDays: number): LabeledTerm[] {
  const uniq = [...new Set(dates.filter(Boolean))].sort();
  if (uniq.length === 0) return [];

  const startIdxs: number[] = [0];
  for (let i = 1; i < uniq.length; i++) {
    const prev = Date.parse(uniq[i - 1]! + 'T00:00:00Z');
    const cur = Date.parse(uniq[i]! + 'T00:00:00Z');
    if ((cur - prev) / MS_PER_DAY > termGapDays) startIdxs.push(i);
  }

  const perYear = new Map<number, number>();
  return startIdxs.map((s, k) => {
    const e = (k + 1 < startIdxs.length ? startIdxs[k + 1]! : uniq.length) - 1;
    const startDate = uniq[s]!;
    const endDate = uniq[e]!;
    const year = Number(startDate.slice(0, 4));
    const ordinal = (perYear.get(year) ?? 0) + 1;
    perYear.set(year, ordinal);
    return { key: `${year}-T${ordinal}`, label: `Term ${ordinal} ${year}`, year, ordinal, startDate, endDate };
  });
}
