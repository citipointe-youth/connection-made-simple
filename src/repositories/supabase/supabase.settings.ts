import type { SqlClient } from './client';
import type {
  ISettingsRepository,
  ISnapshotRepository,
  IAuditRepository,
} from '../interfaces/entity-repositories';
import type { AppSettings, AppDefaults, AdminAuditEntry } from '../../core/entities/settings';

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const SETTINGS_ID = 'global';

function toAppSettings(row: Record<string, unknown>): AppSettings {
  const lockDate = row['connection_lock_date'];
  let connectionLockDate: string | null = null;
  if (lockDate instanceof Date) {
    connectionLockDate = lockDate.toISOString().split('T')[0]!;
  } else if (typeof lockDate === 'string' && lockDate) {
    connectionLockDate = lockDate.split('T')[0]!;
  }
  return {
    id: (row['id'] as string | undefined) ?? SETTINGS_ID,
    ministryName: row['ministry_name'] as string,
    termGapDays: row['term_gap_days'] as number,
    regRateNumerator: row['reg_rate_numerator'] as number,
    regRateDenominator: row['reg_rate_denominator'] as number,
    riskRateNumerator: row['risk_rate_numerator'] as number,
    riskRateDenominator: row['risk_rate_denominator'] as number,
    validThresholdPct: row['valid_threshold_pct'] as number,
    serviceMinAttendance: (row['service_min_attendance'] as number | null) ?? 100,
    serviceName: row['service_name'] as string,
    lifegroupName: row['lifegroup_name'] as string,
    connectionLockDate,
    updatedAt: (row['updated_at'] as Date).toISOString(),
  };
}

function toAppDefaults(row: Record<string, unknown>): AppDefaults {
  return {
    id: row['id'] as string,
    snapshot: row['snapshot'] as { users: unknown[]; leaders: unknown[] },
    createdAt: (row['created_at'] as Date).toISOString(),
  };
}

function toAdminAuditEntry(row: Record<string, unknown>): AdminAuditEntry {
  return {
    id: row['id'] as string,
    action: row['action'] as AdminAuditEntry['action'],
    performedBy: row['performed_by'] as string,
    performedAt: (row['performed_at'] as Date).toISOString(),
    detail: row['detail'] as string,
  };
}

const DEFAULT_SETTINGS: Omit<AppSettings, 'id' | 'updatedAt'> = {
  ministryName: 'Youth Ministry',
  termGapDays: 14,
  regRateNumerator: 3,
  regRateDenominator: 4,
  riskRateNumerator: 1,
  riskRateDenominator: 2,
  validThresholdPct: 25,
  serviceMinAttendance: 100,
  serviceName: 'Sunday Service',
  lifegroupName: 'Lifegroup',
  connectionLockDate: null,
};

// ---------------------------------------------------------------------------
// SupabaseSettingsRepository
// ---------------------------------------------------------------------------

