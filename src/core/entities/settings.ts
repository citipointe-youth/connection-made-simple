import type { ID, ISODateString } from '../types/common';
import type { MinistryConfig } from '../ministry-config';

export interface AppSettings {
  id: ID;
  // Days between consecutive service dates that mark a new term boundary.
  termGapDays: number;
  validThresholdPct: number;
  // Minimum total ministry attendance for a Friday to count as a "valid service".
  // Sessions below this are disregarded entirely (not counted in any average or
  // attendance-rate denominator) — treated like a week the ministry didn't meet.
  serviceMinAttendance: number;
  // Per-deployment branding/terminology/structure/roles/modules/import config.
  // An empty object (MINISTRY_CONFIG_DEFAULTS applied to {}) means "YS Brisbane
  // behaviour" — see src/core/ministry-config.ts.
  ministryConfig: MinistryConfig;
  updatedAt: ISODateString;
}

// Admin action audit entry
export interface AdminAuditEntry {
  id: ID;
  action: 'reset' | 'new-year' | 'settings-update' | 'lock-date-set';
  performedBy: string;
  performedAt: ISODateString;
  detail: string;
}
