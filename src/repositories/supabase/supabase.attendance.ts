import type { SqlClient } from './client';
import type {
  IServiceSessionRepository,
  IServiceAttendanceRepository,
  ILifegroupRepository,
  ILifegroupWeekRepository,
  ILifegroupAttendanceRepository,
  IImportRepository,
} from '../interfaces/entity-repositories';
import type {
  ServiceSession,
  ServiceAttendance,
  Lifegroup,
  LifegroupWeek,
  LifegroupAttendance,
  ImportRecord,
} from '../../core/entities/attendance';
import { chunk } from './bulk';

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

// Tolerant date coercion. The pg driver normally returns Date objects, but a
// null/undefined column (or a string, depending on driver/casts) must not crash
// the whole findAll() — one bad row would 500 the endpoint. `dateOnly` returns
// YYYY-MM-DD, `dateIso` a full ISO timestamp; both fall back safely.
function dateOnly(v: unknown): string {
  if (v instanceof Date) return v.toISOString().split('T')[0]!;
  if (typeof v === 'string' && v.length >= 10) return v.slice(0, 10);
  return '';
}
function dateIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v) return v;
  return new Date(0).toISOString();
}

function toServiceSession(row: Record<string, unknown>): ServiceSession {
  return {
    id: row['id'] as string,
    importId: row['import_id'] as string,
    sessionDate: dateOnly(row['session_date']),
    sessionName: row['session_name'] as string,
    isRegular: row['is_regular'] as boolean,
    isValid: row['is_valid'] as boolean,
    totalAttendance: row['total_attendance'] as number,
    sortOrder: row['sort_order'] as number,
    createdAt: dateIso(row['created_at']),
  };
}

function toServiceAttendance(row: Record<string, unknown>): ServiceAttendance {
  return {
    studentId: row['student_id'] as string,
    sessionId: row['session_id'] as string,
    attended: row['attended'] as boolean,
  };
}

function toLifegroup(row: Record<string, unknown>): Lifegroup {
  return {
    id: row['id'] as string,
    fullName: row['full_name'] as string,
    shortName: row['short_name'] as string,
    grade: (row['grade'] as number | null) ?? null,
    gender: (row['gender'] as string | null) ?? null,
    createdAt: dateIso(row['created_at']),
  };
}

function toLifegroupWeek(row: Record<string, unknown>): LifegroupWeek {
  return {
    id: row['id'] as string,
    importId: row['import_id'] as string,
    weekNum: row['week_num'] as number,
    weekKey: row['week_key'] as string,
    weekStart: dateOnly(row['week_start']),
    weekEnd: row['week_end'] != null ? dateOnly(row['week_end']) : null,
  };
}

function toLifegroupAttendance(row: Record<string, unknown>): LifegroupAttendance {
  return {
    studentId: row['student_id'] as string,
    weekId: row['week_id'] as string,
    lifegroupId: row['lifegroup_id'] as string,
    groupMet: row['group_met'] as boolean,
    attended: row['attended'] as boolean,
  };
}

function toImportRecord(row: Record<string, unknown>): ImportRecord {
  return {
    id: row['id'] as string,
    type: row['type'] as 'service' | 'lifegroup',
    filename: row['filename'] as string,
    fileHash: row['file_hash'] as string,
    rowCount: row['row_count'] as number,
    sessionsAdded: row['sessions_added'] as number,
    studentsAdded: row['students_added'] as number,
    studentsUpdated: row['students_updated'] as number,
    status: row['status'] as 'ok' | 'error',
    errorMessage: (row['error_message'] as string | null) ?? null,
    importedAt: dateIso(row['imported_at']),
    importedBy: row['imported_by'] as string,
  };
}

// ---------------------------------------------------------------------------
// SupabaseServiceSessionRepository
// ---------------------------------------------------------------------------

