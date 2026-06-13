import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan } from './access-control';
import type {
  IStudentRepository,
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
      const studentsToSave: Parameters<typeof studentRepo.save>[0][] = [];
      const attendanceRecords: Parameters<typeof attendanceRepo.saveMany>[0] = [];

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
        let prevAttended: number;
        let prevTotal: number;
        let baseStudent: Parameters<typeof studentRepo.save>[0];

        if (existing) {
          studentId = existing.id;
          prevAttended = existing.svcAttended;
          prevTotal = existing.svcTotal;
          const incomingMobile = row.mobile ?? row.phone ?? null;
          const incomingParentPhone = row.parent_phone ?? row.guardian_phone ?? null;
          const incomingDob = row.date_of_birth ?? row.birthday ?? null;
          baseStudent = {
            ...existing,
            grade: row.grade ?? existing.grade,
            mobile: incomingMobile ?? existing.mobile ?? null,
            parentPhone: incomingParentPhone ?? existing.parentPhone ?? null,
            dateOfBirth: incomingDob ?? existing.dateOfBirth ?? null,
            quad: computeQuad(row.grade ?? existing.grade, normalGender),
            updatedAt: now,
          };
          studentsUpdated++;
        } else {
          const grade = row.grade ?? null;
          studentId = generateId();
          prevAttended = 0;
          prevTotal = 0;
          baseStudent = {
            id: studentId,
            firstName: row.first_name,
            lastName: row.last_name,
            gender: normalGender,
            grade,
            quad: computeQuad(grade, normalGender),
            mobile: row.mobile ?? row.phone ?? null,
            parentPhone: row.parent_phone ?? row.guardian_phone ?? null,
            dateOfBirth: row.date_of_birth ?? row.birthday ?? null,
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

        // Count attendance from this row's date columns
        let sessionAttended = 0;
        let sessionTotal = 0;
        for (const [origKey, isoDate] of normalisedDates.entries()) {
          const sessionId = sessionMap.get(isoDate);
          if (!sessionId) continue;
          const val = (rawRow as Record<string, unknown>)[origKey];
          const attended = val === true || val === 'true' || val === '1' ||
            String(val).toLowerCase() === 'yes' || String(val) === 'Y';
          attendanceRecords.push({ studentId, sessionId, attended });
          sessionTotal++;
          if (attended) sessionAttended++;
        }

        // Compute final svc counts and at-risk status — no second pass needed
        const finalAttended = prevAttended + sessionAttended;
        const finalTotal = prevTotal + sessionTotal;
        const svcRate = finalTotal > 0 ? finalAttended / finalTotal : null;
        const atRiskStatus: 'regular' | 'new' | 'declining' | 'atrisk' | 'stopped' =
          finalTotal === 0 ? 'new' :
          finalAttended === 0 && finalTotal >= 3 ? 'stopped' :
          svcRate !== null && svcRate < riskN / riskD ? 'atrisk' :
          svcRate !== null && svcRate < regN / regD ? 'declining' : 'regular';

        studentsToSave.push({ ...baseStudent, svcAttended: finalAttended, svcTotal: finalTotal, atRiskStatus });
        studentByName.set(nameKey, { ...baseStudent, svcAttended: finalAttended, svcTotal: finalTotal, atRiskStatus });
      }

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

      // Two reads upfront — parallel
      const [allStudents, allExistingGroups] = await Promise.all([
        studentRepo.findAll(),
        lifegroupRepo.findAll(),
      ]);

      const importId = generateId();
      const now = new Date().toISOString();
      let groupsAdded = 0;
      let studentsAdded = 0;
      let studentsUpdated = 0;
      let weeksAdded = 0;
      let rowCount = 0;

      // Build student lookup
      const studentByName = new Map<string, typeof allStudents[0]>();
      for (const s of allStudents) {
        studentByName.set(`${s.firstName.toLowerCase()} ${s.lastName.toLowerCase()}`, s);
      }

      // Process everything in memory first
      const newLifegroups: Parameters<typeof lifegroupRepo.save>[0][] = [];
      const weeksToCreate: Parameters<typeof lifegroupWeekRepo.save>[0][] = [];
      const allAttendanceRecords: Parameters<typeof lifegroupAttendanceRepo.saveMany>[0] = [];

      // Tracks final grp counts + the student object for each affected student
      const studentGrpData = new Map<string, {
        obj: Parameters<typeof studentRepo.save>[0];
        agg: { attended: number; total: number; metWeeks: number };
      }>();

      for (const group of groups) {
        // Find or create lifegroup (fully in-memory, no extra round trip)
        let lifegroup = allExistingGroups.find((g) => g.fullName === group.name) ?? null;
        if (!lifegroup) {
          const { grade, gender } = parseGroupName(group.name);
          lifegroup = {
            id: generateId(),
            fullName: group.name,
            shortName: group.name.replace(/^[^-]+-\s*/u, '').slice(0, 40).trim(),
            grade,
            gender,
            createdAt: now,
          };
          newLifegroups.push(lifegroup);
          allExistingGroups.push(lifegroup);
          groupsAdded++;
        }

        // Build week objects in memory
        const weekMap = new Map<string, string>(); // isoDate -> weekId
        for (let i = 0; i < group.meetings.length; i++) {
          const isoDate = group.meetings[i]!;
          const weekId = generateId();
          weekMap.set(isoDate, weekId);
          weeksToCreate.push({
            id: weekId,
            importId,
            weekNum: i + 1,
            weekKey: isoDate,
            weekStart: isoDate,
            weekEnd: null,
          });
          weeksAdded++;
        }

        for (const member of group.members) {
          rowCount++;

          const nameKey = `${member.first_name.toLowerCase()} ${member.last_name.toLowerCase()}`;
          const existing = studentByName.get(nameKey) ?? null;
          let studentId: string;

          if (existing) {
            studentId = existing.id;
            studentsUpdated++;
            if (!studentGrpData.has(studentId)) {
              studentGrpData.set(studentId, {
                obj: existing,
                agg: { attended: existing.grpAttended, total: existing.grpTotal, metWeeks: existing.grpMetWeeks },
              });
            }
          } else {
            studentId = generateId();
            const newStudent = {
              id: studentId,
              firstName: member.first_name,
              lastName: member.last_name,
              gender: 'other' as const,
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
            studentsAdded++;
            studentGrpData.set(studentId, { obj: newStudent, agg: { attended: 0, total: 0, metWeeks: 0 } });
            studentByName.set(nameKey, newStudent);
          }

          // Accumulate attendance for this member
          let memberAttended = 0;
          let memberTotal = 0;
          for (let i = 0; i < group.meetings.length; i++) {
            const att = member.attendance[i];
            if (att === null || att === undefined) continue;
            const isoDate = group.meetings[i]!;
            const weekId = weekMap.get(isoDate);
            if (!weekId) continue;
            allAttendanceRecords.push({
              studentId,
              weekId,
              lifegroupId: lifegroup.id,
              groupMet: true,
              attended: att,
            });
            memberTotal++;
            if (att) memberAttended++;
          }

          const entry = studentGrpData.get(studentId)!;
          studentGrpData.set(studentId, {
            obj: entry.obj,
            agg: {
              attended: entry.agg.attended + memberAttended,
              total: entry.agg.total + memberTotal,
              metWeeks: entry.agg.metWeeks + memberTotal,
            },
          });
        }
      }

      // Build final student save list — one save per student with final grp counts
      const studentsToSave = [...studentGrpData.values()].map(({ obj, agg }) => ({
        ...obj,
        grpAttended: agg.attended,
        grpTotal: agg.total,
        grpMetWeeks: agg.metWeeks,
        updatedAt: now,
      }));

      // All writes — ordered to satisfy FKs, each step a single bulk SQL statement
      // 1. Import record first (lifegroup_weeks.import_id FK)
      await importRepo.save({
        id: importId, type: 'lifegroup', filename, fileHash: '',
        rowCount: 0, sessionsAdded: 0, studentsAdded: 0, studentsUpdated: 0,
        status: 'ok', errorMessage: null, importedAt: now, importedBy: actor.id,
      });

      // 2. New lifegroups (few, individual saves fine); then bulk weeks + students
      for (const g of newLifegroups) await lifegroupRepo.save(g);
      await lifegroupWeekRepo.saveMany(weeksToCreate);
      await studentRepo.saveMany(studentsToSave);

      // 3. Attendance (depends on lifegroups + weeks + students)
      if (allAttendanceRecords.length > 0) {
        await lifegroupAttendanceRepo.saveMany(allAttendanceRecords);
      }

      // 4. Update import record with final counts
      await importRepo.save({
        id: importId, type: 'lifegroup', filename, fileHash: '',
        rowCount, sessionsAdded: weeksAdded, studentsAdded, studentsUpdated,
        status: 'ok', errorMessage: null, importedAt: now, importedBy: actor.id,
      });

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
