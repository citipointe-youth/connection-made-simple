import { z } from 'zod';
import { generateId } from '../utils/id';
import { assertCan, canAccessStudent, canAccessGeneralPrayer, generalPrayerCreatorScope,
  type StructureScope } from './access-control';
import { MINISTRY_CONFIG_DEFAULTS } from '../core/ministry-config';
import type { IPrayerRepository, IStudentRepository, ISettingsRepository,
  IConnectionRepository } from '../repositories/interfaces/entity-repositories';
import type { PrayerRequest, PrayerWithStudent } from '../core/entities/prayer';
import type { Student } from '../core/entities/student';
import type { Actor } from '../core/entities/user';
import { NotFoundError, ForbiddenError } from '../core/errors/app-error';
import { buildPrayerCsvRows, parsePrayerRows, planPrayerImport,
  type PrayerCsvRow, type PrayerImportReport } from './prayer-allocations';

const CreateSchema = z.object({
  studentId: z.string().min(1).nullable().optional(),
  text: z.string().min(1).max(1000),
  createdByLabel: z.string().max(120).optional(),
});
const UpdateSchema = z.object({
  text: z.string().min(1).max(1000).optional(),
  answerNote: z.string().max(1000).nullable().optional(),
});
const StatusSchema = z.object({
  status: z.enum(['open', 'answered', 'archived']),
  answerNote: z.string().max(1000).nullable().optional(),
});

export interface PrayerService {
  list(actor: Actor): Promise<PrayerWithStudent[]>;
  listByStudent(actor: Actor, studentId: string): Promise<PrayerRequest[]>;
  create(actor: Actor, input: unknown): Promise<PrayerRequest>;
  update(actor: Actor, id: string, input: unknown): Promise<PrayerRequest>;
  setStatus(actor: Actor, id: string, input: unknown): Promise<PrayerRequest>;
  remove(actor: Actor, id: string): Promise<void>;
  exportCsv(actor: Actor): Promise<PrayerCsvRow[]>;
  importCsv(actor: Actor, rows: unknown): Promise<PrayerImportReport>;
}

function summary(s: Student): PrayerWithStudent['student'] {
  return { id: s.id, firstName: s.firstName, lastName: s.lastName, grade: s.grade, gender: s.gender };
}

