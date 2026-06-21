import type { SqlClient } from './client';
import type { IConnectionAuditRepository } from '../interfaces/entity-repositories';
import type { ConnectionAudit, AuditSnapshot } from '../../core/entities/connection-audit';

function toConnectionAudit(row: Record<string, unknown>): ConnectionAudit {
  return {
    id: row['id'] as string,
    year: row['year'] as number,
    label: row['label'] as string,
    uploadedBy: row['uploaded_by'] as string,
    uploadedAt: (row['uploaded_at'] as Date).toISOString(),
    snapshot: row['snapshot'] as AuditSnapshot,
  };
}

export class SupabaseConnectionAuditRepository implements IConnectionAuditRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists (migration 009).
  }

  async findById(id: string): Promise<ConnectionAudit | null> {
    const rows = await this.sql`select * from connection_audits where id = ${id}`;
    return rows[0] ? toConnectionAudit(rows[0]) : null;
  }

  async findByYear(year: number): Promise<ConnectionAudit | null> {
    const rows = await this.sql`select * from connection_audits where year = ${year}`;
    return rows[0] ? toConnectionAudit(rows[0]) : null;
  }

  async findAll(): Promise<ConnectionAudit[]> {
    const rows = await this.sql`select * from connection_audits order by year desc`;
    return rows.map(toConnectionAudit);
  }

  async save(audit: ConnectionAudit): Promise<ConnectionAudit> {
    const rows = await this.sql`
      insert into connection_audits (id, year, label, uploaded_by, uploaded_at, snapshot)
      values (
        ${audit.id},
        ${audit.year},
        ${audit.label},
        ${audit.uploadedBy},
        ${audit.uploadedAt},
        ${this.sql.json(audit.snapshot as unknown as Parameters<typeof this.sql.json>[0])}
      )
      on conflict (id) do update set
        year        = excluded.year,
        label       = excluded.label,
        uploaded_by = excluded.uploaded_by,
        uploaded_at = excluded.uploaded_at,
        snapshot    = excluded.snapshot
      returning *
    `;
    return toConnectionAudit(rows[0]!);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from connection_audits where id = ${id} returning id`;
    return rows.length > 0;
  }
}
