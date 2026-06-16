# Connection Allocation Import / Export — Design

**Date:** 2026-06-17
**Status:** Approved (pending written-spec review)
**Scope:** Connection Made Simple (`connection-made-simple`) — TS/Express backend + `public/index.html` SPA.

## Summary

Add an admin-only ability to **export** the current student↔leader connection allocations
to a CSV and **import** an edited CSV back. Export carries student grade and gender as
columns; import is agnostic to whether those columns are present and matches students and
leaders by name. Import is resilient: it applies every row it can and returns a report
listing the names it could not match.

This is a **dedicated allocation pair**, separate from the existing
`GET /connections/export` (which stays as the attendance/at-risk *analytics* export). No
database or schema change — connections are unchanged and all access goes through existing
repository interfaces, so it behaves identically under `memory` / `json` / `supabase`.

## Goals

- Admin can download a round-trippable CSV of all allocations.
- Admin can edit that CSV (in Excel/Sheets) and re-import it to add **and** remove allocations.
- Import matches by name and never silently loses data to a typo.
- Import clearly reports what it could not match.

## Non-goals

- Changing the existing analytics export (`GET /connections/export`).
- Importing/creating **students** or **leaders** — import only connects existing records and
  reports names it cannot find. (Leader/student creation remains the job of the CSV data
  imports in `import.service.ts`.)
- Non-admin access. Grade/quad/director logins do not get this feature.

## CSV format

**Header:** `First Name,Last Name,Grade,Gender,Leader`

- **One row per (student, leader) pair.** A student with several leaders produces several
  contiguous rows.
- **Unconnected students** are emitted as a single row with a **blank Leader** cell, so an
  admin can assign leaders offline and re-import.
- Values are CSV-quoted with `"` and `""` escaping (same convention as the existing export
  controller).

### Export sort order (resilient)

Sort by, in order:

1. **Gender** — `female` before `male`; any other/unknown gender sorts **last**.
2. **Grade** — ascending (7→12); `null` grade sorts **last**.
3. **Student name** — last name, then first name (case-insensitive).
4. **Leader** — leader full name (case-insensitive); the blank-leader row (if any) sorts
   first within the student.

If a student is missing gender and/or grade, the missing field sorts that student last
within the relevant group and the sort falls through to name → leader. Order degrades
gracefully when one or both of gender/grade is absent.

## Import — column detection (agnostic)

Headers are matched **case-insensitively and trimmed**. The importer requires only:

- A **student name source**, preferring `First Name` + `Last Name`. If those are absent but a
  single `Student` or `Name` column exists, the value is split on the **first whitespace**
  (first token = first name, remainder = last name).
- A **Leader** column (also accepts `Leaders`).

`Grade` and `Gender` columns are **ignored if present and tolerated if absent**. Any
unrecognised columns are ignored.

The SPA parses the file client-side (reusing the existing `parseCSV` / `readXlsx` helpers)
and POSTs an array of row objects, matching the existing `/import/csv` flow.

## Matching

Reuses the house name-matching pattern:

- **Students** keyed by `` `${firstName} ${lastName}`.toLowerCase() ``.
- **Leaders** keyed by `fullName.toLowerCase()` (across all leaders, active or not).

A name that maps to **more than one** record is treated as **ambiguous** (not matched) and
reported separately, so the importer never guesses.

## Sync algorithm

A **pure, I/O-free planner** does the decision-making; the service method does I/O around it.

```
planAllocationSync(parsedRows, students, leaders, existingConnections)
  -> { toAdd: Pair[], toRemove: Pair[], report: AllocationImportReport }
```

This keeps the tricky logic unit-testable without a database.

**Per-student sync** — for each student that appears in the file:

1. Compute the student's **desired leader set** = the matched leaders on that student's rows.
2. **Add** desired pairs not already connected.
3. **Remove** existing pairs for that student whose leader is not in the desired set.
4. **Typo-safety rule:** if any of that student's rows has an **unmatched or ambiguous**
   leader, **skip all removals for that student** (still apply the adds) and flag the student
   in `studentsWithSkippedRemovals`. A misspelling can therefore never silently delete a real
   connection.

**Students absent from the file are left completely untouched.**

