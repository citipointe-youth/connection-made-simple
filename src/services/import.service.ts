import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan } from './access-control';
import { invalidateTrendsCache } from './trends.service';
import { invalidateLgStatsCache } from './lifegroup-stats.service';
import type {
  IStudentRepository,
  ILeaderRepository,
  IServiceSessionRepository,
  IServiceAttendanceRepository,
  ILifegroupRepository,
  ILifegroupWeekRepository,
  ILifegroupAttendanceRepository,
  IImportRepository,
  ISettingsRepository,
} from '../repositories/interfaces/entity-repositories';
import type { Actor } from '../core/entities/user';
import type { Student } from '../core/entities/student';
import type { AppSettings } from '../core/entities/settings';
import { computeQuad } from '../core/types/enums';
import { BadRequestError } from '../core/errors/app-error';
import { computeStatus } from './atrisk.service';
import { computeStudentAggregates, emptyStudentAggregate, type AggregateResult } from './aggregates';

// A "week" runs Saturday→Friday — the calendar week that contains that week's
// Friday service. Map any meeting date to the Saturday on/before it so lifegroup
// attendance is bucketed per week (a group that meets twice in a week counts as
// one week).
function weekStartOf(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return isoDate;
  const offset = (d.getUTCDay() + 1) % 7; // days since this week's Saturday
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

const ServiceRowSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  gender: z.string(),
  grade: z.coerce.number().int().min(7).max(12).nullable().optional(),
  mobile: z.string().optional(),
  phone: z.string().optional(),
  parent_phone: z.string().optional(),
  guardian_phone: z.string().optional(),
  date_of_birth: z.string().optional(),
  birthday: z.string().optional(),
});

const GroupMemberSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  attendance: z.array(z.boolean().nullable()),
});

const GroupDataSchema = z.object({
  name: z.string().min(1),
  meetings: z.array(z.string()),
  members: z.array(GroupMemberSchema),
});

const GroupImportPayloadSchema = z.object({
  groups: z.array(GroupDataSchema),
});

export interface ImportResult {
  importId: string;
  type: 'service';
  rowCount: number;
  studentsAdded: number;
  studentsUpdated: number;
  sessionsAdded: number;
}

export interface GroupImportResult {
  importId: string;
  type: 'lifegroup';
  rowCount: number;
  groupsAdded: number;
  studentsAdded: number;
  studentsUpdated: number;
  weeksAdded: number;
}

export interface ImportHistoryEntry {
  id: string;
  filename: string;
  rowCount: number;
  studentsAdded: number;
  studentsUpdated: number;
  sessionsAdded: number;
  status: 'ok' | 'error';
  errorMessage: string | null;
  importedAt: string;
}

export interface ImportService {
  importServiceCsv(actor: Actor, rows: unknown[], filename: string): Promise<ImportResult>;
  importGroupCsv(actor: Actor, payload: unknown, filename: string): Promise<GroupImportResult>;
  listHistory(actor: Actor): Promise<ImportHistoryEntry[]>;
  deleteImport(actor: Actor, id: string): Promise<void>;
  clearHistory(actor: Actor): Promise<void>;
}

function normalizeDob(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // DD/MM/YYYY — Australian format common in Elvanto/UCare exports
  const ddmm = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmm) return `${ddmm[3]}-${ddmm[2]!.padStart(2, '0')}-${ddmm[1]!.padStart(2, '0')}`;
  // MM/DD/YYYY fallback
  const mmdd = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mmdd) return `${mmdd[3]}-${mmdd[1]!.padStart(2, '0')}-${mmdd[2]!.padStart(2, '0')}`;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]!;
  return null;
}

function parseGroupName(name: string): { grade: number | null; gender: 'male' | 'female' | null } {
  const gradeMatch = name.match(/\bGrade\s+(\d+)\b/i);
  const grade = gradeMatch ? parseInt(gradeMatch[1]!, 10) : null;
  let gender: 'male' | 'female' | null = null;
  if (/\bboys?\b/i.test(name)) gender = 'male';
  else if (/\bgirls?\b/i.test(name)) gender = 'female';
  return { grade, gender };
}

