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
