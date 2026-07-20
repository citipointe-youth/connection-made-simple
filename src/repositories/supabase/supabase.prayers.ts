import type { SqlClient } from './client';
import { toIso } from './client';
import type { IPrayerRepository } from '../interfaces/entity-repositories';
import type { PrayerRequest, PrayerStatus } from '../../core/entities/prayer';
import type { UserRole } from '../../core/types/enums';

function toPrayer(row: Record<string, unknown>): PrayerRequest {
  return {
    id: row['id'] as string,
    studentId: (row['student_id'] as string | null) ?? null,
    // Prayer text is stored plaintext at rest — see CLAUDE.md, Security notes
    text: row['text'] as string,
    status: (row['status'] as PrayerStatus) ?? 'open',
    answerNote: (row['answer_note'] as string | null) ?? null,
    createdByLabel: (row['created_by_label'] as string | null) ?? '',
    createdByRole: row['created_by_role'] as UserRole,
    // jsonb column; postgres.js returns it already parsed (array) or null.
    createdByGrades: (row['created_by_grades'] as number[] | null) ?? null,
    createdByGender: (row['created_by_gender'] as 'male' | 'female' | null) ?? null,
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
    answeredAt: row['answered_at'] ? toIso(row['answered_at']) : null,
  };
}

export class SupabasePrayerRepository implements IPrayerRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> { /* table already exists */ }

  async findAll(): Promise<PrayerRequest[]> {
    const rows = await this.sql`select * from prayer_requests order by created_at desc`;
    return rows.map(toPrayer);
  }

  async findById(id: string): Promise<PrayerRequest | null> {
    const rows = await this.sql`select * from prayer_requests where id = ${id}`;
    return rows[0] ? toPrayer(rows[0]) : null;
  }

  async findByStudent(studentId: string): Promise<PrayerRequest[]> {
    const rows = await this.sql`select * from prayer_requests where student_id = ${studentId} order by created_at desc`;
    return rows.map(toPrayer);
  }

  async save(p: PrayerRequest): Promise<PrayerRequest> {
    // created_by_grades is a nullable jsonb column — write via sql.json(), never
    // `${JSON.stringify(arr)}::jsonb` (double-encodes; see supabase.users.ts's
    // `grades` column for the same gotcha, and the 2026-07-11 config-lockout bug).
    const gradesParam = p.createdByGrades == null
      ? null
      : this.sql.json(p.createdByGrades as unknown as Parameters<typeof this.sql.json>[0]);
    const rows = await this.sql`
      insert into prayer_requests (id, student_id, text, status, answer_note, created_by_label, created_by_role, created_by_grades, created_by_gender, created_at, updated_at, answered_at)
      values (${p.id}, ${p.studentId}, ${p.text}, ${p.status}, ${p.answerNote ?? null}, ${p.createdByLabel}, ${p.createdByRole}, ${gradesParam}, ${p.createdByGender ?? null}, ${p.createdAt}, ${p.updatedAt}, ${p.answeredAt ?? null})
      on conflict (id) do update set
        text              = excluded.text,
        status            = excluded.status,
        answer_note       = excluded.answer_note,
        created_by_label  = excluded.created_by_label,
        created_by_role   = excluded.created_by_role,
        created_by_grades = excluded.created_by_grades,
        created_by_gender = excluded.created_by_gender,
        updated_at        = excluded.updated_at,
        answered_at       = excluded.answered_at
      returning *
    `;
    return toPrayer(rows[0]!);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from prayer_requests where id = ${id} returning id`;
    return rows.length > 0;
  }

  // M1 (2026-07-19): cascade-delete a student's prayers when the student
  // itself is removed — called from student.service.ts's remove(). General
  // (null student_id) prayers are untouched by construction (the WHERE clause
  // never matches them).
  async deleteByStudent(studentId: string): Promise<void> {
    await this.sql`delete from prayer_requests where student_id = ${studentId}`;
  }

  async deleteAll(): Promise<void> {
    await this.sql`truncate table prayer_requests cascade`;
  }
}