export function makePrayerService(
  repo: IPrayerRepository,
  studentRepo: IStudentRepository,
  settingsRepo?: ISettingsRepository,
  connRepo?: IConnectionRepository,
): PrayerService {
  async function structureScope(): Promise<StructureScope> {
    if (!settingsRepo) return MINISTRY_CONFIG_DEFAULTS.structure;
    return (await settingsRepo.getSettings()).ministryConfig.structure;
  }

  // A junior leader (§5.2) has no grade/gender of their own — canAccessStudent
  // always returns false for role 'leader' (it isn't one of canAccessGrade's
  // cases), so scope them the same way every other service does: via their own
  // connections, not grade/gender.
  async function canLeaderAccessStudent(actor: Actor, studentId: string): Promise<boolean> {
    if (!connRepo || !actor.leaderId) return false;
    return (await connRepo.findByStudentAndLeader(studentId, actor.leaderId)) != null;
  }

  // Load the student a prayer is for and assert the actor may access them. A
  // null studentId (a general/whole-group prayer) has no scope to resolve —
  // it's visible to anyone with prayer:read, so this is a no-op for it.
  async function studentInScope(actor: Actor, studentId: string | null, structure: StructureScope): Promise<Student | null> {
    if (studentId == null) return null;
    const s = await studentRepo.findById(studentId);
    if (!s) throw new NotFoundError('Student not found');
    const allowed = actor.role === 'leader'
      ? await canLeaderAccessStudent(actor, studentId)
      : canAccessStudent(actor, s.grade, s.gender, structure);
    if (!allowed) throw new ForbiddenError('Access denied to this student');
    return s;
  }

  async function loadInScope(actor: Actor, id: string, structure: StructureScope): Promise<PrayerRequest> {
    const p = await repo.findById(id);
    if (!p) throw new NotFoundError('Prayer not found');
    if (p.studentId == null) {
      // General prayer: same visibility rule as list() applies to edit/delete/
      // mark-answered too, not just reads — otherwise a grade/quad actor could
      // act on a general prayer outside their own domain that they can't even
      // see, by guessing/enumerating its id. A junior `leader` (H2, 2026-07-19)
      // can therefore only act on unscoped general prayers (own + admin/
      // director's) — a stricter "only the ones THEY created" write restriction
      // isn't possible here since PrayerRequest stores a creator SCOPE, not a
      // creator id.
      if (!canAccessGeneralPrayer(actor, p.createdByGrades, p.createdByGender, structure)) {
        throw new ForbiddenError('Access denied to this prayer');
      }
    } else {
      await studentInScope(actor, p.studentId, structure); // throws Forbidden if out of scope
    }
    return p;
  }

  return {
    async list(actor) {
      assertCan(actor, 'prayer:read');
      const [all, students, structure] = await Promise.all([
        repo.findAll(), studentRepo.findAll(), structureScope(),
      ]);
      const byId = new Map(students.map((s) => [s.id, s]));
      // Junior leader: resolve their own connected-student set once instead of
      // per-row (canAccessStudent can't scope role 'leader' at all — see
      // canLeaderAccessStudent above).
      const myStudentIds = (actor.role === 'leader' && connRepo && actor.leaderId)
        ? new Set((await connRepo.findByLeader(actor.leaderId)).map((c) => c.studentId))
        : null;
      const out: PrayerWithStudent[] = [];
      for (const p of all) {
        if (p.studentId == null) {
          // General/whole-group prayer — scoped by the creator's own grade+gender
          // domain. admin/director always pass; a `leader` (H2, 2026-07-19) passes
          // only for an UNSCOPED (null/null) one — their own general prayers plus
          // admin/director's — not another grade/quad's cohort-scoped ones (see
          // canAccessGeneralPrayer).
          if (!canAccessGeneralPrayer(actor, p.createdByGrades, p.createdByGender, structure)) continue;
          out.push({ ...p, student: null });
          continue;
        }
        const s = byId.get(p.studentId);
        if (!s) continue; // orphan (student deleted) — not the same as an intentional general prayer
        const allowed = actor.role === 'leader'
          ? (myStudentIds?.has(p.studentId) ?? false)
          : canAccessStudent(actor, s.grade, s.gender, structure);
        if (!allowed) continue;
        out.push({ ...p, student: summary(s) });
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return out;
    },

    async listByStudent(actor, studentId) {
      assertCan(actor, 'prayer:read');
      const structure = await structureScope();
      await studentInScope(actor, studentId, structure);
      const rows = await repo.findByStudent(studentId);
      return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async create(actor, input) {
      assertCan(actor, 'prayer:write');
      const data = CreateSchema.parse(input);
      const studentId = data.studentId ?? null;
      const structure = await structureScope();
      await studentInScope(actor, studentId, structure);
      // Captured for every prayer (cheap), but only read back for a general one
      // (studentId null) — a student-linked prayer scopes through the student.
      // FROZEN AT CREATION (L6, 2026-07-19): if the creating account's own
      // grade(s)/gender assignment (or role) is changed later, this prayer's
      // stored createdByGrades/createdByGender does NOT retroactively update —
      // re-scoping an author's account never re-scopes their past general
      // prayers.
      const creatorScope = generalPrayerCreatorScope(actor, structure);
      const now = new Date().toISOString();
      const prayer: PrayerRequest = {
        id: generateId(),
        studentId,
        text: data.text,
        status: 'open',
        answerNote: null,
        createdByLabel: data.createdByLabel ?? actor.displayName ?? '',
        createdByRole: actor.role,
        createdByGrades: creatorScope.grades,
        createdByGender: creatorScope.gender,
        createdAt: now,
        updatedAt: now,
        answeredAt: null,
      };
      return repo.save(prayer);
    },

    async update(actor, id, input) {
      assertCan(actor, 'prayer:write');
      const structure = await structureScope();
      const existing = await loadInScope(actor, id, structure);
      const patch = UpdateSchema.parse(input);
      const updated: PrayerRequest = {
        ...existing,
        text: patch.text ?? existing.text,
        answerNote: patch.answerNote !== undefined ? patch.answerNote : existing.answerNote,
        updatedAt: new Date().toISOString(),
      };
      return repo.save(updated);
    },

    async setStatus(actor, id, input) {
      assertCan(actor, 'prayer:write');
      const structure = await structureScope();
      const existing = await loadInScope(actor, id, structure);
      const patch = StatusSchema.parse(input);
      const now = new Date().toISOString();
      // M2 (2026-07-19): archiving used to null out answeredAt for ANY
      // status !== 'answered', so answered -> archived silently lost the
      // answered date. Archive is a forward step, not an un-answer — only
      // 'open' (an actual un-answer) clears answeredAt; 'answered' stamps it
      // the first time; 'archived' preserves whatever was already there
      // (null if it was never answered — never fabricated here).
      const answeredAt = patch.status === 'open'
        ? null
        : patch.status === 'answered'
          ? (existing.answeredAt ?? now)
          : existing.answeredAt;
      const updated: PrayerRequest = {
        ...existing,
        status: patch.status,
        answerNote: patch.answerNote !== undefined ? patch.answerNote : existing.answerNote,
        answeredAt,
        updatedAt: now,
      };
      return repo.save(updated);
    },

    async remove(actor, id) {
      assertCan(actor, 'prayer:write');
      const structure = await structureScope();
      await loadInScope(actor, id, structure);
      await repo.delete(id);
    },

    async exportCsv(actor) {
      assertCan(actor, 'prayer:import');
      const [prayers, students] = await Promise.all([repo.findAll(), studentRepo.findAll()]);
      return buildPrayerCsvRows(prayers, students);
    },

    async importCsv(actor, rows) {
      assertCan(actor, 'prayer:import'); // admin-only, so this is always the wide-open ministry scope
      const structure = await structureScope();
      const creatorScope = generalPrayerCreatorScope(actor, structure);
      const parsed = parsePrayerRows(z.array(z.record(z.unknown())).parse(rows));
      const [students, existing] = await Promise.all([studentRepo.findAll(), repo.findAll()]);
      const plan = planPrayerImport(parsed, students, existing);
      const now = new Date().toISOString();
      for (const a of plan.toAdd) {
        // H1/M3 (2026-07-19): a full-fidelity CSV (one exported by this app's own
        // exportCsv, carrying the createdByGrades/createdByGender/createdAt/
        // answeredAt columns) round-trips the row's ORIGINAL creator scope and
        // real timestamps instead of silently rescoping every row to this
        // importer (always ministry-wide, since importCsv is admin-only) and
        // resetting createdAt/updatedAt/answeredAt to now — which used to lose
        // history and collapse list()'s sort order on reimport (the New Year
        // Refresh flow). `undefined` means the column was absent (an old export,
        // or a hand-made CSV) — keep today's behaviour for those: this
        // importer's own scope, now() timestamps. `a.createdByGrades`/
        // `createdByGender` are checked against `undefined` specifically (NOT
        // `??`) because `null` is itself a meaningful, present value ("no
        // boundary") that must be preserved, not treated as "fall back".
        const createdByGrades = a.createdByGrades !== undefined ? a.createdByGrades : creatorScope.grades;
        const createdByGender = a.createdByGender !== undefined ? a.createdByGender : creatorScope.gender;
        const createdAt = a.createdAt ?? now;
        const answeredAt = a.answeredAt !== undefined
          ? a.answeredAt
          : (a.status === 'answered' ? now : null);
        await repo.save({
          id: generateId(),
          studentId: a.studentId,
          text: a.text,
          status: a.status,
          answerNote: a.answerNote,
          createdByLabel: a.createdByLabel,
          createdByRole: actor.role,
          createdByGrades,
          createdByGender,
          createdAt,
          updatedAt: now,
          answeredAt,
        });
      }
      return plan.report;
    },
  };
}