export class SupabaseServiceSessionRepository implements IServiceSessionRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<ServiceSession[]> {
    const rows = await this.sql`select * from service_sessions order by sort_order`;
    return rows.map(toServiceSession);
  }

  async findById(id: string): Promise<ServiceSession | null> {
    const rows = await this.sql`select * from service_sessions where id = ${id}`;
    return rows[0] ? toServiceSession(rows[0]) : null;
  }

  async findByImport(importId: string): Promise<ServiceSession[]> {
    const rows =
      await this.sql`select * from service_sessions where import_id = ${importId} order by sort_order`;
    return rows.map(toServiceSession);
  }

  async findValid(): Promise<ServiceSession[]> {
    const rows =
      await this.sql`select * from service_sessions where is_valid = true and is_regular = true order by sort_order`;
    return rows.map(toServiceSession);
  }

  async save(session: ServiceSession): Promise<ServiceSession> {
    const rows = await this.sql`
      insert into service_sessions (id, import_id, session_date, session_name, is_regular, is_valid, total_attendance, sort_order, created_at)
      values (
        ${session.id},
        ${session.importId},
        ${session.sessionDate},
        ${session.sessionName},
        ${session.isRegular},
        ${session.isValid},
        ${session.totalAttendance},
        ${session.sortOrder},
        ${session.createdAt}
      )
      on conflict (id) do update set
        import_id        = excluded.import_id,
        session_date     = excluded.session_date,
        session_name     = excluded.session_name,
        is_regular       = excluded.is_regular,
        is_valid         = excluded.is_valid,
        total_attendance = excluded.total_attendance,
        sort_order       = excluded.sort_order
      returning *
    `;
    return toServiceSession(rows[0]!);
  }

  async saveMany(sessions: ServiceSession[]): Promise<void> {
    if (sessions.length === 0) return;
    for (const batch of chunk(sessions)) {
    await this.sql`
      insert into service_sessions ${this.sql(
        batch.map((s) => ({
          id:               s.id,
          import_id:        s.importId,
          session_date:     s.sessionDate,
          session_name:     s.sessionName,
          is_regular:       s.isRegular,
          is_valid:         s.isValid,
          total_attendance: s.totalAttendance,
          sort_order:       s.sortOrder,
          created_at:       s.createdAt,
        })),
      )}
      on conflict (id) do update set
        import_id        = excluded.import_id,
        session_date     = excluded.session_date,
        session_name     = excluded.session_name,
        is_regular       = excluded.is_regular,
        is_valid         = excluded.is_valid,
        total_attendance = excluded.total_attendance,
        sort_order       = excluded.sort_order
    `;
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from service_sessions where id = ${id} returning id`;
    return rows.length > 0;
  }

  async deleteAll(): Promise<void> {
    await this.sql`truncate table service_sessions cascade`;
  }
}

// ---------------------------------------------------------------------------
// SupabaseServiceAttendanceRepository
// ---------------------------------------------------------------------------

export class SupabaseServiceAttendanceRepository implements IServiceAttendanceRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<ServiceAttendance[]> {
    const rows = await this.sql`select * from service_attendance`;
    return rows.map(toServiceAttendance);
  }

  async findByStudent(studentId: string): Promise<ServiceAttendance[]> {
    const rows =
      await this.sql`select * from service_attendance where student_id = ${studentId}`;
    return rows.map(toServiceAttendance);
  }

  async findBySession(sessionId: string): Promise<ServiceAttendance[]> {
    const rows =
      await this.sql`select * from service_attendance where session_id = ${sessionId}`;
    return rows.map(toServiceAttendance);
  }

  async save(record: ServiceAttendance): Promise<ServiceAttendance> {
    const rows = await this.sql`
      insert into service_attendance (student_id, session_id, attended)
      values (${record.studentId}, ${record.sessionId}, ${record.attended})
      on conflict (student_id, session_id) do update set
        attended = excluded.attended
      returning *
    `;
    return toServiceAttendance(rows[0]!);
  }

  async saveMany(records: ServiceAttendance[]): Promise<void> {
    if (records.length === 0) return;
    for (const batch of chunk(records)) {
      await this.sql`
        insert into service_attendance ${this.sql(
          batch.map((r) => ({
            student_id: r.studentId,
            session_id: r.sessionId,
            attended: r.attended,
          })),
        )}
        on conflict (student_id, session_id) do update set
          attended = excluded.attended
      `;
    }
  }

  async deleteByImport(importId: string): Promise<void> {
    await this.sql`
      delete from service_attendance
      where session_id in (
        select id from service_sessions where import_id = ${importId}
      )
    `;
  }

  async deleteAll(): Promise<void> {
    await this.sql`truncate table service_attendance cascade`;
  }
}

// ---------------------------------------------------------------------------
// SupabaseLifegroupRepository
// ---------------------------------------------------------------------------

export class SupabaseLifegroupRepository implements ILifegroupRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<Lifegroup[]> {
    const rows = await this.sql`select * from lifegroups order by full_name`;
    return rows.map(toLifegroup);
  }

  async findById(id: string): Promise<Lifegroup | null> {
    const rows = await this.sql`select * from lifegroups where id = ${id}`;
    return rows[0] ? toLifegroup(rows[0]) : null;
  }

  async save(lifegroup: Lifegroup): Promise<Lifegroup> {
    const rows = await this.sql`
      insert into lifegroups (id, full_name, short_name, grade, gender, created_at)
      values (
        ${lifegroup.id},
        ${lifegroup.fullName},
        ${lifegroup.shortName},
        ${lifegroup.grade ?? null},
        ${lifegroup.gender ?? null},
        ${lifegroup.createdAt}
      )
      on conflict (id) do update set
        full_name  = excluded.full_name,
        short_name = excluded.short_name,
        grade      = excluded.grade,
        gender     = excluded.gender
      returning *
    `;
    return toLifegroup(rows[0]!);
  }

  async saveMany(lifegroups: Lifegroup[]): Promise<void> {
    if (lifegroups.length === 0) return;
    for (const batch of chunk(lifegroups)) {
    await this.sql`
      insert into lifegroups ${this.sql(
        batch.map((g) => ({
          id:         g.id,
          full_name:  g.fullName,
          short_name: g.shortName,
          grade:      g.grade ?? null,
          gender:     g.gender ?? null,
          created_at: g.createdAt,
        })),
      )}
      on conflict (id) do update set
        full_name  = excluded.full_name,
        short_name = excluded.short_name,
        grade      = excluded.grade,
        gender     = excluded.gender
    `;
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from lifegroups where id = ${id} returning id`;
    return rows.length > 0;
  }

  async deleteAll(): Promise<void> {
    await this.sql`truncate table lifegroups cascade`;
  }
}