**Blank-leader rows:** a student whose only row(s) have a blank Leader has an **empty desired
set**, so their connections are cleared — the explicit way to un-assign someone via the file.
Re-importing an unmodified export is a no-op for these (unconnected students have no existing
connections to remove). Note: deleting *all* of a student's rows means the student is absent
from the file and is therefore **not** cleared; to clear a student keep one blank-leader row.

## Report shape

```ts
interface AllocationImportReport {
  studentsInFile: number;
  connectionsAdded: number;
  connectionsRemoved: number;
  connectionsUnchanged: number;
  unmatchedStudents: { row: number; name: string }[];
  unmatchedLeaders: { row: number; name: string; student: string }[];
  ambiguousStudents: { row: number; name: string }[];
  ambiguousLeaders: { row: number; name: string }[];
  studentsWithSkippedRemovals: string[]; // had an unmatched/ambiguous leader; removals skipped
}
```

Row numbers are 1-based against the data rows (excluding the header) for easy spreadsheet
cross-reference.

## Backend changes

- **`src/services/access-control.ts`** — add a new action `connection:import` to the `Action`
  union and grant it to **admin only**. Gates both new endpoints.
- **`src/services/connection-allocations.ts`** (new) — the pure planner
  (`parseAllocationRows`, `planAllocationSync`) and shared types. No repository imports.
- **`src/services/connection.service.ts`** — add:
  - `exportAllocations(actor): Promise<AllocationExportRow[]>` (admin-only) — builds the
    grouped, sorted rows including blank-leader rows for unconnected students.
  - `importAllocations(actor, rows: unknown[]): Promise<AllocationImportReport>` (admin-only)
    — loads students/leaders/connections, calls `planAllocationSync`, applies `toAdd`
    (`connRepo.save`) and `toRemove` (`connRepo.deleteByStudentAndLeader`), returns the report.
- **`src/api/controllers/connection.controller.ts`** — add `exportAllocations` (serialises
  rows to a CSV string, returns `{ csv, rowCount }` like the existing export) and
  `importAllocations` (returns the report).
- **`src/api/http/router.ts`** — add routes:
  - `GET /connections/allocations/export`
  - `POST /connections/allocations/import`

Admin already bypasses `connectionLockDate` in `checkLock`, so import is not blocked by a
connection lock.

## Frontend changes (`public/index.html`)

- New **"Connection Allocations"** card on the Admin page with:
  - **Export allocations** — `API.get('/connections/allocations/export')` → Blob download
    `allocations.csv` (mirrors the existing `/connections/export` download at ~line 1839).
  - **Import allocations** — hidden file input → `parseCSV`/`readXlsx` →
    `API.post('/connections/allocations/import', { rows })` → **result modal**.
- **Result modal** shows the counts and expandable `.drop` sections (existing collapsible
  pattern) for unmatched students, unmatched leaders, ambiguous names, and
  students-with-skipped-removals.
- **Invalidate the client `Cache`** after a successful import (connections changed), the same
  as other write paths.

## Testing (vitest)

Unit tests on the pure planner + service tests:

- **Round-trip no-op:** export → import yields `connectionsAdded === 0 && connectionsRemoved === 0`.
- **Column-agnostic import:** succeeds with no `Grade`/`Gender` columns; succeeds with a single
  `Student` column split on first space.
- **Sync add + remove:** file adds a new leader and drops one; both reflected.
- **Typo-safety:** a student with one unmatched leader name still gets matched adds, has
  removals skipped, and appears in `studentsWithSkippedRemovals`.
- **Unmatched reporting:** unknown student and unknown leader names appear with correct 1-based
  row numbers; unmatched leader carries its student.
- **Ambiguous names:** a duplicated student/leader name is reported as ambiguous, not matched.
- **Blank-leader clear:** a connected student whose only row has a blank leader is cleared.
- **Admin-only:** a non-admin actor is rejected (`ForbiddenError`) for both endpoints.
- **Export sort + resilience:** rows ordered gender→grade→name→leader; a student with null
  grade/gender sorts last and does not throw.

## Open considerations

- Leader matching ignores the `active` flag (matches by name across all leaders). If desired,
  a future tweak could prefer active leaders on ambiguity.
- Very large files: at current scale (hundreds of students) the in-memory plan + per-pair
  repo writes are fine; no batching needed. If connection counts grow, `connRepo` could gain
  a bulk `saveMany`/`deleteMany`, but that is out of scope here.
