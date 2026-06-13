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
  // Contact fields — all optional; column may be absent entirely
  mobile: z.string().optional(),
  phone: z.string().optional(),           // alias for mobile
  parent_phone: z.string().optional(),
  guardian_phone: z.string().optional(),  // alias for parent_phone
  date_of_birth: z.string().optional(),
  birthday: z.string().optional(),        // alias for date_of_birth
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
      // Sort by importedAt descending
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

      const settings = await settingsRepo.getSettings();
      const importId = generateId();
      const now = new Date().toISOString();

      // Detect session date columns — supports both ISO (YYYY-MM-DD) and
      // Excel-exported short dates (DD-MMM or D-MMM, e.g. "7-Feb", "14-Mar").
      // Excel exports omit the year; we infer it as the current calendar year
      // (or previous year if the month appears to be in the future, avoiding
      // "Feb" in January being interpreted as next February).
      const sampleRow = rows[0] as Record<string, unknown>;
      const MONTH_MAP: Record<string, string> = {
        jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
        jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
      };
      function normaliseDate(key: string): string | null {
        if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
        // Excel short-date: "7-Feb", "14-Mar", "7-Feb-25" etc.
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
          // If the parsed month is more than 2 months in the future assume previous year
          const parsed = new Date(`${year}-${mon}-${day}`);
          if (parsed.getTime() - nowDate.getTime() > 60 * 24 * 3600 * 1000) year--;
        }
        return `${year}-${mon}-${day}`;
      }
      const allDateKeys = Object.keys(sampleRow).filter(
        (k) => normaliseDate(k) !== null,
      );
      // Map from original header -> normalised ISO date
      const normalisedDates = new Map<string, string>(
        allDateKeys.map((k) => [k, normaliseDate(k)!]),
      );
      const dateKeys = [...normalisedDates.values()];

      // Save import record FIRST — service_sessions.import_id has FK to import_records.id
      await importRepo.save({
        id: importId,
        type: 'service',
        filename,
        fileHash: '',
        rowCount: rows.length,
        sessionsAdded: 0,
        studentsAdded: 0,
        studentsUpdated: 0,
        status: 'ok',
        errorMessage: null,
        importedAt: now,
        importedBy: actor.id,
      });

      // Create service sessions for each date column
      const sessionMap = new Map<string, string>(); // normalisedDate -> sessionId
      for (let i = 0; i < allDateKeys.length; i++) {
        const origKey = allDateKeys[i];
        if (!origKey) continue;
        const dateKey = normalisedDates.get(origKey)!;
        const sessionId = generateId();
        sessionMap.set(dateKey, sessionId);
        await sessionRepo.save({
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

      // Load ALL students once — avoids one full-table scan per CSV row
      const allStudents = await studentRepo.findAll();
      const studentByName = new Map<string, typeof allStudents[0]>();
      for (const s of allStudents) {
        studentByName.set(`${s.firstName.toLowerCase()} ${s.lastName.toLowerCase()}`, s);
      }

      let studentsAdded = 0;
      let studentsUpdated = 0;
      const studentAttendance = new Map<string, { attended: number; total: number }>();
      // Track objects so final update pass avoids a findById per student
      const studentObjects = new Map<string, typeof allStudents[0]>();
      const attendanceRecords: Array<{ studentId: string; sessionId: string; attended: boolean }> = [];

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
        if (existing) {
          studentId = existing.id;
          const incomingMobile = row.mobile ?? row.phone ?? null;
          const incomingParentPhone = row.parent_phone ?? row.guardian_phone ?? null;
          const incomingDob = row.date_of_birth ?? row.birthday ?? null;
          const updated = {
            ...existing,
            grade: row.grade ?? existing.grade,
            mobile: incomingMobile ?? existing.mobile ?? null,
            parentPhone: incomingParentPhone ?? existing.parentPhone ?? null,
            dateOfBirth: incomingDob ?? existing.dateOfBirth ?? null,
            quad: computeQuad(row.grade ?? existing.grade, normalGender),
            updatedAt: now,
          };
          await studentRepo.save(updated);
          studentsUpdated++;
          studentAttendance.set(studentId, {
            attended: existing.svcAttended,
            total: existing.svcTotal,
          });
          studentObjects.set(studentId, updated);
          studentByName.set(nameKey, updated);
        } else {
          const grade = row.grade ?? null;
          studentId = generateId();
          const newStudent = {
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
          await studentRepo.save(newStudent);
          studentsAdded++;
          studentAttendance.set(studentId, { attended: 0, total: 0 });
          studentObjects.set(studentId, newStudent);
          studentByName.set(nameKey, newStudent);
        }

        // Collect attendance records and track aggregation.
        // Iterate over the original header keys so rawRow lookup uses the unmodified key.
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

        // Aggregate new sessions into student totals
        const agg = studentAttendance.get(studentId) ?? { attended: 0, total: 0 };
        studentAttendance.set(studentId, {
          attended: agg.attended + sessionAttended,
          total: agg.total + sessionTotal,
        });
      }

      await attendanceRepo.saveMany(attendanceRecords);

      // Write aggregated attendance counts back to students and recompute at-risk.
      // Uses tracked objects — no findById round-trips needed.
      const riskN = settings.riskRateNumerator;
      const riskD = settings.riskRateDenominator;
      const regN = settings.regRateNumerator;
      const regD = settings.regRateDenominator;

      for (const [studentId, agg] of studentAttendance.entries()) {
        const s = studentObjects.get(studentId);
        if (!s) continue;
        const svcRate = agg.total > 0 ? agg.attended / agg.total : null;
        const atRiskStatus: 'regular' | 'new' | 'declining' | 'atrisk' | 'stopped' =
          agg.total === 0 ? 'new' :
          agg.attended === 0 && agg.total >= 3 ? 'stopped' :
          svcRate !== null && svcRate < riskN / riskD ? 'atrisk' :
          svcRate !== null && svcRate < regN / regD ? 'declining' : 'regular';
        await studentRepo.save({
          ...s,
          svcAttended: agg.attended,
          svcTotal: agg.total,
          atRiskStatus,
          updatedAt: now,
        });
      }

      // Update import record with final counts
      await importRepo.save({
        id: importId,
        type: 'service',
        filename,
        fileHash: '',
        rowCount: rows.length,
        sessionsAdded: dateKeys.length,
        studentsAdded,
        studentsUpdated,
        status: 'ok',
        errorMessage: null,
        importedAt: now,
        importedBy: actor.id,
      });

      return { importId, type: 'service', rowCount: rows.length, studentsAdded, studentsUpdated, sessionsAdded: dateKeys.length };
    },

    async importGroupCsv(actor, payload, filename) {
      assertCan(actor, 'import:run');

      const parsed = GroupImportPayloadSchema.safeParse(payload);
      if (!parsed.success) throw new BadRequestError('Invalid group import data');

      const { groups } = parsed.data;
      if (groups.length === 0) throw new BadRequestError('No groups found in upload');

      const importId = generateId();
      const now = new Date().toISOString();
      let groupsAdded = 0;
      let studentsAdded = 0;
      let studentsUpdated = 0;
      let weeksAdded = 0;
      let rowCount = 0;

      // Save import record FIRST — lifegroup_weeks.import_id has FK to import_records.id
      await importRepo.save({
        id: importId,
        type: 'lifegroup',
        filename,
        fileHash: '',
        rowCount: 0,
        sessionsAdded: 0,
        studentsAdded: 0,
        studentsUpdated: 0,
        status: 'ok',
        errorMessage: null,
        importedAt: now,
        importedBy: actor.id,
      });

      // Load ALL students and lifegroups once upfront — avoids N+1 queries
      const allStudents = await studentRepo.findAll();
      const studentByName = new Map<string, typeof allStudents[0]>();
      for (const s of allStudents) {
        studentByName.set(`${s.firstName.toLowerCase()} ${s.lastName.toLowerCase()}`, s);
      }
      const allExistingGroups = await lifegroupRepo.findAll();

      const studentGrpAgg = new Map<string, { attended: number; total: number; metWeeks: number }>();
      const studentObjects = new Map<string, typeof allStudents[0]>();
      const allAttendanceRecords: Array<{
        studentId: string; weekId: string; lifegroupId: string; groupMet: boolean; attended: boolean;
      }> = [];

      for (const group of groups) {
        // Find or create lifegroup (using preloaded list)
        let lifegroup = allExistingGroups.find((g) => g.fullName === group.name) ?? null;
        if (!lifegroup) {
          const { grade, gender } = parseGroupName(group.name);
          lifegroup = await lifegroupRepo.save({
            id: generateId(),
            fullName: group.name,
            shortName: group.name.replace(/^[^-]+-\s*/u, '').slice(0, 40).trim(),
            grade,
            gender,
            createdAt: now,
          });
          allExistingGroups.push(lifegroup);
          groupsAdded++;
        }

        // Create LifegroupWeek for each meeting date
        const weekMap = new Map<string, string>(); // ISO date -> weekId
        for (let i = 0; i < group.meetings.length; i++) {
          const isoDate = group.meetings[i]!;
          const weekId = generateId();
          await lifegroupWeekRepo.save({
            id: weekId,
            importId,
            weekNum: i + 1,
            weekKey: isoDate,
            weekStart: isoDate,
            weekEnd: null,
          });
          weekMap.set(isoDate, weekId);
          weeksAdded++;
        }

        // Process each member
        for (const member of group.members) {
          rowCount++;

          const nameKey = `${member.first_name.toLowerCase()} ${member.last_name.toLowerCase()}`;
          const existing = studentByName.get(nameKey) ?? null;

          let studentId: string;
          if (existing) {
            studentId = existing.id;
            studentsUpdated++;
            if (!studentGrpAgg.has(studentId)) {
              studentGrpAgg.set(studentId, {
                attended: existing.grpAttended,
                total: existing.grpTotal,
                metWeeks: existing.grpMetWeeks,
              });
              studentObjects.set(studentId, existing);
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
            await studentRepo.save(newStudent);
            studentsAdded++;
            studentGrpAgg.set(studentId, { attended: 0, total: 0, metWeeks: 0 });
            studentObjects.set(studentId, newStudent);
            studentByName.set(nameKey, newStudent);
          }

          // Accumulate attendance for this member across this group's meetings
          let memberAttended = 0;
          let memberTotal = 0;
          for (let i = 0; i < group.meetings.length; i++) {
            const att = member.attendance[i];
            if (att === null || att === undefined) continue; // not a member this date
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

          const agg = studentGrpAgg.get(studentId)!;
          studentGrpAgg.set(studentId, {
            attended: agg.attended + memberAttended,
            total: agg.total + memberTotal,
            metWeeks: agg.metWeeks + memberTotal,
          });
        }
      }

      // Save all attendance in a single bulk call
      if (allAttendanceRecords.length > 0) {
        await lifegroupAttendanceRepo.saveMany(allAttendanceRecords);
      }

      // Write aggregated group attendance back to each affected student.
      // Uses tracked objects — no findById round-trips needed.
      for (const [studentId, agg] of studentGrpAgg.entries()) {
        const s = studentObjects.get(studentId);
        if (!s) continue;
        await studentRepo.save({
          ...s,
          grpAttended: agg.attended,
          grpTotal: agg.total,
          grpMetWeeks: agg.metWeeks,
          updatedAt: now,
        });
      }

      // Update import record with final counts
      await importRepo.save({
        id: importId,
        type: 'lifegroup',
        filename,
        fileHash: '',
        rowCount,
        sessionsAdded: weeksAdded,
        studentsAdded,
        studentsUpdated,
        status: 'ok',
        errorMessage: null,
        importedAt: now,
        importedBy: actor.id,
      });

      return { importId, type: 'lifegroup', rowCount, groupsAdded, studentsAdded, studentsUpdated, weeksAdded };
    },
  };
}
