// Pure helpers for the admin connection-allocation import/export. No repository
// or I/O imports here — everything is a pure function so it can be unit-tested
// without a database. Consumed by connection.service.ts.

export interface AllocationExportRow {
  firstName: string;
  lastName: string;
  grade: number | null;
  gender: string;
  leader: string; // '' for an unconnected student's placeholder row
}

export interface ParsedAllocationRow {
  rowNum: number; // 1-based index against the data rows (header excluded)
  firstName: string;
  lastName: string;
  leaderName: string; // '' = blank-leader row
}

export interface AllocationPlanPair {
  studentId: string;
  leaderId: string;
}

export interface AllocationImportReport {
  studentsInFile: number;
  connectionsAdded: number;
  connectionsRemoved: number;
  connectionsUnchanged: number;
  unmatchedStudents: { row: number; name: string }[];
  unmatchedLeaders: { row: number; name: string; student: string }[];
  ambiguousStudents: { row: number; name: string }[];
  ambiguousLeaders: { row: number; name: string }[];
  studentsWithSkippedRemovals: string[];
}

export interface AllocationPlan {
  toAdd: AllocationPlanPair[];
  toRemove: AllocationPlanPair[];
  report: AllocationImportReport;
}

// Read the first present value among case-insensitive candidate header keys.
function pickField(row: Record<string, unknown>, candidates: string[]): string {
  for (const key of Object.keys(row)) {
    if (candidates.includes(key.toLowerCase().trim())) {
      const v = row[key];
      return v == null ? '' : String(v).trim();
    }
  }
  return '';
}

// Turn the SPA's row objects (keyed by lowercased CSV headers) into typed rows.
// Agnostic to whether grade/gender columns are present; requires a name source
// and tolerates a blank leader.
export function parseAllocationRows(rows: Record<string, unknown>[]): ParsedAllocationRow[] {
  const out: ParsedAllocationRow[] = [];
  rows.forEach((row, i) => {
    let firstName = pickField(row, ['first name', 'first_name', 'firstname']);
    let lastName = pickField(row, ['last name', 'last_name', 'lastname']);
    if (!firstName && !lastName) {
      const single = pickField(row, ['student', 'name', 'student name', 'full name']);
      if (single) {
        const sp = single.split(/\s+/);
        firstName = sp[0] ?? '';
        lastName = sp.slice(1).join(' ');
      }
    }
    const leaderName = pickField(row, ['leader', 'leaders']);
    if (!firstName && !lastName) return; // truly empty line — skip
    out.push({ rowNum: i + 1, firstName, lastName, leaderName });
  });
  return out;
}

type StudentLite = { id: string; firstName: string; lastName: string };
type LeaderLite = { id: string; fullName: string };
type ConnLite = { studentId: string; leaderId: string };

const nameKey = (a: string, b: string) => `${a} ${b}`.toLowerCase().trim();