// Apply a recomputed term split to every student. Both import paths call this
// after writing their stream's raw rows, so service AND lifegroup current/
// previous-term counts stay consistent regardless of which stream was imported
// or in what order. At-risk is computed from the CURRENT term (the default
// everywhere). svcTotal/prevSvcTotal are global valid-session counts; grp totals
// are per-student weeks-the-group-ran in each term.
function applyAggregatesToStudents(
  base: Student[],
  agg: AggregateResult,
  settings: AppSettings,
  now: string,
): Student[] {
  return base.map((s) => {
    const a = agg.byStudent.get(s.id) ?? emptyStudentAggregate();
    return {
      ...s,
      svcAttended: a.svcAttended,
      svcTotal: agg.svcTotal,
      prevSvcAttended: a.prevSvcAttended,
      prevSvcTotal: agg.prevSvcTotal,
      grpAttended: a.grpAttended,
      grpTotal: a.grpTotal,
      grpMetWeeks: a.grpMetWeeks,
      prevGrpAttended: a.prevGrpAttended,
      prevGrpTotal: a.prevGrpTotal,
      atRiskStatus: computeStatus(
        a.svcAttended, agg.svcTotal, a.grpAttended, a.grpTotal,
        a.prevSvcAttended, agg.prevSvcTotal, a.prevGrpAttended, a.prevGrpTotal,
      ),
      updatedAt: now,
    };
  });
}

