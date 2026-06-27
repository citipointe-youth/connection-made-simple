import { saturdayOf } from './terms';
import { computeAllTerms, type LabeledTerm } from './year-terms';
import type { AggregateInput } from './aggregates';

export interface YearStudentAggregate { svcAttended: number; grpAttended: number; grpTotal: number; }
export interface YearTermResult { key: string; svcTotal: number; byStudent: Map<string, YearStudentAggregate>; }
export interface YearAggregateResult { terms: LabeledTerm[]; perTerm: Map<string, YearTermResult>; }

export function computeYearAggregates(input: AggregateInput): YearAggregateResult {
  const { termGapDays, serviceSessions, serviceAttendance, weekStartById, lifegroupAttendance } = input;

  const validWeeks = serviceSessions.filter((s) => s.valid).map((s) => saturdayOf(s.date));
  const boundarySource = validWeeks.length > 0 ? validWeeks : [...weekStartById.values()];
  const terms = computeAllTerms(boundarySource, termGapDays);

  const termFor = (d: string): string | null => {
    for (const t of terms) if (d >= t.startDate && d <= t.endDate) return t.key;
    return null;
  };

  const perTerm = new Map<string, YearTermResult>();
  for (const t of terms) perTerm.set(t.key, { key: t.key, svcTotal: 0, byStudent: new Map() });

  const sessionTerm = new Map<string, string>();
  for (const s of serviceSessions) {
    if (!s.valid) continue;
    const k = termFor(saturdayOf(s.date));
    if (!k) continue;
    sessionTerm.set(s.id, k);
    perTerm.get(k)!.svcTotal++;
  }

  const ensure = (k: string, id: string): YearStudentAggregate => {
    const tr = perTerm.get(k)!;
    let a = tr.byStudent.get(id);
    if (!a) { a = { svcAttended: 0, grpAttended: 0, grpTotal: 0 }; tr.byStudent.set(id, a); }
    return a;
  };

  for (const rec of serviceAttendance) {
    if (!rec.attended) continue;
    const k = sessionTerm.get(rec.sessionId);
    if (!k) continue;
    ensure(k, rec.studentId).svcAttended++;
  }

  for (const rec of lifegroupAttendance) {
    const ws = weekStartById.get(rec.weekId);
    if (!ws) continue;
    const k = termFor(ws);
    if (!k) continue;
    const a = ensure(k, rec.studentId);
    a.grpTotal++;
    if (rec.attended) a.grpAttended++;
  }

  return { terms, perTerm };
}