export function planAllocationSync(
  parsed: ParsedAllocationRow[],
  students: StudentLite[],
  leaders: LeaderLite[],
  existing: ConnLite[],
): AllocationPlan {
  const report: AllocationImportReport = {
    studentsInFile: 0,
    connectionsAdded: 0,
    connectionsRemoved: 0,
    connectionsUnchanged: 0,
    unmatchedStudents: [],
    unmatchedLeaders: [],
    ambiguousStudents: [],
    ambiguousLeaders: [],
    studentsWithSkippedRemovals: [],
  };

  // Name -> records (length > 1 means ambiguous).
  const studentsByName = new Map<string, StudentLite[]>();
  for (const s of students) {
    const k = nameKey(s.firstName, s.lastName);
    (studentsByName.get(k) ?? studentsByName.set(k, []).get(k)!).push(s);
  }
  const leadersByName = new Map<string, LeaderLite[]>();
  for (const l of leaders) {
    const k = l.fullName.toLowerCase().trim();
    (leadersByName.get(k) ?? leadersByName.set(k, []).get(k)!).push(l);
  }

  // Per in-file student: desired leader ids + whether any of its rows had an
  // unmatched/ambiguous leader (which suppresses removals for that student).
  interface Entry { student: StudentLite; desired: Set<string>; blocked: boolean; display: string }
  const entries = new Map<string, Entry>();

  for (const r of parsed) {
    const display = `${r.firstName} ${r.lastName}`.trim();
    const sMatches = studentsByName.get(nameKey(r.firstName, r.lastName)) ?? [];
    if (sMatches.length === 0) { report.unmatchedStudents.push({ row: r.rowNum, name: display }); continue; }
    if (sMatches.length > 1) { report.ambiguousStudents.push({ row: r.rowNum, name: display }); continue; }
    const student = sMatches[0]!;

    let entry = entries.get(student.id);
    if (!entry) { entry = { student, desired: new Set(), blocked: false, display }; entries.set(student.id, entry); }

    if (!r.leaderName) continue; // blank-leader row: student is in-file with no leader to add

    const lMatches = leadersByName.get(r.leaderName.toLowerCase().trim()) ?? [];
    if (lMatches.length === 0) { report.unmatchedLeaders.push({ row: r.rowNum, name: r.leaderName, student: display }); entry.blocked = true; continue; }
    if (lMatches.length > 1) { report.ambiguousLeaders.push({ row: r.rowNum, name: r.leaderName }); entry.blocked = true; continue; }
    entry.desired.add(lMatches[0]!.id);
  }

  report.studentsInFile = entries.size;

  // Existing connections grouped by student.
  const existingByStudent = new Map<string, Set<string>>();
  for (const c of existing) {
    (existingByStudent.get(c.studentId) ?? existingByStudent.set(c.studentId, new Set()).get(c.studentId)!).add(c.leaderId);
  }

  const toAdd: AllocationPlanPair[] = [];
  const toRemove: AllocationPlanPair[] = [];

  for (const entry of entries.values()) {
    const existingSet = existingByStudent.get(entry.student.id) ?? new Set<string>();
    // Adds (matched desired pairs not already present).
    for (const leaderId of entry.desired) {
      if (existingSet.has(leaderId)) { report.connectionsUnchanged++; }
      else { toAdd.push({ studentId: entry.student.id, leaderId }); report.connectionsAdded++; }
    }
    // Removals — only when no unmatched/ambiguous leader appeared for this student.
    if (entry.blocked) {
      report.studentsWithSkippedRemovals.push(entry.display);
    } else {
      for (const leaderId of existingSet) {
        if (!entry.desired.has(leaderId)) { toRemove.push({ studentId: entry.student.id, leaderId }); report.connectionsRemoved++; }
      }
    }
  }

  return { toAdd, toRemove, report };
}

type StudentExportLite = { id: string; firstName: string; lastName: string; grade: number | null; gender: string };

function genderRank(g: string): number {
  const s = (g || '').toLowerCase();
  if (s === 'female') return 0;
  if (s === 'male') return 1;
  return 2; // other/unknown sorts last
}
const gradeRank = (g: number | null) => (g == null ? Number.MAX_SAFE_INTEGER : g);

export function buildAllocationExportRows(
  students: StudentExportLite[],
  leaders: LeaderLite[],
  connections: ConnLite[],
): AllocationExportRow[] {
  const leaderById = new Map(leaders.map((l) => [l.id, l.fullName]));
  const leaderNamesByStudent = new Map<string, string[]>();
  for (const c of connections) {
    const name = leaderById.get(c.leaderId);
    if (!name) continue; // orphaned connection — skip
    (leaderNamesByStudent.get(c.studentId) ?? leaderNamesByStudent.set(c.studentId, []).get(c.studentId)!).push(name);
  }

  const rows: AllocationExportRow[] = [];
  for (const s of students) {
    const base = { firstName: s.firstName, lastName: s.lastName, grade: s.grade, gender: s.gender };
    const names = leaderNamesByStudent.get(s.id) ?? [];
    if (names.length === 0) {
      rows.push({ ...base, leader: '' });
    } else {
      for (const leader of names) rows.push({ ...base, leader });
    }
  }

  rows.sort((a, b) =>
    genderRank(a.gender) - genderRank(b.gender) ||
    gradeRank(a.grade) - gradeRank(b.grade) ||
    a.lastName.toLowerCase().localeCompare(b.lastName.toLowerCase()) ||
    a.firstName.toLowerCase().localeCompare(b.firstName.toLowerCase()) ||
    a.leader.toLowerCase().localeCompare(b.leader.toLowerCase()), // '' sorts first within a student
  );
  return rows;
}
