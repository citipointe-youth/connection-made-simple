import { z } from 'zod';
import { assertCan } from './access-control';
import { generateId } from '../utils/id';
import type { IConnectionAuditRepository, ISettingsRepository } from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { ConnectionAudit, AuditSnapshot, AuditStudentRow, AuditUploadRow, AuditTermSnapshot } from '../core/entities/connection-audit';
import { BadRequestError } from '../core/errors/app-error';
import { buildServiceModel, buildGroupModel, buildLifegroupStats, type GroupInput } from './attendance-build';
import { computeYearAggregates } from './year-aggregates';

// The CRM overlays (team/connect/decision/flows) are stored verbatim and echoed
// back to the SPA — never computed server-side — so they round-trip as opaque
// rows. (People Flow rows carry person/step/entered/days/admin, unlike the
// name/date shape of the others; an opaque schema preserves both.)
const OverlayRows = z.array(z.record(z.string(), z.unknown())).default([]);

const UploadSchema = z.object({
  service: z.object({ rows: z.array(z.unknown()) }),
  group: z.object({ groups: z.array(z.any()) }).default({ groups: [] }),
  team: OverlayRows,
  connect: OverlayRows,
  decision: OverlayRows,
  flows: OverlayRows,
});

export interface AuditSummary { year: number; label: string; uploadedAt: string; termKeys: string[]; }

export interface ConnectionAuditService {
  upload(actor: Actor, input: unknown): Promise<ConnectionAudit>;
  list(actor: Actor): Promise<AuditSummary[]>;
  get(actor: Actor, year: number): Promise<ConnectionAudit | null>;
  remove(actor: Actor, year: number): Promise<void>;
}

export function makeConnectionAuditService(
  repo: IConnectionAuditRepository,
  settingsRepo: ISettingsRepository,
): ConnectionAuditService {
  return {
    async upload(actor, input) {
      assertCan(actor, 'import:run');
      const data = UploadSchema.parse(input);
      const settings = await settingsRepo.getSettings();
      const now = new Date().toISOString();

      // Build sessions/attendance/weeks from the uploaded YTD CSVs — no live DB writes.
      const svc = buildServiceModel(data.service.rows, settings.serviceMinAttendance);
      const grp = buildGroupModel(data.group.groups as unknown as GroupInput[]);

      // One student id per unique person (name) across BOTH streams. The service
      // roster carries identity (gender/grade/quad); group-only names get a stub.
      const idByName = new Map<string, string>();
      const studentByName = new Map<string, AuditStudentRow>();
      for (const r of svc.roster) {
        if (idByName.has(r.nameKey)) continue;
        const id = generateId();
        idByName.set(r.nameKey, id);
        studentByName.set(r.nameKey, { id, firstName: r.firstName, lastName: r.lastName, gender: r.gender, grade: r.grade, quad: r.quad });
      }
      for (const r of grp.roster) {
        if (idByName.has(r.nameKey)) continue;
        const id = generateId();
        idByName.set(r.nameKey, id);
        // Authoritative grade/gender comes ONLY from a service name-match (same as
        // the live importer). A group-only youth with no service record stays
        // grade-less; their lifegroup activity still surfaces in Lifegroup Health
        // (which attributes by the lifegroup's own grade, not the student's).
        studentByName.set(r.nameKey, { id, firstName: r.firstName, lastName: r.lastName, gender: 'other', grade: null, quad: null });
      }

      const agg = computeYearAggregates({
        termGapDays: settings.termGapDays,
        serviceSessions: svc.sessions.map((s) => ({ id: s.id, date: s.sessionDate, valid: s.isValid })),
        serviceAttendance: svc.attendance.map((a) => ({ studentId: idByName.get(a.nameKey)!, sessionId: a.sessionId, attended: a.attended })),
        weekStartById: new Map(grp.weeks.map((w) => [w.id, w.weekStart])),
        lifegroupAttendance: grp.attendance.map((a) => ({ studentId: idByName.get(a.nameKey)!, weekId: a.weekId, attended: a.attended })),
      });

      if (agg.terms.length === 0) throw new BadRequestError('No valid services found in the uploaded data');

      const dataStartDate = agg.terms[0]!.startDate;
      const dataEndDate = agg.terms[agg.terms.length - 1]!.endDate;
      const year = agg.terms[agg.terms.length - 1]!.year; // the YTD year = latest term's year
      const latestKey = agg.terms[agg.terms.length - 1]!.key;

      const perTerm: Record<string, AuditTermSnapshot> = {};
      for (const [key, tr] of agg.perTerm) {
        const byStudent: AuditTermSnapshot['byStudent'] = {};
        for (const [id, a] of tr.byStudent) byStudent[id] = { svcAttended: a.svcAttended, grpAttended: a.grpAttended, grpTotal: a.grpTotal };
        perTerm[key] = { key, svcTotal: tr.svcTotal, inProgress: key === latestKey, byStudent };
      }

      const snapshot: AuditSnapshot = {
        generatedAt: now,
        dataStartDate,
        dataEndDate,
        terms: agg.terms,
        students: [...studentByName.values()],
        perTerm,
        lgStatsByTerm: buildLifegroupStats(data.group.groups as unknown as GroupInput[], agg.terms),
        uploads: {
          team: data.team as AuditUploadRow[],
          connect: data.connect as AuditUploadRow[],
          decision: data.decision as AuditUploadRow[],
          flows: data.flows as AuditUploadRow[],
        },
      };

      const audit: ConnectionAudit = {
        id: String(year),
        year,
        label: `${year} (year-to-date)`,
        uploadedBy: actor.displayName,
        uploadedAt: now,
        snapshot,
      };
      return repo.save(audit);
    },

    async list(actor) {
      assertCan(actor, 'import:run');
      const all = await repo.findAll();
      return all
        .sort((a, b) => b.year - a.year)
        .map((a) => ({ year: a.year, label: a.label, uploadedAt: a.uploadedAt, termKeys: a.snapshot.terms.map((t) => t.key) }));
    },

    async get(actor, year) {
      assertCan(actor, 'import:run');
      return repo.findByYear(year);
    },

    async remove(actor, year) {
      assertCan(actor, 'import:run');
      await repo.delete(String(year));
    },
  };
}
