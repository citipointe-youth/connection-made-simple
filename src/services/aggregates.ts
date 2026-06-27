import { computeTerms, classifyDate, saturdayOf, type Terms } from './terms';

// Per-student, term-scoped attendance aggregate. svcTotal/prevSvcTotal are NOT
// here because they are global (the same valid-session count for every student);
// they live on AggregateResult. Everything below is per-student.
export interface StudentTermAggregate {
  svcAttended: number;
  prevSvcAttended: number;
  grpAttended: number;
  grpTotal: number;     // weeks this student's group(s) ran in the current term
  grpMetWeeks: number;  // == grpTotal (kept for the existing field name)
  prevGrpAttended: number;
  prevGrpTotal: number;
}

export interface AggregateInput {
  termGapDays: number;
  serviceSessions: { id: string; date: string; valid: boolean }[];
  serviceAttendance: { studentId: string; sessionId: string; attended: boolean }[];
  weekStartById: Map<string, string>; // lifegroup weekId -> weekStart (ISO date)
  lifegroupAttendance: { studentId: string; weekId: string; attended: boolean }[];
}

export interface AggregateResult {
  terms: Terms;
  svcTotal: number;     // valid sessions in the current term (global denominator)
  prevSvcTotal: number; // valid sessions in the previous term
  byStudent: Map<string, StudentTermAggregate>;
}

export function emptyStudentAggregate(): StudentTermAggregate {
  return {
    svcAttended: 0, prevSvcAttended: 0,
    grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
    prevGrpAttended: 0, prevGrpTotal: 0,
  };
}

export function computeStudentAggregates(input: AggregateInput): AggregateResult {
  const { termGapDays, serviceSessions, serviceAttendance, weekStartById, lifegroupAttendance } = input;

  // Term boundaries: valid service dates are authoritative; fall back to
  // lifegroup-week dates when there is no service data yet. All dates are
  // bucketed to their Saturday so service (Friday) and lifegroup (Monday) weeks
  // share one week-aligned boundary.
  const validWeeks = serviceSessions.filter((s) => s.valid).map((s) => saturdayOf(s.date));
  const boundarySource = validWeeks.length > 0 ? validWeeks : [...weekStartById.values()];
  const terms = computeTerms(boundarySource, termGapDays);

  // Map each VALID session to its term ('current' | 'previous' | null). Invalid
  // (sub-floor / holiday / future-dated) sessions are dropped entirely.
  const sessionTerm = new Map<string, 'current' | 'previous'>();
  let svcTotal = 0;
  let prevSvcTotal = 0;
  for (const s of serviceSessions) {
    if (!s.valid) continue;
    const t = classifyDate(saturdayOf(s.date), terms);
    if (t === 'current') { sessionTerm.set(s.id, 'current'); svcTotal++; }
    else if (t === 'previous') { sessionTerm.set(s.id, 'previous'); prevSvcTotal++; }
  }

  const byStudent = new Map<string, StudentTermAggregate>();
  const ensure = (id: string): StudentTermAggregate => {
    let a = byStudent.get(id);
    if (!a) { a = emptyStudentAggregate(); byStudent.set(id, a); }
    return a;
  };

  for (const rec of serviceAttendance) {
    if (!rec.attended) continue;
    const t = sessionTerm.get(rec.sessionId);
    if (!t) continue;
    const a = ensure(rec.studentId);
    if (t === 'current') a.svcAttended++;
    else a.prevSvcAttended++;
  }

  for (const rec of lifegroupAttendance) {
    const weekStart = weekStartById.get(rec.weekId);
    if (!weekStart) continue;
    const t = classifyDate(weekStart, terms);
    if (!t) continue; // holiday-gap week → excluded from both terms
    const a = ensure(rec.studentId);
    if (t === 'current') {
      a.grpTotal++;
      a.grpMetWeeks = a.grpTotal;
      if (rec.attended) a.grpAttended++;
    } else {
      a.prevGrpTotal++;
      if (rec.attended) a.prevGrpAttended++;
    }
  }

  return { terms, svcTotal, prevSvcTotal, byStudent };
}
