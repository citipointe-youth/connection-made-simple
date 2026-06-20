import { assertCan, canAccessStudent } from './access-control';
import type { IStudentRepository, ISettingsRepository } from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { Student } from '../core/entities/student';
import type { AtRiskStatus } from '../core/types/enums';

export interface AtRiskEntry {
  studentId: string;
  fullName: string;
  grade: number | null;
  gender: string;
  quad: string | null;
  status: AtRiskStatus;
  // Current term
  svcAttended: number;
  svcTotal: number;
  grpAttended: number;
  grpTotal: number;
  svcRate: number | null;
  grpRate: number | null;
  // Previous term (for trend visibility — populated after first new-year rollover)
  prevSvcAttended: number;
  prevSvcTotal: number;
  prevGrpAttended: number;
  prevGrpTotal: number;
  prevSvcRate: number | null;
  prevGrpRate: number | null;
  // Computed trend direction relative to previous term
  svcTrend: 'up' | 'down' | 'stable' | 'no-data';
  grpTrend: 'up' | 'down' | 'stable' | 'no-data';
}

export interface AtRiskService {
  list(actor: Actor, filter?: { grade?: number; gender?: string }): Promise<AtRiskEntry[]>;
  // Re-compute and persist at-risk status for all students based on current settings
  recompute(actor: Actor): Promise<{ updated: number }>;
}

// Severity order for sorting (most severe first)
const SEVERITY_ORDER: AtRiskStatus[] = ['stopped', 'atrisk', 'declining', 'watch'];

export function computeStatus(
  svcAttended: number,
  svcTotal: number,
  grpAttended: number,
  grpTotal: number,
  settings: { riskRateNumerator: number; riskRateDenominator: number; regRateNumerator: number; regRateDenominator: number },
): AtRiskStatus {
  const svcRate = svcTotal > 0 ? svcAttended / svcTotal : null;
  const grpRate = grpTotal > 0 ? grpAttended / grpTotal : null;

  const riskThreshold = settings.riskRateNumerator / settings.riskRateDenominator;
  const regThreshold = settings.regRateNumerator / settings.regRateDenominator;

  if (svcTotal === 0 && grpTotal === 0) return 'new';

  // Stopped: attended NEITHER service NOR lifegroup this term (with enough data
  // in at least one stream to judge). A student who attended >=1 service OR >=1
  // lifegroup is not "stopped" — they fall through to declining/at-risk below.
  const attendedSomething = svcAttended > 0 || grpAttended > 0;
  const enoughData = svcTotal >= 3 || grpTotal >= 3;
  if (!attendedSomething && enoughData) return 'stopped';

  // At risk: below risk threshold
  if (svcRate !== null && svcRate < riskThreshold) return 'atrisk';
  if (grpRate !== null && grpRate < riskThreshold) return 'atrisk';

  // Declining: below regular threshold but above risk threshold
  if (svcRate !== null && svcRate < regThreshold) return 'declining';
  if (grpRate !== null && grpRate < regThreshold) return 'declining';

  return 'regular';
}

function trendDirection(
  curr: number | null,
  prev: number | null,
): 'up' | 'down' | 'stable' | 'no-data' {
  if (prev === null || prev === 0) return 'no-data';
  if (curr === null) return 'no-data';
  const delta = curr - prev;
  // Only flag a trend when the attendance rate moved by >= 20 percentage points
  // vs the previous term (raised from 5pts — the old threshold was too sensitive).
  if (delta > 0.20) return 'up';
  if (delta < -0.20) return 'down';
  return 'stable';
}

function toEntry(s: Student, computedStatus?: AtRiskStatus): AtRiskEntry {
  const status = computedStatus ?? s.atRiskStatus ?? 'regular';
  const svcRate = s.svcTotal > 0 ? s.svcAttended / s.svcTotal : null;
  const grpRate = s.grpTotal > 0 ? s.grpAttended / s.grpTotal : null;
  const prevSvcRate = s.prevSvcTotal > 0 ? s.prevSvcAttended / s.prevSvcTotal : null;
  const prevGrpRate = s.prevGrpTotal > 0 ? s.prevGrpAttended / s.prevGrpTotal : null;
  return {
    studentId: s.id,
    fullName: `${s.firstName} ${s.lastName}`,
    grade: s.grade,
    gender: s.gender,
    quad: s.quad,
    status,
    svcAttended: s.svcAttended,
    svcTotal: s.svcTotal,
    grpAttended: s.grpAttended,
    grpTotal: s.grpTotal,
    svcRate,
    grpRate,
    prevSvcAttended: s.prevSvcAttended,
    prevSvcTotal: s.prevSvcTotal,
    prevGrpAttended: s.prevGrpAttended,
    prevGrpTotal: s.prevGrpTotal,
    prevSvcRate,
    prevGrpRate,
    svcTrend: trendDirection(svcRate, prevSvcRate),
    grpTrend: trendDirection(grpRate, prevGrpRate),
  };
}

const AT_RISK_DISPLAY = new Set<AtRiskStatus>(['atrisk', 'stopped', 'declining', 'watch']);

export function makeAtRiskService(
  studentRepo: IStudentRepository,
  settingsRepo: ISettingsRepository,
): AtRiskService {
  return {
    async list(actor, filter) {
      assertCan(actor, 'atrisk:read');
      const settings = await settingsRepo.getSettings();
      let students = await studentRepo.findAll();

      // Scope by role (grade -> own grade + own gender; quad -> bracket + gender)
      if (actor.role === 'grade' || actor.role === 'quad') {
        students = students.filter((s) => canAccessStudent(actor, s.grade, s.gender));
      }

      // Apply optional filters
      if (filter?.grade != null) students = students.filter((s) => s.grade === filter.grade);
      if (filter?.gender) {
        students = students.filter(
          (s) => s.gender.toLowerCase() === filter.gender!.toLowerCase(),
        );
      }

      // Compute status dynamically and filter to at-risk only
      const entries: AtRiskEntry[] = [];
      for (const s of students) {
        const computed = computeStatus(
          s.svcAttended, s.svcTotal, s.grpAttended, s.grpTotal, settings,
        );
        if (AT_RISK_DISPLAY.has(computed)) {
          entries.push(toEntry(s, computed));
        }
      }

      return entries.sort((a, b) => {
        const ai = SEVERITY_ORDER.indexOf(a.status as AtRiskStatus);
        const bi = SEVERITY_ORDER.indexOf(b.status as AtRiskStatus);
        return (ai - bi) || a.fullName.localeCompare(b.fullName);
      });
    },

    async recompute(actor) {
      assertCan(actor, 'import:run');
      const settings = await settingsRepo.getSettings();
      const students = await studentRepo.findAll();
      const now = new Date().toISOString();
      const changed = [];
      for (const s of students) {
        const newStatus = computeStatus(
          s.svcAttended, s.svcTotal, s.grpAttended, s.grpTotal, settings,
        );
        if (newStatus !== s.atRiskStatus) {
          changed.push({ ...s, atRiskStatus: newStatus, updatedAt: now });
        }
      }
      // Single bulk write (chunked in the repo) instead of one save per student.
      if (changed.length > 0) await studentRepo.saveMany(changed);
      return { updated: changed.length };
    },
  };
}
