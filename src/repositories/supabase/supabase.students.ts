import type { SqlClient } from './client';
import type { IStudentRepository } from '../interfaces/entity-repositories';
import type { Student } from '../../core/entities/student';
import type { Quad } from '../../core/types/enums';

function toStudent(row: Record<string, unknown>): Student {
  const dob = row['date_of_birth'];
  let dateOfBirth: string | null = null;
  if (dob instanceof Date) {
    dateOfBirth = dob.toISOString().split('T')[0]!;
  } else if (typeof dob === 'string') {
    dateOfBirth = dob;
  }

  return {
    id: row['id'] as string,
    firstName: row['first_name'] as string,
    lastName: row['last_name'] as string,
    gender: row['gender'] as Student['gender'],
    grade: (row['grade'] as number | null) ?? null,
    quad: (row['quad'] as Quad | null) ?? null,
    mobile: (row['mobile'] as string | null) ?? null,
    parentPhone: (row['parent_phone'] as string | null) ?? null,
    dateOfBirth,
    svcAttended: (row['svc_attended'] as number) ?? 0,
    svcTotal: (row['svc_total'] as number) ?? 0,
    grpAttended: (row['grp_attended'] as number) ?? 0,
    grpTotal: (row['grp_total'] as number) ?? 0,
    grpMetWeeks: (row['grp_met_weeks'] as number) ?? 0,
    prevSvcAttended: (row['prev_svc_attended'] as number) ?? 0,
    prevSvcTotal: (row['prev_svc_total'] as number) ?? 0,
    prevGrpAttended: (row['prev_grp_attended'] as number) ?? 0,
    prevGrpTotal: (row['prev_grp_total'] as number) ?? 0,
    atRiskStatus: (row['at_risk_status'] as Student['atRiskStatus']) ?? null,
    dataSource: (row['data_source'] as string | null) ?? null,
    createdAt: (row['created_at'] as Date).toISOString(),
    updatedAt: (row['updated_at'] as Date).toISOString(),
  };
}

export class SupabaseStudentRepository implements IStudentRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<Student[]> {
    const rows = await this.sql`select * from students order by last_name`;
    return rows.map(toStudent);
  }

  async findById(id: string): Promise<Student | null> {
    const rows = await this.sql`select * from students where id = ${id}`;
    return rows[0] ? toStudent(rows[0]) : null;
  }

  async findByGrade(grade: number): Promise<Student[]> {
    const rows = await this.sql`select * from students where grade = ${grade} order by last_name`;
    return rows.map(toStudent);
  }

  async findByGender(gender: string): Promise<Student[]> {
    const rows = await this.sql`select * from students where lower(gender) = lower(${gender}) order by last_name`;
    return rows.map(toStudent);
  }

  async search(query: string): Promise<Student[]> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    // Build a LIKE filter for each term against the full name
    let rows = await this.sql`select * from students order by last_name`;
    const results = rows
      .map(toStudent)
      .filter((s) => {
        const full = `${s.firstName} ${s.lastName}`.toLowerCase();
        return terms.every((t) => full.includes(t));
      })
      .slice(0, 50);
    return results;
  }

  async save(student: Student): Promise<Student> {
    const rows = await this.sql`
      insert into students (
        id, first_name, last_name, gender, grade, quad, mobile, parent_phone, date_of_birth,
        svc_attended, svc_total, grp_attended, grp_total, grp_met_weeks,
        prev_svc_attended, prev_svc_total, prev_grp_attended, prev_grp_total,
        at_risk_status, data_source, created_at, updated_at
      )
      values (
        ${student.id},
        ${student.firstName},
        ${student.lastName},
        ${student.gender},
        ${student.grade ?? null},
        ${student.quad ?? null},
        ${student.mobile ?? null},
        ${student.parentPhone ?? null},
        ${student.dateOfBirth ?? null},
        ${student.svcAttended},
        ${student.svcTotal},
        ${student.grpAttended},
        ${student.grpTotal},
        ${student.grpMetWeeks},
        ${student.prevSvcAttended},
        ${student.prevSvcTotal},
        ${student.prevGrpAttended},
        ${student.prevGrpTotal},
        ${student.atRiskStatus ?? null},
        ${student.dataSource ?? null},
        ${student.createdAt},
        ${student.updatedAt}
      )
      on conflict (id) do update set
        first_name        = excluded.first_name,
        last_name         = excluded.last_name,
        gender            = excluded.gender,
        grade             = excluded.grade,
        quad              = excluded.quad,
        mobile            = excluded.mobile,
        parent_phone      = excluded.parent_phone,
        date_of_birth     = excluded.date_of_birth,
        svc_attended      = excluded.svc_attended,
        svc_total         = excluded.svc_total,
        grp_attended      = excluded.grp_attended,
        grp_total         = excluded.grp_total,
        grp_met_weeks     = excluded.grp_met_weeks,
        prev_svc_attended = excluded.prev_svc_attended,
        prev_svc_total    = excluded.prev_svc_total,
        prev_grp_attended = excluded.prev_grp_attended,
        prev_grp_total    = excluded.prev_grp_total,
        at_risk_status    = excluded.at_risk_status,
        data_source       = excluded.data_source,
        updated_at        = excluded.updated_at
      returning *
    `;
    return toStudent(rows[0]!);
  }

  async saveMany(students: Student[]): Promise<void> {
    if (students.length === 0) return;
    await this.sql`
      insert into students ${this.sql(
        students.map((s) => ({
          id:                s.id,
          first_name:        s.firstName,
          last_name:         s.lastName,
          gender:            s.gender,
          grade:             s.grade ?? null,
          quad:              s.quad ?? null,
          mobile:            s.mobile ?? null,
          parent_phone:      s.parentPhone ?? null,
          date_of_birth:     s.dateOfBirth ?? null,
          svc_attended:      s.svcAttended,
          svc_total:         s.svcTotal,
          grp_attended:      s.grpAttended,
          grp_total:         s.grpTotal,
          grp_met_weeks:     s.grpMetWeeks,
          prev_svc_attended: s.prevSvcAttended,
          prev_svc_total:    s.prevSvcTotal,
          prev_grp_attended: s.prevGrpAttended,
          prev_grp_total:    s.prevGrpTotal,
          at_risk_status:    s.atRiskStatus ?? null,
          data_source:       s.dataSource ?? null,
          created_at:        s.createdAt,
          updated_at:        s.updatedAt,
        })),
      )}
      on conflict (id) do update set
        first_name        = excluded.first_name,
        last_name         = excluded.last_name,
        gender            = excluded.gender,
        grade             = excluded.grade,
        quad              = excluded.quad,
        mobile            = excluded.mobile,
        parent_phone      = excluded.parent_phone,
        date_of_birth     = excluded.date_of_birth,
        svc_attended      = excluded.svc_attended,
        svc_total         = excluded.svc_total,
        grp_attended      = excluded.grp_attended,
        grp_total         = excluded.grp_total,
        grp_met_weeks     = excluded.grp_met_weeks,
        prev_svc_attended = excluded.prev_svc_attended,
        prev_svc_total    = excluded.prev_svc_total,
        prev_grp_attended = excluded.prev_grp_attended,
        prev_grp_total    = excluded.prev_grp_total,
        at_risk_status    = excluded.at_risk_status,
        data_source       = excluded.data_source,
        updated_at        = excluded.updated_at
    `;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from students where id = ${id} returning id`;
    return rows.length > 0;
  }
}
