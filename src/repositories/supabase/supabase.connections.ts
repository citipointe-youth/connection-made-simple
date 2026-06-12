import type { SqlClient } from './client';
import type { IConnectionRepository } from '../interfaces/entity-repositories';
import type { Connection } from '../../core/entities/connection';

function toConnection(row: Record<string, unknown>): Connection {
  return {
    id: row['id'] as string,
    studentId: row['student_id'] as string,
    leaderId: row['leader_id'] as string,
    assignedByRole: row['assigned_by_role'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
  };
}

export class SupabaseConnectionRepository implements IConnectionRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findAll(): Promise<Connection[]> {
    const rows = await this.sql`select * from connections order by created_at`;
    return rows.map(toConnection);
  }

  async findById(id: string): Promise<Connection | null> {
    const rows = await this.sql`select * from connections where id = ${id}`;
    return rows[0] ? toConnection(rows[0]) : null;
  }

  async findByStudent(studentId: string): Promise<Connection[]> {
    const rows = await this.sql`select * from connections where student_id = ${studentId}`;
    return rows.map(toConnection);
  }

  async findByLeader(leaderId: string): Promise<Connection[]> {
    const rows = await this.sql`select * from connections where leader_id = ${leaderId}`;
    return rows.map(toConnection);
  }

  async findByStudentAndLeader(studentId: string, leaderId: string): Promise<Connection | null> {
    const rows = await this.sql`
      select * from connections
      where student_id = ${studentId} and leader_id = ${leaderId}
    `;
    return rows[0] ? toConnection(rows[0]) : null;
  }

  async save(conn: Connection): Promise<Connection> {
    const rows = await this.sql`
      insert into connections (id, student_id, leader_id, assigned_by_role, created_at)
      values (
        ${conn.id},
        ${conn.studentId},
        ${conn.leaderId},
        ${conn.assignedByRole},
        ${conn.createdAt}
      )
      on conflict (student_id, leader_id) do update set
        assigned_by_role = excluded.assigned_by_role,
        id               = excluded.id,
        created_at       = excluded.created_at
      returning *
    `;
    return toConnection(rows[0]!);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from connections where id = ${id} returning id`;
    return rows.length > 0;
  }

  async deleteByStudentAndLeader(studentId: string, leaderId: string): Promise<boolean> {
    const rows = await this.sql`
      delete from connections
      where student_id = ${studentId} and leader_id = ${leaderId}
      returning id
    `;
    return rows.length > 0;
  }
}
