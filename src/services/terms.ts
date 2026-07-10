// ── Term boundaries ──
// A "term" is a run of meeting dates. A term boundary is a gap between two
// consecutive (sorted) dates greater than `termGapDays` days. The most recent
// run is the CURRENT term; the run immediately before it is the PREVIOUS term.
// Only the last two terms are ever returned — older terms are disregarded.
//
// Service-date gaps are the authoritative source of these boundaries; the same
// boundaries are applied to lifegroup weeks (weeks falling in the gap — the
// holiday break — classify to neither term and are excluded). Date strings are
// ISO `YYYY-MM-DD`, so lexical comparison equals chronological comparison and
// the logic is resilient across the calendar-year boundary (e.g. last year's
// Term 4 as previous + this year's Term 1 as current).

export interface TermRange {
  startDate: string; // inclusive ISO date (YYYY-MM-DD)
  endDate: string;   // inclusive ISO date
}

export interface Terms {
  current: TermRange | null;
  previous: TermRange | null;
}

export type TermKey = 'current' | 'previous' | null;

const MS_PER_DAY = 86_400_000;

// Map any date to the start of its week (the day AFTER the service day). Term
// boundaries are computed on week-bucketed dates so that a service session and
// the lifegroup weeks around it classify into the same term even at a term's
// edges. The default service day is Friday (5) → weeks start Saturday, i.e. the
// original Sat–Fri buckets, byte-identical. A Wednesday (3) service → Thu–Wed
// weeks, etc. (structure.serviceDayOfWeek, §5 of the generalisation design). The
// name is kept for its many call sites; it no longer implies literal Saturday.
export function saturdayOf(isoDate: string, serviceDayOfWeek: number = 5): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return isoDate;
  const weekStartDay = (serviceDayOfWeek + 1) % 7;      // day the week begins on
  const offset = (d.getUTCDay() - weekStartDay + 7) % 7; // days since that week-start
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export function computeTerms(dates: string[], termGapDays: number): Terms {
  const uniq = [...new Set(dates.filter(Boolean))].sort();
  if (uniq.length === 0) return { current: null, previous: null };

  // Indices where a new term starts (gap to the previous date > termGapDays).
  const termStarts: number[] = [];
  for (let i = 1; i < uniq.length; i++) {
    const prev = Date.parse(uniq[i - 1]! + 'T00:00:00Z');
    const cur = Date.parse(uniq[i]! + 'T00:00:00Z');
    const gapDays = (cur - prev) / MS_PER_DAY;
    if (gapDays > termGapDays) termStarts.push(i);
  }

  if (termStarts.length === 0) {
    return { current: { startDate: uniq[0]!, endDate: uniq[uniq.length - 1]! }, previous: null };
  }

  const lastStart = termStarts[termStarts.length - 1]!;
  const current: TermRange = { startDate: uniq[lastStart]!, endDate: uniq[uniq.length - 1]! };
  const prevStart = termStarts.length >= 2 ? termStarts[termStarts.length - 2]! : 0;
  const previous: TermRange = { startDate: uniq[prevStart]!, endDate: uniq[lastStart - 1]! };
  return { current, previous };
}

export function inRange(date: string, range: TermRange | null): boolean {
  if (!range) return false;
  return date >= range.startDate && date <= range.endDate;
}

export function classifyDate(date: string, terms: Terms): TermKey {
  if (inRange(date, terms.current)) return 'current';
  if (inRange(date, terms.previous)) return 'previous';
  return null;
}
