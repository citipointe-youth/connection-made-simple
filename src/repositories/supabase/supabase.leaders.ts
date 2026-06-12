import type { SqlClient } from './client';
import type { ILeaderRepository } from '../interfaces/entity-repositories';
import type { Leader } from '../../core/entities/leader';
import type { Gender, Grade } from '../../core/types/enums';

function toLeader(row: Record<string, unknown>): Leader {
  return {
    id: row['id'] as string,
    fullName: row['full_name'] as string,
    gender: (row['gender'] as Gender | null) ?? null,
    grades: ((row['grades'] as number[] | null) ?? []) as Grade[],
    active: row['active'] as boolean,
    createdByGrade: (row['created_by_grade'] as number | null) ?? null,
    createdAt: (row['created_at'] as Date).toISOString(),
    updatedAt: (row['updated_at'] as Date).toISOString(),
  };
}

export class SupabaseLeaderRepository implements ILeaderRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<Leader[]> {
    const rows = await this.sql`select * from leaders order by full_name`;
    return rows.map(toLeader);
  }

  async findById(id: string): Promise<Leader | null> {
    const rows = await this.sql`select * from leaders where id = ${id}`;
    return rows[0] ? toLeader(rows[0]) : null;
  }

  async findByGrade(grade: number): Promise<Leader[]> {
    const rows = await this.sql`
      select * from leaders
      where active = true
        and (grades = '{}' or ${grade} = any(grades))
      order by full_name
    `;
    return rows.map(toLeader);
  }

  async findActive(): Promise<Leader[]> {
    const rows = await this.sql`select * from leaders where active = true order by full_name`;
    return rows.map(toLeader);
  }

  async save(leader: Leader): Promise<Leader> {
    const rows = await this.sql`
      insert into leaders (id, full_name, gender, grades, active, created_by_grade, created_at, updated_at)
      values (
        ${leader.id},
        ${leader.fullName},
        ${leader.gender ?? null},
        ${leader.grades as number[]},
        ${leader.active},
        ${leader.createdByGrade ?? null},
        ${leader.createdAt},
        ${leader.updatedAt}
      )
      on conflict (id) do update set
        full_name        = excluded.full_name,
        gender           = excluded.gender,
        grades           = excluded.grades,
        active           = excluded.active,
        created_by_grade = excluded.created_by_grade,
        updated_at       = excluded.updated_at
      returning *
    `;
    return toLeader(rows[0]!);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from leaders where id = ${id} returning id`;
    return rows.length > 0;
  }
}
