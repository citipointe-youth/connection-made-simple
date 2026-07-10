import type { SqlClient } from './client';
import {
  SupabaseStudentRepository,
  SupabaseLeaderRepository,
  SupabaseServiceSessionRepository,
  SupabaseServiceAttendanceRepository,
  SupabaseLifegroupRepository,
  SupabaseLifegroupWeekRepository,
  SupabaseLifegroupAttendanceRepository,
  SupabaseImportRepository,
} from './index';

export interface ImportRepoSet {
  students: SupabaseStudentRepository;
  leaders: SupabaseLeaderRepository;
  sessions: SupabaseServiceSessionRepository;
  attendance: SupabaseServiceAttendanceRepository;
  lifegroups: SupabaseLifegroupRepository;
  lifegroupWeeks: SupabaseLifegroupWeekRepository;
  lifegroupAttendance: SupabaseLifegroupAttendanceRepository;
  imports: SupabaseImportRepository;
}

// Rebuilds the 8 repos the import service writes to, bound to a
// transaction-scoped `tx` client (from sql.begin(async tx => ...)) instead of
// the module-level shared one. Every Supabase repo class already takes its
// client via the constructor (see container.ts) — this just calls the same
// constructors again with `tx`, so the SAME query methods run inside the
// transaction instead of against the outer connection.
export function bindImportRepos(tx: SqlClient): ImportRepoSet {
  return {
    students: new SupabaseStudentRepository(tx),
    leaders: new SupabaseLeaderRepository(tx),
    sessions: new SupabaseServiceSessionRepository(tx),
    attendance: new SupabaseServiceAttendanceRepository(tx),
    lifegroups: new SupabaseLifegroupRepository(tx),
    lifegroupWeeks: new SupabaseLifegroupWeekRepository(tx),
    lifegroupAttendance: new SupabaseLifegroupAttendanceRepository(tx),
    imports: new SupabaseImportRepository(tx),
  };
}
