// Pure helpers for the admin prayer CSV import/export. No repo/I-O imports —
// unit-testable without a database. Consumed by prayer.service.ts. Mirrors the
// shape of connection-allocations.ts.
import type { PrayerRequest, PrayerStatus } from '../core/entities/prayer';
import type { Student } from '../core/entities/student';

export interface PrayerCsvRow {
  firstName: string;
  lastName: string;
  grade: number | null;
  gender: string;
  prayer: string;
  status: PrayerStatus;
  answerNote: string;
  addedBy: string;
  date: string; // createdAt ISO date (YYYY-MM-DD)
}

export interface ParsedPrayerRow {
  rowNum: number;
  firstName: string;
  lastName: string;
  text: string;
  status: PrayerStatus;
  answerNote: string;
  addedBy: string;
}

export interface PrayerToAdd {
  studentId: string | null;
  text: string;
  status: PrayerStatus;
  answerNote: string | null;
  createdByLabel: string;
}

export interface PrayerImportReport {
  rowsInFile: number;
  added: number;
  skippedDuplicates: number;
  unmatched: { row: number; name: string }[];
  ambiguous: { row: number; name: string }[];
}

export interface PrayerImportPlan {
  toAdd: PrayerToAdd[];
  report: PrayerImportReport;
}

function pick(row: Record<string, unknown>, candidates: string[]): string {
  for (const key of Object.keys(row)) {
    if (candidates.includes(key.toLowerCase().trim())) {
      const v = row[key];
      return v == null ? '' : String(v).trim();
    }
  }
  return '';
}

function normStatus(s: string): PrayerStatus {
  const v = s.toLowerCase().trim();
  if (v === 'answered' || v === 'ans') return 'answered';
  if (v === 'archived' || v === 'archive') return 'archived';
  return 'open';
}

export function buildPrayerCsvRows(prayers: PrayerRequest[], students: Student[]): PrayerCsvRow[] {
  const byId = new Map(students.map((s) => [s.id, s]));
  const rows: PrayerCsvRow[] = [];
  for (const p of prayers) {
    if (p.studentId == null) {
      // General/whole-group prayer — no student to name-match on re-import;
      // blank name fields round-trip back to a general prayer (see planPrayerImport).
      rows.push({
        firstName: '', lastName: '', grade: null, gender: '',
        prayer: p.text, status: p.status, answerNote: p.answerNote ?? '',
        addedBy: p.createdByLabel, date: (p.createdAt || '').slice(0, 10),
      });
      continue;
    }
    const s = byId.get(p.studentId);
    if (!s) continue; // orphan (student deleted) — nothing to name-match on re-import
    rows.push({
      firstName: s.firstName,
      lastName: s.lastName,
      grade: s.grade,
      gender: s.gender,
      prayer: p.text,
      status: p.status,
      answerNote: p.answerNote ?? '',
      addedBy: p.createdByLabel,
      date: (p.createdAt || '').slice(0, 10),
    });
  }
  return rows;
}

export function parsePrayerRows(rows: Record<string, unknown>[]): ParsedPrayerRow[] {
  const out: ParsedPrayerRow[] = [];
  rows.forEach((row, i) => {
    let firstName = pick(row, ['first name', 'first_name', 'firstname']);
    let lastName = pick(row, ['last name', 'last_name', 'lastname']);
    if (!firstName && !lastName) {
      const single = pick(row, ['student', 'name', 'student name', 'full name']);
      if (single) {
        const sp = single.split(/\s+/);
        firstName = sp[0] ?? '';
        lastName = sp.slice(1).join(' ');
      }
    }
    const text = pick(row, ['prayer', 'prayer request', 'request']);
    if (!text) return; // a row with no prayer text is not importable
    out.push({
      rowNum: i + 1,
      firstName, lastName, text,
      status: normStatus(pick(row, ['status'])),
      answerNote: pick(row, ['answer note', 'answer', 'praise']),
      addedBy: pick(row, ['added by', 'added_by', 'leader', 'by']),
    });
  });
  return out;
}

// Name-match each parsed row to exactly one student; add prayers that don't
// already exist for that student with the same (case-insensitive) text.
export function planPrayerImport(
  parsed: ParsedPrayerRow[],
  students: Student[],
  existing: PrayerRequest[],
): PrayerImportPlan {
  const norm = (f: string, l: string) => `${f} ${l}`.toLowerCase().trim();
  const byName = new Map<string, Student[]>();
  for (const s of students) {
    const k = norm(s.firstName, s.lastName);
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(s);
  }
  const existingKeys = new Set(existing.map((p) => `${p.studentId ?? 'null'} ${p.text.toLowerCase().trim()}`));
  const report: PrayerImportReport = { rowsInFile: parsed.length, added: 0, skippedDuplicates: 0, unmatched: [], ambiguous: [] };
  const toAdd: PrayerToAdd[] = [];
  for (const r of parsed) {
    // No name at all -> a general/whole-group prayer (round-trips from
    // buildPrayerCsvRows' blank-name export), not an unmatched student.
    if (!r.firstName && !r.lastName) {
      const key = `null ${r.text.toLowerCase().trim()}`;
      if (existingKeys.has(key)) { report.skippedDuplicates++; continue; }
      existingKeys.add(key);
      toAdd.push({ studentId: null, text: r.text, status: r.status, answerNote: r.answerNote || null, createdByLabel: r.addedBy });
      report.added++;
      continue;
    }
    const matches = byName.get(norm(r.firstName, r.lastName)) ?? [];
    const displayName = `${r.firstName} ${r.lastName}`.trim();
    if (matches.length === 0) { report.unmatched.push({ row: r.rowNum, name: displayName }); continue; }
    if (matches.length > 1) { report.ambiguous.push({ row: r.rowNum, name: displayName }); continue; }
    const studentId = matches[0]!.id;
    const key = `${studentId} ${r.text.toLowerCase().trim()}`;
    if (existingKeys.has(key)) { report.skippedDuplicates++; continue; }
    existingKeys.add(key); // guard against duplicate rows within the same file
    toAdd.push({ studentId, text: r.text, status: r.status, answerNote: r.answerNote || null, createdByLabel: r.addedBy });
    report.added++;
  }
  return { toAdd, report };
}
