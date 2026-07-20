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
  date: string; // createdAt ISO date (YYYY-MM-DD) — human-readable, write-only
  // Full-fidelity round-trip columns (H1/M3, 2026-07-19): a general prayer's
  // creator scope and the prayer's real timestamps. Written on every export;
  // read back on import ONLY when the column is present in the file — see
  // parsePrayerRows/planPrayerImport. A CSV exported before these columns
  // existed (or a hand-made one) falls back to today's behaviour: the
  // importer's own creator scope, now() timestamps.
  createdByGrades: string; // comma-joined grade numbers, or '' for "no boundary"
  createdByGender: string; // 'male' | 'female' | ''
  createdAt: string; // full-precision ISO timestamp (not date-sliced)
  answeredAt: string; // full-precision ISO timestamp, or ''
}

export interface ParsedPrayerRow {
  rowNum: number;
  firstName: string;
  lastName: string;
  text: string;
  status: PrayerStatus;
  answerNote: string;
  addedBy: string;
  // undefined = this column was absent from the file entirely (an old export,
  // or a hand-made CSV) — planPrayerImport falls back to the importer's own
  // creator scope / now() for these. `null` is itself a meaningful, PRESENT
  // value (no creator-scope boundary; no answered date) and must be
  // round-tripped as-is, not treated the same as "absent".
  createdByGrades?: number[] | null;
  createdByGender?: 'male' | 'female' | null;
  createdAt?: string | null;
  answeredAt?: string | null;
}

export interface PrayerToAdd {
  studentId: string | null;
  text: string;
  status: PrayerStatus;
  answerNote: string | null;
  createdByLabel: string;
  createdByGrades?: number[] | null;
  createdByGender?: 'male' | 'female' | null;
  createdAt?: string | null;
  answeredAt?: string | null;
}

export interface PrayerImportReport {
  rowsInFile: number;
  added: number;
  skippedDuplicates: number;
  // Rows with no prayer text — not importable. Previously discarded before
  // rowsInFile was even computed, silently undercounting the report (L3,
  // 2026-07-19); now surfaced so added + skippedDuplicates + skippedBlank +
  // unmatched.length + ambiguous.length reconciles to rowsInFile.
  skippedBlank: number;
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

// Like pick(), but also reports whether the column was present at all — needed
// to tell "file has this column but it's blank" (a real, present value) apart
// from "file predates this column" (fall back to default behaviour instead).
function pickPresent(row: Record<string, unknown>, candidates: string[]): { present: boolean; value: string } {
  for (const key of Object.keys(row)) {
    if (candidates.includes(key.toLowerCase().trim())) {
      const v = row[key];
      return { present: true, value: v == null ? '' : String(v).trim() };
    }
  }
  return { present: false, value: '' };
}

function normStatus(s: string): PrayerStatus {
  const v = s.toLowerCase().trim();
  if (v === 'answered' || v === 'ans') return 'answered';
  if (v === 'archived' || v === 'archive') return 'archived';
  return 'open';
}

function serializeGrades(grades: number[] | null): string {
  return grades && grades.length ? grades.join(',') : '';
}

function parseGrades(raw: string): number[] | null {
  if (!raw.trim()) return null;
  const nums = raw.split(/[,|]/).map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
  return nums.length ? nums : null;
}

function parseGender(raw: string): 'male' | 'female' | null {
  const v = raw.toLowerCase().trim();
  return v === 'male' || v === 'female' ? v : null;
}

export function buildPrayerCsvRows(prayers: PrayerRequest[], students: Student[]): PrayerCsvRow[] {
  const byId = new Map(students.map((s) => [s.id, s]));
  const rows: PrayerCsvRow[] = [];
  for (const p of prayers) {
    // H1/M3: written for every prayer (cheap, and harmless for a student-linked
    // one where it's ignored on reimport — the student match already carries
    // the scope) so a general prayer's creator scope + real timestamps survive
    // an export -> reimport round trip instead of silently widening to
    // ministry-wide and resetting to "now" (the New Year Refresh flow).
    const fidelity = {
      createdByGrades: serializeGrades(p.createdByGrades),
      createdByGender: p.createdByGender ?? '',
      createdAt: p.createdAt || '',
      answeredAt: p.answeredAt || '',
    };
    if (p.studentId == null) {
      // General/whole-group prayer — no student to name-match on re-import;
      // blank name fields round-trip back to a general prayer (see planPrayerImport).
      rows.push({
        firstName: '', lastName: '', grade: null, gender: '',
        prayer: p.text, status: p.status, answerNote: p.answerNote ?? '',
        addedBy: p.createdByLabel, date: (p.createdAt || '').slice(0, 10),
        ...fidelity,
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
      ...fidelity,
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
    // A blank-text row is not importable — but (L3, 2026-07-19) it now still
    // gets pushed here (instead of `return`ing before it's ever counted) so
    // planPrayerImport can report it via `skippedBlank` rather than silently
    // vanishing from the row count.

    const gradesCol = pickPresent(row, ['created by grades', 'createdbygrades', 'creator grades']);
    const genderCol = pickPresent(row, ['created by gender', 'createdbygender', 'creator gender']);
    const createdAtCol = pickPresent(row, ['created at', 'createdat', 'created_at']);
    const answeredAtCol = pickPresent(row, ['answered at', 'answeredat', 'answered_at']);

    out.push({
      rowNum: i + 1,
      firstName, lastName, text,
      status: normStatus(pick(row, ['status'])),
      answerNote: pick(row, ['answer note', 'answer', 'praise']),
      addedBy: pick(row, ['added by', 'added_by', 'leader', 'by']),
      createdByGrades: gradesCol.present ? parseGrades(gradesCol.value) : undefined,
      createdByGender: genderCol.present ? parseGender(genderCol.value) : undefined,
      createdAt: createdAtCol.present ? (createdAtCol.value || null) : undefined,
      answeredAt: answeredAtCol.present ? (answeredAtCol.value || null) : undefined,
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
  const report: PrayerImportReport = {
    rowsInFile: parsed.length, added: 0, skippedDuplicates: 0, skippedBlank: 0, unmatched: [], ambiguous: [],
  };
  const toAdd: PrayerToAdd[] = [];
  for (const r of parsed) {
    if (!r.text) { report.skippedBlank++; continue; } // L3 — surfaced, not silently dropped
    // No name at all -> a general/whole-group prayer (round-trips from
    // buildPrayerCsvRows' blank-name export), not an unmatched student.
    if (!r.firstName && !r.lastName) {
      const key = `null ${r.text.toLowerCase().trim()}`;
      if (existingKeys.has(key)) { report.skippedDuplicates++; continue; }
      existingKeys.add(key);
      toAdd.push({
        studentId: null, text: r.text, status: r.status, answerNote: r.answerNote || null, createdByLabel: r.addedBy,
        createdByGrades: r.createdByGrades, createdByGender: r.createdByGender,
        createdAt: r.createdAt, answeredAt: r.answeredAt,
      });
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
    toAdd.push({
      studentId, text: r.text, status: r.status, answerNote: r.answerNote || null, createdByLabel: r.addedBy,
      createdByGrades: r.createdByGrades, createdByGender: r.createdByGender,
      createdAt: r.createdAt, answeredAt: r.answeredAt,
    });
    report.added++;
  }
  return { toAdd, report };
}
