import { z } from 'zod';
import { assertCan } from './access-control';
import { generateId } from '../utils/id';
import type {
  IConnectionAuditRepository,
  ISettingsRepository,
  IStudentRepository,
  IServiceSessionRepository,
  IServiceAttendanceRepository,
  ILifegroupRepository,
  ILifegroupWeekRepository,
  ILifegroupAttendanceRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { ConnectionAudit, AuditSnapshot, AuditStudentRow, AuditUploadRow, AuditTermSnapshot } from '../core/entities/connection-audit';
import { BadRequestError } from '../core/errors/app-error';
import { buildServiceModel, buildGroupModel, buildLifegroupStats, type GroupInput, type AuditLgStat } from './attendance-build';
import { computeYearAggregates } from './year-aggregates';
import { computeQuad } from '../core/types/enums';
import type { LabeledTerm } from './year-terms';

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

// Exact round-trip backup/restore format for the New Year Refresh wizard: the
// raw ConnectionAudit rows as exported by exportAll(), trusted as our own
// previously-exported shape — snapshot is opaque here (already validated when
// it was originally built by upload()/finalizeFromLive()).
const ImportAllSchema = z.array(z.object({
  id: z.string(),
  year: z.number(),
  label: z.string(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  snapshot: z.unknown(),
}));

// Per-named-lifegroup stats built straight from LIVE tables (real grade/gender/
// quad from the Lifegroup row, not text-parsed from its name like the CSV-audit
// path has to) — powers the "New Year Data Refresh" wizard's live baseline.
function buildLiveLifegroupStats(
  lifegroups: { id: string; fullName: string; shortName: string; grade: number | null; gender: string | null }[],
  weekStartById: Map<string, string>,
  attendance: { studentId: string; weekId: string; lifegroupId: string; attended: boolean }[],
  studentById: Map<string, { firstName: string; lastName: string }>,
  terms: LabeledTerm[],
): Record<string, AuditLgStat[]> {
  const out: Record<string, AuditLgStat[]> = {};
  for (const t of terms) out[t.key] = [];

  const termFor = (weekStart: string): string | null => {
    for (const t of terms) if (weekStart >= t.startDate && weekStart <= t.endDate) return t.key;
    return null;
  };

  const byLifegroup = new Map<string, typeof attendance>();
  for (const r of attendance) {
    let arr = byLifegroup.get(r.lifegroupId);
    if (!arr) { arr = []; byLifegroup.set(r.lifegroupId, arr); }
    arr.push(r);
  }

  for (const lg of lifegroups) {
    const rows = byLifegroup.get(lg.id) ?? [];
    const quad = computeQuad(lg.grade, lg.gender ?? 'other');
    const perTerm = new Map<string, {
      weeks: Set<string>; members: Set<string>; attenders: Set<string>; visits: number;
      roster: Map<string, { firstName: string; lastName: string; attended: number }>;
    }>();
    const ensure = (k: string) => {
      let a = perTerm.get(k);
      if (!a) { a = { weeks: new Set(), members: new Set(), attenders: new Set(), visits: 0, roster: new Map() }; perTerm.set(k, a); }
      return a;
    };
    for (const r of rows) {
      const weekStart = weekStartById.get(r.weekId);
      if (!weekStart) continue;
      const tk = termFor(weekStart);
      if (!tk) continue;
      const acc = ensure(tk);
      acc.weeks.add(weekStart);
      acc.members.add(r.studentId);
      let entry = acc.roster.get(r.studentId);
      if (!entry) {
        const s = studentById.get(r.studentId);
        entry = { firstName: s?.firstName ?? '?', lastName: s?.lastName ?? '', attended: 0 };
        acc.roster.set(r.studentId, entry);
      }
      if (r.attended) { acc.attenders.add(r.studentId); acc.visits++; entry.attended++; }
    }
    for (const [tk, acc] of perTerm) {
      const weeksRan = acc.weeks.size;
      out[tk]!.push({
        lifegroupId: lg.id,
        // fullName (not shortName) so this matches the CSV-audit-upload path's
        // AuditLgStat.name (the raw uploaded group name, untouched) — shortName
        // has already had its first "X - " segment stripped at import time
        // (import.service.ts), which would double up inconsistently with the
        // SPA's own "Brisbane - YS - " / "Lifegroup" display trim (bug 5).
        name: lg.fullName,
        grade: lg.grade,
        gender: lg.gender as 'male' | 'female' | null,
        quad,
        members: acc.members.size,
        uniqueAttenders: acc.attenders.size,
        totalVisits: acc.visits,
        weeksRan,
        avgPerWeek: weeksRan ? Math.round(acc.visits / weeksRan) : 0,
        roster: [...acc.roster.values()]
          .map((r) => ({ firstName: r.firstName, lastName: r.lastName, attended: r.attended, total: weeksRan }))
          .sort((a, b) => b.attended - a.attended || a.firstName.localeCompare(b.firstName)),
      });
    }
  }
  return out;
}

export interface ConnectionAuditService {
  upload(actor: Actor, input: unknown): Promise<ConnectionAudit>;
  list(actor: Actor): Promise<AuditSummary[]>;
  get(actor: Actor, year: number): Promise<ConnectionAudit | null>;
  remove(actor: Actor, year: number): Promise<void>;
  // Finalizes this year's audit snapshot directly from LIVE data (no CSV upload
  // needed) — used by the admin "New Year Data Refresh" wizard before a Full
  // Reset. CRM overlays (team/connect/decision/flows) are left empty; a later
  // manual CA upload for the same year overwrites this snapshot (same
  // latest-per-year behavior as upload()).
  finalizeFromLive(actor: Actor): Promise<ConnectionAudit>;
  // Full-fidelity backup/restore of every saved year, used by the New Year
  // Refresh wizard to survive a Full Reset (which wipes connection_audits).
  // Exact round-trip: exports the raw ConnectionAudit rows as-is.
  exportAll(actor: Actor): Promise<ConnectionAudit[]>;
  importAll(actor: Actor, input: unknown): Promise<{ imported: number }>;
}

export function makeConnectionAuditService(
  repo: IConnectionAuditRepository,
  settingsRepo: ISettingsRepository,
  studentRepo: IStudentRepository,
  sessionRepo: IServiceSessionRepository,
  serviceAttendanceRepo: IServiceAttendanceRepository,
  lifegroupRepo: ILifegroupRepository,
  lifegroupWeekRepo: ILifegroupWeekRepository,
  lifegroupAttendanceRepo: ILifegroupAttendanceRepository,
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

    async finalizeFromLive(actor) {
      assertCan(actor, 'import:run');
      const now = new Date().toISOString();
      const [settings, students, sessions, serviceAttendance, weeks, lifegroups, lifegroupAttendance] = await Promise.all([
        settingsRepo.getSettings(),
        studentRepo.findAll(),
        sessionRepo.findAll(),
        serviceAttendanceRepo.findAll(),
        lifegroupWeekRepo.findAll(),
        lifegroupRepo.findAll(),
        lifegroupAttendanceRepo.findAll(),
      ]);

      const weekStartById = new Map(weeks.map((w) => [w.id, w.weekStart]));
      const agg = computeYearAggregates({
        termGapDays: settings.termGapDays,
        serviceSessions: sessions.map((s) => ({ id: s.id, date: s.sessionDate, valid: s.isValid })),
        serviceAttendance: serviceAttendance.map((a) => ({ studentId: a.studentId, sessionId: a.sessionId, attended: a.attended })),
        weekStartById,
        lifegroupAttendance: lifegroupAttendance.map((a) => ({ studentId: a.studentId, weekId: a.weekId, attended: a.attended })),
      });
      if (agg.terms.length === 0) throw new BadRequestError('No valid services found — nothing to finalize yet');

      const dataStartDate = agg.terms[0]!.startDate;
      const dataEndDate = agg.terms[agg.terms.length - 1]!.endDate;
      const year = agg.terms[agg.terms.length - 1]!.year;
      const latestKey = agg.terms[agg.terms.length - 1]!.key;

      const perTerm: Record<string, AuditTermSnapshot> = {};
      for (const [key, tr] of agg.perTerm) {
        const byStudent: AuditTermSnapshot['byStudent'] = {};
        for (const [id, a] of tr.byStudent) byStudent[id] = { svcAttended: a.svcAttended, grpAttended: a.grpAttended, grpTotal: a.grpTotal };
        perTerm[key] = { key, svcTotal: tr.svcTotal, inProgress: key === latestKey, byStudent };
      }

      const studentRows: AuditStudentRow[] = students.map((s) => ({
        id: s.id, firstName: s.firstName, lastName: s.lastName,
        gender: s.gender as 'male' | 'female' | 'other', grade: s.grade, quad: s.quad,
      }));
      const studentById = new Map(students.map((s) => [s.id, { firstName: s.firstName, lastName: s.lastName }]));

      const snapshot: AuditSnapshot = {
        generatedAt: now,
        dataStartDate,
        dataEndDate,
        terms: agg.terms,
        students: studentRows,
        perTerm,
        lgStatsByTerm: buildLiveLifegroupStats(lifegroups, weekStartById, lifegroupAttendance, studentById, agg.terms),
        uploads: { team: [], connect: [], decision: [], flows: [] },
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

    async exportAll(actor) {
      assertCan(actor, 'admin:manage');
      const all = await repo.findAll();
      return all.sort((a, b) => a.year - b.year);
    },

    async importAll(actor, input) {
      assertCan(actor, 'admin:manage');
      const rows = ImportAllSchema.parse(input);
      for (const row of rows) {
        await repo.save(row as unknown as ConnectionAudit);
      }
      return { imported: rows.length };
    },
  };
}
