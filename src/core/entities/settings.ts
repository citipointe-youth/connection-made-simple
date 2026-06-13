import type { ID, ISODateString } from '../types/common';

export interface AppSettings {
  id: ID;
  ministryName: string;
  // Term config for at-risk calculation
  termGapDays: number;
  regRateNumerator: number;
  regRateDenominator: number;
  riskRateNumerator: number;
  riskRateDenominator: number;
  validThresholdPct: number;
  // Minimum total ministry attendance for a Friday to count as a "valid service".
  // Sessions below this are disregarded entirely (not counted in any average or
  // attendance-rate denominator) — treated like a week the ministry didn't meet.
  serviceMinAttendance: number;
  serviceName: string;
  lifegroupName: string;
  // Allocation lock: if set and today >= lockDate, non-admin writes are blocked
  connectionLockDate: string | null;
  updatedAt: ISODateString;
}

// Admin action audit entry
export interface AdminAuditEntry {
  id: ID;
  action: 'reset' | 'new-year' | 'save-defaults' | 'settings-update' | 'lock-date-set';
  performedBy: string;
  performedAt: ISODateString;
  detail: string;
}

// Snapshot for year-rollover
export interface AppDefaults {
  id: ID;
  snapshot: {
    users: unknown[];
    leaders: unknown[];
  };
  createdAt: ISODateString;
}