// ---------------------------------------------------------------------------
// SupabaseLifegroupWeekRepository
// ---------------------------------------------------------------------------

export class SupabaseLifegroupWeekRepository implements ILifegroupWeekRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<LifegroupWeek[]> {
    const rows = await this.sql`select * from lifegroup_weeks order by week_num`;
    return rows.map(toLifegroupWeek);
  }

  async findById(id: string): Promise<LifegroupWeek | null> {
    const rows = await this.sql`select * from lifegroup_weeks where id = ${id}`;
    return rows[0] ? toLifegroupWeek(rows[0]) : null;
  }

  async findByImport(importId: string): Promise<LifegroupWeek[]> {
    const rows =
      await this.sql`select * from lifegroup_weeks where import_id = ${importId} order by week_num`;
    return rows.map(toLifegroupWeek);
  }

  async save(week: LifegroupWeek): Promise<LifegroupWeek> {
    const rows = await this.sql`
      insert into lifegroup_weeks (id, import_id, week_num, week_key, week_start, week_end)
      values (
        ${week.id},
        ${week.importId},
        ${week.weekNum},
        ${week.weekKey},
        ${week.weekStart},
        ${week.weekEnd ?? null}
      )
      on conflict (id) do update set
        import_id  = excluded.import_id,
        week_num   = excluded.week_num,
        week_key   = excluded.week_key,
        week_start = excluded.week_start,
        week_end   = excluded.week_end
      returning *
    `;
    return toLifegroupWeek(rows[0]!);
  }

  async saveMany(weeks: LifegroupWeek[]): Promise<void> {
    if (weeks.length === 0) return;
    for (const batch of chunk(weeks)) {
    await this.sql`
      insert into lifegroup_weeks ${this.sql(
        batch.map((w) => ({
          id:        w.id,
          import_id: w.importId,
          week_num:  w.weekNum,
          week_key:  w.weekKey,
          week_start: w.weekStart,
          week_end:  w.weekEnd ?? null,
        })),
      )}
      on conflict (id) do update set
        import_id  = excluded.import_id,
        week_num   = excluded.week_num,
        week_key   = excluded.week_key,
        week_start = excluded.week_start,
        week_end   = excluded.week_end
    `;
    }
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from lifegroup_weeks where id = ${id} returning id`;
    return rows.length > 0;
  }

  async deleteAll(): Promise<void> {
    await this.sql`truncate table lifegroup_weeks cascade`;
  }
}

// ---------------------------------------------------------------------------
// SupabaseLifegroupAttendanceRepository
// ---------------------------------------------------------------------------

export class SupabaseLifegroupAttendanceRepository implements ILifegroupAttendanceRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<LifegroupAttendance[]> {
    const rows = await this.sql`select * from lifegroup_attendance`;
    return rows.map(toLifegroupAttendance);
  }

  async findByStudent(studentId: string): Promise<LifegroupAttendance[]> {
    const rows =
      await this.sql`select * from lifegroup_attendance where student_id = ${studentId}`;
    return rows.map(toLifegroupAttendance);
  }

  async findByWeek(weekId: string): Promise<LifegroupAttendance[]> {
    const rows =
      await this.sql`select * from lifegroup_attendance where week_id = ${weekId}`;
    return rows.map(toLifegroupAttendance);
  }

  async saveMany(records: LifegroupAttendance[]): Promise<void> {
    if (records.length === 0) return;
    for (const batch of chunk(records)) {
      await this.sql`
        insert into lifegroup_attendance ${this.sql(
          batch.map((r) => ({
            student_id:   r.studentId,
            week_id:      r.weekId,
            lifegroup_id: r.lifegroupId,
            group_met:    r.groupMet,
            attended:     r.attended,
          })),
        )}
        on conflict (student_id, week_id) do update set
          lifegroup_id = excluded.lifegroup_id,
          group_met    = excluded.group_met,
          attended     = excluded.attended
      `;
    }
  }

  async deleteByImport(importId: string): Promise<void> {
    await this.sql`
      delete from lifegroup_attendance
      where week_id in (
        select id from lifegroup_weeks where import_id = ${importId}
      )
    `;
  }

  async deleteAll(): Promise<void> {
    await this.sql`truncate table lifegroup_attendance cascade`;
  }
}

// ---------------------------------------------------------------------------
// SupabaseImportRepository
// ---------------------------------------------------------------------------

export class SupabaseImportRepository implements IImportRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<ImportRecord[]> {
    const rows =
      await this.sql`select * from import_records order by imported_at desc`;
    return rows.map(toImportRecord);
  }

  async findById(id: string): Promise<ImportRecord | null> {
    const rows = await this.sql`select * from import_records where id = ${id}`;
    return rows[0] ? toImportRecord(rows[0]) : null;
  }

  async findByType(type: 'service' | 'lifegroup'): Promise<ImportRecord[]> {
    const rows =
      await this.sql`select * from import_records where type = ${type} order by imported_at desc`;
    return rows.map(toImportRecord);
  }

  async save(record: ImportRecord): Promise<ImportRecord> {
    const rows = await this.sql`
      insert into import_records (
        id, type, filename, file_hash, row_count, sessions_added,
        students_added, students_updated, status, error_message,
        imported_at, imported_by
      )
      values (
        ${record.id},
        ${record.type},
        ${record.filename},
        ${record.fileHash},
        ${record.rowCount},
        ${record.sessionsAdded},
        ${record.studentsAdded},
        ${record.studentsUpdated},
        ${record.status},
        ${record.errorMessage ?? null},
        ${record.importedAt},
        ${record.importedBy}
      )
      on conflict (id) do update set
        type             = excluded.type,
        filename         = excluded.filename,
        file_hash        = excluded.file_hash,
        row_count        = excluded.row_count,
        sessions_added   = excluded.sessions_added,
        students_added   = excluded.students_added,
        students_updated = excluded.students_updated,
        status           = excluded.status,
        error_message    = excluded.error_message,
        imported_at      = excluded.imported_at,
        imported_by      = excluded.imported_by
      returning *
    `;
    return toImportRecord(rows[0]!);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from import_records where id = ${id} returning id`;
    return rows.length > 0;
  }

  async deleteAll(): Promise<void> {
    await this.sql`truncate table import_records cascade`;
  }
}