export function makeImportService(
  studentRepo: IStudentRepository,
  sessionRepo: IServiceSessionRepository,
  attendanceRepo: IServiceAttendanceRepository,
  importRepo: IImportRepository,
  settingsRepo: ISettingsRepository,
  lifegroupRepo: ILifegroupRepository,
  lifegroupWeekRepo: ILifegroupWeekRepository,
  lifegroupAttendanceRepo: ILifegroupAttendanceRepository,
  leaderRepo: ILeaderRepository,
): ImportService {
  return {
    async listHistory(actor) {
      assertCan(actor, 'import:run');
      const records = await importRepo.findAll();
      records.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
      return records.map((r) => ({
        id: r.id,
        filename: r.filename,
        rowCount: r.rowCount,
        studentsAdded: r.studentsAdded,
        studentsUpdated: r.studentsUpdated,
        sessionsAdded: r.sessionsAdded,
        status: r.status,
        errorMessage: r.errorMessage,
        importedAt: r.importedAt,
      }));
    },

    async importServiceCsv(actor, rows, filename) {
      assertCan(actor, 'import:run');
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new BadRequestError('No data rows provided');
      }

      // Two reads upfront — parallel
      const [settings, allStudents] = await Promise.all([
        settingsRepo.getSettings(),
        studentRepo.findAll(),
      ]);

      const importId = generateId();
      const now = new Date().toISOString();

      // Detect session date columns — ISO (YYYY-MM-DD) or Excel short-date (DD-MMM / D-MMM-YY)
      const sampleRow = rows[0] as Record<string, unknown>;
      const MONTH_MAP: Record<string, string> = {
        jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
        jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
      };
      function normaliseDate(key: string): string | null {
        if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
        const m = key.match(/^(\d{1,2})-([A-Za-z]{3})(?:-(\d{2,4}))?$/);
        if (!m) return null;
        const day = m[1]!.padStart(2, '0');
        const mon = MONTH_MAP[m[2]!.toLowerCase()];
        if (!mon) return null;
        let year: number;
        if (m[3]) {
          year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
        } else {
          const nowDate = new Date();
          year = nowDate.getFullYear();
          const parsed = new Date(`${year}-${mon}-${day}`);
          if (parsed.getTime() - nowDate.getTime() > 60 * 24 * 3600 * 1000) year--;
        }
        return `${year}-${mon}-${day}`;
      }
      const allDateKeys = Object.keys(sampleRow).filter((k) => normaliseDate(k) !== null);
      const normalisedDates = new Map<string, string>(allDateKeys.map((k) => [k, normaliseDate(k)!]));
      const dateKeys = [...normalisedDates.values()];

      // Build session objects in memory
      const sessionMap = new Map<string, string>(); // isoDate -> sessionId
      const sessionsToCreate: Parameters<typeof sessionRepo.save>[0][] = [];
      for (let i = 0; i < allDateKeys.length; i++) {
        const origKey = allDateKeys[i];
        if (!origKey) continue;
        const dateKey = normalisedDates.get(origKey)!;
        const sessionId = generateId();
        sessionMap.set(dateKey, sessionId);
        sessionsToCreate.push({
          id: sessionId,
          importId,
          sessionDate: dateKey,
          sessionName: dateKey,
          isRegular: true,
          isValid: true,
          totalAttendance: 0,
          sortOrder: i,
          createdAt: now,
        });
      }

      // Build student lookup from preloaded list
      const studentByName = new Map<string, typeof allStudents[0]>();
      for (const s of allStudents) {
        studentByName.set(`${s.firstName.toLowerCase()} ${s.lastName.toLowerCase()}`, s);
      }

      let studentsAdded = 0;
      let studentsUpdated = 0;
      // Map keyed by student ID — prevents duplicate-row errors when the CSV has the same
      // student appearing more than once (ON CONFLICT cannot affect same row twice)
      const studentsToSaveMap = new Map<string, Parameters<typeof studentRepo.save>[0]>();
      // Map keyed by "studentId:sessionId" — same student in multiple CSV rows could produce
      // duplicate (student_id, session_id) pairs that break the bulk ON CONFLICT INSERT
      const attendanceMap = new Map<string, Parameters<typeof attendanceRepo.saveMany>[0][number]>();

      // Process all rows in memory — compute final svcAttended/svcTotal/atRiskStatus here
      // so the final student save pass is eliminated entirely.
      for (const rawRow of rows) {
        const parsed = ServiceRowSchema.safeParse(rawRow);
        if (!parsed.success) continue;
        const row = parsed.data;
        const genderLower = row.gender.toLowerCase();
        const normalGender: 'male' | 'female' | 'other' =
          genderLower === 'f' || genderLower === 'female' ? 'female' :
          genderLower === 'm' || genderLower === 'male' ? 'male' : 'other';

        const nameKey = `${row.first_name.toLowerCase()} ${row.last_name.toLowerCase()}`;
        const existing = studentByName.get(nameKey) ?? null;

        let studentId: string;
        let baseStudent: Parameters<typeof studentRepo.save>[0];

        if (existing) {
          studentId = existing.id;
          // Non-destructive merge: contact fields and date of birth fall back to
          // the EXISTING value when the upload omits them (no column) or leaves
          // the cell blank — so a service export without a birthday column never
          // wipes a birthday we already hold. A *present* value still updates it.
          const incomingMobile = row.mobile ?? row.phone ?? null;
          const incomingParentPhone = row.parent_phone ?? row.guardian_phone ?? null;
          const incomingDob = normalizeDob(row.date_of_birth ?? row.birthday ?? null);
          baseStudent = {
            ...existing,
            grade: row.grade ?? existing.grade,
            mobile: incomingMobile ?? existing.mobile ?? null,
            parentPhone: incomingParentPhone ?? existing.parentPhone ?? null,
            dateOfBirth: incomingDob ?? existing.dateOfBirth ?? null,
            quad: computeQuad(row.grade ?? existing.grade, normalGender),
            updatedAt: now,
          };
          if (!studentsToSaveMap.has(studentId)) studentsUpdated++;
        } else {
          const grade = row.grade ?? null;
          studentId = generateId();
          baseStudent = {
            id: studentId,
            firstName: row.first_name,
            lastName: row.last_name,
            gender: normalGender,
            grade,
            quad: computeQuad(grade, normalGender),
            mobile: row.mobile ?? row.phone ?? null,
            parentPhone: row.parent_phone ?? row.guardian_phone ?? null,
            dateOfBirth: normalizeDob(row.date_of_birth ?? row.birthday ?? null),
            svcAttended: 0,
            svcTotal: 0,
            grpAttended: 0,
            grpTotal: 0,
            grpMetWeeks: 0,
            prevSvcAttended: 0,
            prevSvcTotal: 0,
            prevGrpAttended: 0,
            prevGrpTotal: 0,
            atRiskStatus: null,
            dataSource: filename,
            createdAt: now,
            updatedAt: now,
          };
          studentsAdded++;
        }

        // Record attendance for this row's date columns. Session validity
        // (>= floor) and per-student svc counts are computed in a second pass
        // below, once attendance for every session has been tallied.
        for (const [origKey, isoDate] of normalisedDates.entries()) {
          const sessionId = sessionMap.get(isoDate);
          if (!sessionId) continue;
          const val = (rawRow as Record<string, unknown>)[origKey];
          const attended = val === true || val === 'true' || val === '1' ||
            String(val).toLowerCase() === 'yes' || String(val) === 'Y';
          attendanceMap.set(`${studentId}:${sessionId}`, { studentId, sessionId, attended });
        }

        studentsToSaveMap.set(studentId, baseStudent);
        studentByName.set(nameKey, baseStudent);
      }

      // ── Second pass: which Fridays count as "valid services"? ──
      // A session counts only if the WHOLE-ministry attendance that week meets
      // the floor (default 100). Everything below — holidays, term breaks,
      // future-dated columns — is disregarded entirely.
      const minAttendance = settings.serviceMinAttendance;
      const sessionAttendedCount = new Map<string, number>();
      for (const rec of attendanceMap.values()) {
        if (rec.attended) sessionAttendedCount.set(rec.sessionId, (sessionAttendedCount.get(rec.sessionId) ?? 0) + 1);
      }
      for (const s of sessionsToCreate) {
        const cnt = sessionAttendedCount.get(s.id) ?? 0;
        s.totalAttendance = cnt;
        s.isValid = cnt >= minAttendance;
      }
      const attendanceRecords = [...attendanceMap.values()];

      // ── Term split (this term vs previous) over BOTH streams. ──
      // Service-date gaps > termGapDays set the boundaries; the SAME boundaries
      // are applied to the stored lifegroup weeks so service and group numbers
      // agree on where the term break falls. Group data is read fresh from the
      // repos (it isn't part of this service import) and re-split here.
      const [allWeeks, allLgAtt] = await Promise.all([
        lifegroupWeekRepo.findAll(),
        lifegroupAttendanceRepo.findAll(),
      ]);
      const weekStartById = new Map(allWeeks.map((w) => [w.id, w.weekStart]));
      const agg = computeStudentAggregates({
        termGapDays: settings.termGapDays,
        serviceSessions: sessionsToCreate.map((s) => ({ id: s.id, date: s.sessionDate, valid: s.isValid })),
        serviceAttendance: attendanceRecords,
        weekStartById,
        lifegroupAttendance: allLgAtt.map((r) => ({ studentId: r.studentId, weekId: r.weekId, attended: r.attended })),
      });

      // Full student save set: CSV students (identity/contact updates + any new)
      // overlaid on existing students; everyone gets the recomputed split. This is
      // the replace semantics — students absent from the CSV keep their row and
      // connections, their service counts simply fall to 0 for this term.
      const baseById = new Map<string, Student>();
      for (const s of allStudents) baseById.set(s.id, s);
      for (const [id, s] of studentsToSaveMap) baseById.set(id, s);
      const studentsToSave = applyAggregatesToStudents([...baseById.values()], agg, settings, now);

      // Replace prior service data (sessions + attendance cascade). Students and
      // connections are NOT touched.
      await attendanceRepo.deleteAll();
      await sessionRepo.deleteAll();

      // All writes — ordered to satisfy FKs, each step a single bulk SQL statement
      // 1. Import record first (service_sessions.import_id FK)
      await importRepo.save({
        id: importId, type: 'service', filename, fileHash: '',
        rowCount: rows.length, sessionsAdded: 0, studentsAdded: 0, studentsUpdated: 0,
        status: 'ok', errorMessage: null, importedAt: now, importedBy: actor.id,
      });

      // 2. Sessions + students — each a single bulk INSERT ... ON CONFLICT DO UPDATE
      await sessionRepo.saveMany(sessionsToCreate);
      await studentRepo.saveMany(studentsToSave);

      // 3. Attendance (depends on sessions + students)
      await attendanceRepo.saveMany(attendanceRecords);

      // 4. Update import record with final counts
      await importRepo.save({
        id: importId, type: 'service', filename, fileHash: '',
        rowCount: rows.length, sessionsAdded: dateKeys.length, studentsAdded, studentsUpdated,
        status: 'ok', errorMessage: null, importedAt: now, importedBy: actor.id,
      });

      invalidateTrendsCache();
      invalidateLgStatsCache();
      return { importId, type: 'service', rowCount: rows.length, studentsAdded, studentsUpdated, sessionsAdded: dateKeys.length };
    },

    async importGroupCsv(actor, payload, filename) {
      assertCan(actor, 'import:run');

      const parsed = GroupImportPayloadSchema.safeParse(payload);
      if (!parsed.success) throw new BadRequestError('Invalid group import data');

      const { groups } = parsed.data;
      if (groups.length === 0) throw new BadRequestError('No groups found in upload');

      // Replace semantics: a group import is the authoritative lifegroup dataset.
      // Clear prior lifegroup data first. Students + connections are NOT touched.
      await lifegroupAttendanceRepo.deleteAll();
      await lifegroupWeekRepo.deleteAll();
      await lifegroupRepo.deleteAll();

      const [allStudents, settings, existingLeaders] = await Promise.all([
        studentRepo.findAll(),
        settingsRepo.getSettings(),
        leaderRepo.findAll(),
      ]);

      const importId = generateId();
      const now = new Date().toISOString();
      let groupsAdded = 0, studentsAdded = 0, studentsUpdated = 0, rowCount = 0;

      const studentByName = new Map<string, typeof allStudents[0]>();
      for (const s of allStudents) studentByName.set(`${s.firstName.toLowerCase()} ${s.lastName.toLowerCase()}`, s);

      // Leaders touched by this import (created OR existing ones we augment with
      // an extra grade focus). Keyed by lowercase full name.
      const existingLeaderByName = new Map<string, typeof existingLeaders[0]>();
      for (const l of existingLeaders) existingLeaderByName.set(l.fullName.toLowerCase(), l);
      const leadersToWrite = new Map<string, Parameters<typeof leaderRepo.save>[0]>();

      // Monday-week registry, keyed PER GROUP. lifegroup_attendance's PK is
      // (student_id, week_id), so a student in two groups must get a DISTINCT
      // week_id per group — otherwise the same (student_id, week_id) appears
      // twice in one bulk insert and Postgres rejects the ON CONFLICT.
      const weekByKey = new Map<string, { id: string; weekStart: string }>();
      const ensureWeek = (lifegroupId: string, weekStart: string): string => {
        const k = `${lifegroupId}|${weekStart}`;
        let e = weekByKey.get(k);
        if (!e) { e = { id: generateId(), weekStart }; weekByKey.set(k, e); }
        return e.id;
      };

      const newLifegroups: Parameters<typeof lifegroupRepo.save>[0][] = [];
      const attendanceRecords: Parameters<typeof lifegroupAttendanceRepo.saveMany>[0] = [];
      // studentId -> running grp totals (a student can be in more than one group)
      const grpByStudent = new Map<string, { obj: Parameters<typeof studentRepo.save>[0]; attended: number; total: number }>();

      // Matches "(leader)", "(leaders)", "(assistant leader)", "(assistant leaders)".
      const LEADER_RE = /\(\s*(?:assistant\s+)?leaders?\s*\)/i;
      const LEADER_RE_G = /\(\s*(?:assistant\s+)?leaders?\s*\)/ig;

      for (const group of groups) {
        const { grade: gGrade, gender: gGender } = parseGroupName(group.name);
        // Lifegroup is always created fresh (we cleared above).
        const lifegroup = {
          id: generateId(),
          fullName: group.name,
          shortName: group.name.replace(/^[^-]+-\s*/u, '').slice(0, 40).trim(),
          grade: gGrade,
          gender: gGender,
          createdAt: now,
        };
        newLifegroups.push(lifegroup);
        groupsAdded++;

        const weekOfIdx = group.meetings.map((d) => weekStartOf(d));

        // Split roll into leaders ("(leader)" in the name) vs youth members.
        const youthMembers: typeof group.members = [];
        for (const member of group.members) {
          if (LEADER_RE.test(`${member.first_name} ${member.last_name}`)) {
            const cleanFirst = member.first_name.replace(LEADER_RE_G, ' ').replace(/\s+/g, ' ').trim();
            const cleanLast = member.last_name.replace(LEADER_RE_G, ' ').replace(/\s+/g, ' ').trim();
            const fullName = `${cleanFirst} ${cleanLast}`.replace(/\s+/g, ' ').trim();
            if (!fullName) continue;
            const key = fullName.toLowerCase();
            let lead = leadersToWrite.get(key);
            if (!lead) {
              const existing = existingLeaderByName.get(key);
              lead = existing
                ? { ...existing, grades: [...existing.grades], gender: existing.gender ?? gGender, updatedAt: now }
                : { id: generateId(), fullName, gender: gGender, grades: [] as unknown as Parameters<typeof leaderRepo.save>[0]['grades'], active: true, createdByGrade: null, createdAt: now, updatedAt: now };
              leadersToWrite.set(key, lead);
            }
            // Accumulate grade focus: a leader appearing in more than one grade's
            // lifegroup gets every grade assigned.
            const grades = lead.grades as unknown as number[];
            if (gGrade != null && !grades.includes(gGrade)) { grades.push(gGrade); grades.sort((a, b) => a - b); }
            if (!lead.gender && gGender) lead.gender = gGender;
            continue; // leaders are not youth attendees
          }
          youthMembers.push(member);
        }

        // Weeks the GROUP ran = weeks where >=1 youth member has a non-null mark.
        const weeksRan = new Set<string>();
        for (const member of youthMembers) {
          for (let i = 0; i < member.attendance.length; i++) {
            const a = member.attendance[i];
            if (a === null || a === undefined) continue;
            const w = weekOfIdx[i];
            if (w) weeksRan.add(w);
          }
        }
        const weeksRanList = [...weeksRan];
        const totalWeeksRan = weeksRanList.length;

        for (const member of youthMembers) {
          // Weeks this member actually attended (>=1 "true" that week). A member
          // listed on the roll but who attended 0 weeks is NOT part of the group
          // — skip them entirely (no student created, no grp counts).
          const attendedWeeks = new Set<string>();
          for (let i = 0; i < member.attendance.length; i++) {
            if (member.attendance[i] === true) { const w = weekOfIdx[i]; if (w) attendedWeeks.add(w); }
          }
          if (attendedWeeks.size === 0) continue;

          rowCount++;
          const nameKey = `${member.first_name.toLowerCase()} ${member.last_name.toLowerCase()}`;
          let student = studentByName.get(nameKey) ?? null;
          if (!student) {
            student = {
              id: generateId(),
              firstName: member.first_name,
              lastName: member.last_name,
              gender: 'other',
              grade: null,
              quad: null,
              mobile: null,
              parentPhone: null,
              dateOfBirth: null,
              svcAttended: 0,
              svcTotal: 0,
              grpAttended: 0,
              grpTotal: 0,
              grpMetWeeks: 0,
              prevSvcAttended: 0,
              prevSvcTotal: 0,
              prevGrpAttended: 0,
              prevGrpTotal: 0,
              atRiskStatus: null,
              dataSource: filename,
              createdAt: now,
              updatedAt: now,
            };
            studentByName.set(nameKey, student);
            studentsAdded++;
          } else {
            studentsUpdated++;
          }
          const studentId = student.id;

          // One attendance row per week the group ran (binary attended-that-week).
          for (const w of weeksRanList) {
            attendanceRecords.push({
              studentId,
              weekId: ensureWeek(lifegroup.id, w),
              lifegroupId: lifegroup.id,
              groupMet: true,
              attended: attendedWeeks.has(w),
            });
          }

          const prev = grpByStudent.get(studentId);
          const attendedCount = weeksRanList.filter((w) => attendedWeeks.has(w)).length;
          grpByStudent.set(studentId, {
            obj: student,
            attended: (prev?.attended ?? 0) + attendedCount,
            total: (prev?.total ?? 0) + totalWeeksRan,
          });
        }
      }

      // Week rows from the per-group registry (chronological week numbers).
      let weekNum = 0;
      const weeksToCreate = [...weekByKey.values()]
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
        .map(({ id, weekStart }) => ({ id, importId, weekNum: ++weekNum, weekKey: weekStart, weekStart, weekEnd: null }));
      const weeksAdded = weeksToCreate.length;

      // Final guard: one row per (student, week_id) — protects the PK against a
      // duplicate name within a single group's roll.
      const seenAtt = new Set<string>();
      const dedupedAttendance = attendanceRecords.filter((r) => {
        const k = `${r.studentId}:${r.weekId}`;
        if (seenAtt.has(k)) return false;
        seenAtt.add(k);
        return true;
      });

      // ── Term split over BOTH streams. Lifegroup weeks split by the SAME
      // boundaries the service dates define; service data is read fresh from the
      // repos and re-split so its current/previous counts stay consistent with
      // this group import. Members get their group counts; everyone else falls to
      // 0 group (replace semantics) — all via one uniform recompute. ──
      const [allSessions, allSvcAtt] = await Promise.all([
        sessionRepo.findAll(),
        attendanceRepo.findAll(),
      ]);
      const weekStartById = new Map(weeksToCreate.map((w) => [w.id, w.weekStart]));
      const agg = computeStudentAggregates({
        termGapDays: settings.termGapDays,
        serviceSessions: allSessions.map((s) => ({ id: s.id, date: s.sessionDate, valid: s.isValid })),
        serviceAttendance: allSvcAtt.map((r) => ({ studentId: r.studentId, sessionId: r.sessionId, attended: r.attended })),
        weekStartById,
        lifegroupAttendance: dedupedAttendance.map((r) => ({ studentId: r.studentId, weekId: r.weekId, attended: r.attended })),
      });
      const baseById = new Map<string, Student>();
      for (const s of allStudents) baseById.set(s.id, s);
      for (const { obj } of grpByStudent.values()) baseById.set(obj.id, obj);
      const studentsToSave = applyAggregatesToStudents([...baseById.values()], agg, settings, now);

      // Writes, FK-safe order.
      await importRepo.save({ id: importId, type: 'lifegroup', filename, fileHash: '', rowCount: 0, sessionsAdded: 0, studentsAdded: 0, studentsUpdated: 0, status: 'ok', errorMessage: null, importedAt: now, importedBy: actor.id });
      // Leader saves are independent — run in parallel instead of sequentially.
      await Promise.all([...leadersToWrite.values()].map((l) => leaderRepo.save(l)));
      await lifegroupRepo.saveMany(newLifegroups);
      await lifegroupWeekRepo.saveMany(weeksToCreate);
      await studentRepo.saveMany(studentsToSave);
      if (dedupedAttendance.length > 0) await lifegroupAttendanceRepo.saveMany(dedupedAttendance);
      await importRepo.save({ id: importId, type: 'lifegroup', filename, fileHash: '', rowCount, sessionsAdded: weeksAdded, studentsAdded, studentsUpdated, status: 'ok', errorMessage: null, importedAt: now, importedBy: actor.id });

      invalidateTrendsCache();
      invalidateLgStatsCache();
      return { importId, type: 'lifegroup', rowCount, groupsAdded, studentsAdded, studentsUpdated, weeksAdded };
    },

    async deleteImport(actor, id) {
      assertCan(actor, 'import:run');
      await importRepo.delete(id);
    },

    async clearHistory(actor) {
      assertCan(actor, 'admin:manage');
      const all = await importRepo.findAll();
      for (const r of all) await importRepo.delete(r.id);
    },
  };
}
