import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan } from './access-control';
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
import { computeQuad } from '../core/types/enums';
import { BadRequestError } from '../core/errors/app-error';
import { computeStatus } from './atrisk.service';

// A "week" runs Monday→Sunday — the calendar week that contains that week's
// Friday service. Map any meeting date to the Monday on/before it so lifegroup
// attendance is bucketed per week (a group that meets twice in a week counts as
// one week).
function weekStartOf(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return isoDate;
  const offset = (d.getUTCDay() + 6) % 7; // days since this week's Monday
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

      const riskN = settings.riskRateNumerator;
      const riskD = settings.riskRateDenominator;
      const regN = settings.regRateNumerator;
      const regD = settings.regRateDenominator;

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
      const validSessions = new Set<string>();
      for (const s of sessionsToCreate) {
        const cnt = sessionAttendedCount.get(s.id) ?? 0;
        s.totalAttendance = cnt;
        s.isValid = cnt >= minAttendance;
        if (s.isValid) validSessions.add(s.id);
      }
      const validTotal = validSessions.size;

      // Per-student attendance counted over valid services only.
      const validAttendedByStudent = new Map<string, number>();
      for (const rec of attendanceMap.values()) {
        if (rec.attended && validSessions.has(rec.sessionId)) {
          validAttendedByStudent.set(rec.studentId, (validAttendedByStudent.get(rec.studentId) ?? 0) + 1);
        }
      }

      // Finalise svc counts (attended / valid services) + at-risk (from svc AND
      // group) for students in this import. Same definition overview, at-risk and
      // the Connection Audit 'Regular' stage all read from.
      for (const [sid, stu] of studentsToSaveMap) {
        const svcAttended = validAttendedByStudent.get(sid) ?? 0;
        studentsToSaveMap.set(sid, {
          ...stu,
          svcAttended,
          svcTotal: validTotal,
          atRiskStatus: computeStatus(svcAttended, validTotal, stu.grpAttended, stu.grpTotal, settings),
        });
      }

      // Replace semantics: existing students NOT in this import keep their row and
      // all connections, but their service counts reset to 0 (no attendance in the
      // new data). At-risk recomputed from their group data.
      const studentsToSave = [...studentsToSaveMap.values()];
      const inFile = new Set(studentsToSaveMap.keys());
      for (const s of allStudents) {
        if (inFile.has(s.id)) continue;
        studentsToSave.push({
          ...s,
          svcAttended: 0,
          svcTotal: validTotal,
          atRiskStatus: computeStatus(0, validTotal, s.grpAttended, s.grpTotal, settings),
          updatedAt: now,
        });
      }
      const attendanceRecords = [...attendanceMap.values()];

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

      // Students to save: members (new grp counts) + everyone else (grp reset to 0,
      // replace semantics). At-risk recomputed from svc (unchanged) + new grp.
      const inGroup = new Set(grpByStudent.keys());
      const studentsToSave: Parameters<typeof studentRepo.save>[0][] = [];
      for (const { obj, attended, total } of grpByStudent.values()) {
        studentsToSave.push({
          ...obj,
          grpAttended: attended,
          grpTotal: total,
          grpMetWeeks: total,
          atRiskStatus: computeStatus(obj.svcAttended, obj.svcTotal, attended, total, settings),
          updatedAt: now,
        });
      }
      for (const s of allStudents) {
        if (inGroup.has(s.id)) continue;
        studentsToSave.push({
          ...s,
          grpAttended: 0,
          grpTotal: 0,
          grpMetWeeks: 0,
          atRiskStatus: computeStatus(s.svcAttended, s.svcTotal, 0, 0, settings),
          updatedAt: now,
        });
      }

      // Writes, FK-safe order.
      await importRepo.save({ id: importId, type: 'lifegroup', filename, fileHash: '', rowCount: 0, sessionsAdded: 0, studentsAdded: 0, studentsUpdated: 0, status: 'ok', errorMessage: null, importedAt: now, importedBy: actor.id });
      for (const l of leadersToWrite.values()) await leaderRepo.save(l);
      await lifegroupRepo.saveMany(newLifegroups);
      await lifegroupWeekRepo.saveMany(weeksToCreate);
      await studentRepo.saveMany(studentsToSave);
      // Final guard: one row per (student, week_id) — protects the PK against a
      // duplicate name within a single group's roll.
      const seenAtt = new Set<string>();
      const dedupedAttendance = attendanceRecords.filter((r) => {
        const k = `${r.studentId}:${r.weekId}`;
        if (seenAtt.has(k)) return false;
        seenAtt.add(k);
        return true;
      });
      if (dedupedAttendance.length > 0) await lifegroupAttendanceRepo.saveMany(dedupedAttendance);
      await importRepo.save({ id: importId, type: 'lifegroup', filename, fileHash: '', rowCount, sessionsAdded: weeksAdded, studentsAdded, studentsUpdated, status: 'ok', errorMessage: null, importedAt: now, importedBy: actor.id });

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
