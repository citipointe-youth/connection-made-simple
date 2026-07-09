import { assertCan } from './access-control';
import { BadRequestError } from '../core/errors/app-error';
import { invalidateOverviewCache } from './overview.service';
import { invalidateTrendsCache } from './trends.service';
import { invalidateLgStatsCache } from './lifegroup-stats.service';
import type {
  IStudentRepository,
  ILeaderRepository,
  IConnectionRepository,
  IServiceSessionRepository,
  IServiceAttendanceRepository,
  ILifegroupRepository,
  ILifegroupWeekRepository,
  ILifegroupAttendanceRepository,
  IImportRepository,
  IAuditRepository,
  IConnectionAuditRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { AdminAuditEntry } from '../core/entities/settings';
import { generateId } from '../utils/id';

export interface AdminAuditRow {
  id: string;
  action: string;
  performedBy: string;
  performedAt: string;
  detail: string;
}

export interface WipeOpts {
  force?: boolean;
  confirmWipe?: string;
}

// Mirrors the camp app's admin.service.ts wipe guard (src/services/admin.service.ts,
// Project 9): a destructive route must be called with force:true AND this exact
// confirmation string, checked BEFORE any data is touched. Unlike the camp's guard,
// CMS has no lastExportedAt escape hatch — force+confirmWipe is always required.
const CONFIRM_WIPE_STRING = 'I understand this cannot be undone';

function assertForceConfirmed(opts?: WipeOpts): void {
  if (!opts?.force || opts.confirmWipe !== CONFIRM_WIPE_STRING) {
    throw new BadRequestError(`force requires confirmWipe: "${CONFIRM_WIPE_STRING}"`);
  }
}

export interface AdminService {
  reset(actor: Actor, opts?: WipeOpts): Promise<void>;
  clearServiceGroupData(actor: Actor, opts?: WipeOpts): Promise<void>;
  getAuditLog(actor: Actor, limit?: number): Promise<AdminAuditRow[]>;
}

async function writeAudit(
  repo: IAuditRepository,
  actor: Actor,
  action: AdminAuditEntry['action'],
  detail: string,
): Promise<void> {
  await repo.save({
    id: generateId(),
    action,
    performedBy: actor.displayName,
    performedAt: new Date().toISOString(),
    detail,
  });
}

export function makeAdminService(
  students: IStudentRepository,
  leaders: ILeaderRepository,
  connections: IConnectionRepository,
  serviceSessions: IServiceSessionRepository,
  serviceAttendance: IServiceAttendanceRepository,
  lifegroups: ILifegroupRepository,
  lifegroupWeeks: ILifegroupWeekRepository,
  lifegroupAttendance: ILifegroupAttendanceRepository,
  imports: IImportRepository,
  audit: IAuditRepository,
  connectionAudits: IConnectionAuditRepository,
): AdminService {
  // Wipe all attendance/connection data in FK-safe order (children before
  // parents). Each call is a single bulk DELETE, so this stays well within the
  // serverless function budget regardless of dataset size. `includeLeaders` is
  // the full-reset path (clears students + leaders); used by reset().
  async function wipeData(opts: { includeLeaders: boolean }): Promise<void> {
    await connections.deleteAll();
    await serviceAttendance.deleteAll();
    await lifegroupAttendance.deleteAll();
    await serviceSessions.deleteAll();
    await lifegroupWeeks.deleteAll();
    await lifegroups.deleteAll();
    await imports.deleteAll();
    await students.deleteAll();
    if (opts.includeLeaders) await leaders.deleteAll();
  }

  return {
    async reset(actor, opts) {
      assertCan(actor, 'admin:manage');
      assertForceConfirmed(opts);
      await wipeData({ includeLeaders: true });
      // Full Reset means NO student data left in the app at all — the Connection
      // Audit's server-stored snapshots (connection_audits) hold per-student
      // rows too, so they must go along with the live tables above. Back these
      // up first via GET /audits/export-all if they're still needed.
      const savedAudits = await connectionAudits.findAll();
      await Promise.all(savedAudits.map((a) => connectionAudits.delete(a.id)));
      await writeAudit(audit, actor, 'reset', 'Full data reset — students, leaders, connections, services, lifegroup and connection audit data cleared');
      invalidateOverviewCache();
      invalidateTrendsCache();
      invalidateLgStatsCache();
    },

    async clearServiceGroupData(actor, opts) {
      assertCan(actor, 'admin:manage');
      assertForceConfirmed(opts);
      // Clear ALL service + lifegroup data but KEEP students (grade, age, phone),
      // their connections, leaders and accounts. Each student's attendance
      // aggregates are reset to 0 so the cleared data isn't still shown. Deletes
      // are ordered children-before-parents (sessions/weeks before their imports).
      await serviceAttendance.deleteAll();
      await lifegroupAttendance.deleteAll();
      await serviceSessions.deleteAll();
      await lifegroupWeeks.deleteAll();
      await lifegroups.deleteAll();
      await imports.deleteAll();

      const allStudents = await students.findAll();
      const now = new Date().toISOString();
      const reset = allStudents.map((s) => ({
        ...s,
        svcAttended: 0, svcTotal: 0,
        grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
        prevSvcAttended: 0, prevSvcTotal: 0,
        prevGrpAttended: 0, prevGrpTotal: 0,
        atRiskStatus: 'new' as const,
        updatedAt: now,
      }));
      if (reset.length > 0) await students.saveMany(reset);

      await writeAudit(audit, actor, 'new-year', 'Cleared all service & lifegroup data; students, connections, leaders and accounts retained');
      invalidateOverviewCache();
      invalidateTrendsCache();
      invalidateLgStatsCache();
    },

    async getAuditLog(actor, limit = 20) {
      assertCan(actor, 'admin:manage');
      return audit.findRecent(limit);
    },
  };
}