export class SupabaseSettingsRepository implements ISettingsRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findById(id: string): Promise<AppSettings | null> {
    const rows = await this.sql`select * from app_settings where id = ${id}`;
    return rows[0] ? toAppSettings(rows[0]) : null;
  }

  async findAll(): Promise<AppSettings[]> {
    const rows = await this.sql`select * from app_settings where id = ${SETTINGS_ID}`;
    return rows.map(toAppSettings);
  }

  async getSettings(): Promise<AppSettings> {
    const now = new Date().toISOString();
    // Atomic upsert: insert defaults if no row exists; if a row already exists
    // the trivial SET id=id no-op still returns it, so we always get the row
    // in one query (prevents race on concurrent cold starts).
    const rows = await this.sql`
      insert into app_settings (
        id,
        ministry_name,
        term_gap_days,
        reg_rate_numerator,
        reg_rate_denominator,
        risk_rate_numerator,
        risk_rate_denominator,
        valid_threshold_pct,
        service_min_attendance,
        service_name,
        lifegroup_name,
        connection_lock_date,
        updated_at
      )
      values (
        ${SETTINGS_ID},
        ${DEFAULT_SETTINGS.ministryName},
        ${DEFAULT_SETTINGS.termGapDays},
        ${DEFAULT_SETTINGS.regRateNumerator},
        ${DEFAULT_SETTINGS.regRateDenominator},
        ${DEFAULT_SETTINGS.riskRateNumerator},
        ${DEFAULT_SETTINGS.riskRateDenominator},
        ${DEFAULT_SETTINGS.validThresholdPct},
        ${DEFAULT_SETTINGS.serviceMinAttendance},
        ${DEFAULT_SETTINGS.serviceName},
        ${DEFAULT_SETTINGS.lifegroupName},
        ${null},
        ${now}
      )
      on conflict (id) do update set id = app_settings.id
      returning *
    `;
    return toAppSettings(rows[0]!);
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.getSettings();
    const merged: AppSettings = { ...current, ...patch };
    return this.save(merged);
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    const rows = await this.sql`
      insert into app_settings (
        id,
        ministry_name,
        term_gap_days,
        reg_rate_numerator,
        reg_rate_denominator,
        risk_rate_numerator,
        risk_rate_denominator,
        valid_threshold_pct,
        service_min_attendance,
        service_name,
        lifegroup_name,
        connection_lock_date,
        updated_at
      )
      values (
        ${SETTINGS_ID},
        ${settings.ministryName},
        ${settings.termGapDays},
        ${settings.regRateNumerator},
        ${settings.regRateDenominator},
        ${settings.riskRateNumerator},
        ${settings.riskRateDenominator},
        ${settings.validThresholdPct},
        ${settings.serviceMinAttendance},
        ${settings.serviceName},
        ${settings.lifegroupName},
        ${settings.connectionLockDate ?? null},
        ${settings.updatedAt}
      )
      on conflict (id) do update set
        ministry_name         = excluded.ministry_name,
        term_gap_days         = excluded.term_gap_days,
        reg_rate_numerator    = excluded.reg_rate_numerator,
        reg_rate_denominator  = excluded.reg_rate_denominator,
        risk_rate_numerator   = excluded.risk_rate_numerator,
        risk_rate_denominator = excluded.risk_rate_denominator,
        valid_threshold_pct   = excluded.valid_threshold_pct,
        service_min_attendance = excluded.service_min_attendance,
        service_name          = excluded.service_name,
        lifegroup_name        = excluded.lifegroup_name,
        connection_lock_date  = excluded.connection_lock_date,
        updated_at            = excluded.updated_at
      returning *
    `;
    return toAppSettings(rows[0]!);
  }

  async delete(_id: string): Promise<boolean> {
    // Settings row should never be deleted — no-op
    return false;
  }
}

// ---------------------------------------------------------------------------
// SupabaseSnapshotRepository
// ---------------------------------------------------------------------------

export class SupabaseSnapshotRepository implements ISnapshotRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findById(id: string): Promise<AppDefaults | null> {
    const rows = await this.sql`select * from app_defaults where id = ${id}`;
    return rows[0] ? toAppDefaults(rows[0]) : null;
  }

  async findAll(): Promise<AppDefaults[]> {
    const rows = await this.sql`select * from app_defaults order by created_at desc`;
    return rows.map(toAppDefaults);
  }

  async save(snapshot: AppDefaults): Promise<AppDefaults> {
    const rows = await this.sql`
      insert into app_defaults (id, snapshot, created_at)
      values (
        ${snapshot.id},
        ${this.sql.json(snapshot.snapshot as Parameters<typeof this.sql.json>[0])},
        ${snapshot.createdAt}
      )
      on conflict (id) do update set
        snapshot   = excluded.snapshot,
        created_at = excluded.created_at
      returning *
    `;
    return toAppDefaults(rows[0]!);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from app_defaults where id = ${id} returning id`;
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// SupabaseAuditRepository
// ---------------------------------------------------------------------------

export class SupabaseAuditRepository implements IAuditRepository {
  constructor(private sql: SqlClient) {}

  async init(): Promise<void> {
    // No-op: Supabase table already exists
  }

  async findById(id: string): Promise<AdminAuditEntry | null> {
    const rows = await this.sql`select * from admin_audit where id = ${id}`;
    return rows[0] ? toAdminAuditEntry(rows[0]) : null;
  }

  async findAll(): Promise<AdminAuditEntry[]> {
    const rows = await this.sql`select * from admin_audit order by performed_at desc`;
    return rows.map(toAdminAuditEntry);
  }

  async findRecent(limit: number): Promise<AdminAuditEntry[]> {
    const rows =
      await this.sql`select * from admin_audit order by performed_at desc limit ${limit}`;
    return rows.map(toAdminAuditEntry);
  }

  async save(entry: AdminAuditEntry): Promise<AdminAuditEntry> {
    const rows = await this.sql`
      insert into admin_audit (id, action, performed_by, performed_at, detail)
      values (
        ${entry.id},
        ${entry.action},
        ${entry.performedBy},
        ${entry.performedAt},
        ${entry.detail}
      )
      on conflict (id) do update set
        action       = excluded.action,
        performed_by = excluded.performed_by,
        performed_at = excluded.performed_at,
        detail       = excluded.detail
      returning *
    `;
    return toAdminAuditEntry(rows[0]!);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`delete from admin_audit where id = ${id} returning id`;
    return rows.length > 0;
  }
}
