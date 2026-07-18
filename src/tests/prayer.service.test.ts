import { describe, it, expect } from 'vitest';
import { makePrayerService } from '../services/prayer.service';
import { InMemoryPrayerRepository, InMemoryStudentRepository, InMemoryConnectionRepository } from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';
import type { Student } from '../core/entities/student';
import { ForbiddenError, NotFoundError } from '../core/errors/app-error';

const actor = (role: string, opts: { grade?: number; gender?: string; quad?: string; leaderId?: string } = {}): Actor =>
  ({ id: 'a', role: role as any, displayName: 'T',
     grade: (opts.grade ?? null) as any, gender: (opts.gender ?? null) as any, quad: (opts.quad ?? null) as any,
     leaderId: opts.leaderId ?? null });

const ADMIN = actor('admin');
const DIRECTOR = actor('director');
const G9F = actor('grade', { grade: 9, gender: 'female' });
const G9M = actor('grade', { grade: 9, gender: 'male' });
const G8M = actor('grade', { grade: 8, gender: 'male' });
const QB79 = actor('quad', { quad: 'b79' }); // Boys Yr 7-9
const QG79 = actor('quad', { quad: 'g79' }); // Girls Yr 7-9
const QB1012 = actor('quad', { quad: 'b1012' }); // Boys Yr 10-12

const student = (id: string, grade: number, gender: string): Student => ({
  id, firstName: id, lastName: 'X', gender: gender as any, grade, quad: null,
  mobile: null, parentPhone: null, dateOfBirth: null,
  svcAttended: 0, svcTotal: 0, grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
  prevSvcAttended: 0, prevSvcTotal: 0, prevGrpAttended: 0, prevGrpTotal: 0,
  atRiskStatus: null, dataSource: null,
  createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
});

async function svc(students: Student[] = []) {
  const prayers = new InMemoryPrayerRepository();
  const studentRepo = new InMemoryStudentRepository();
  const connRepo = new InMemoryConnectionRepository();
  await prayers.init(); await studentRepo.init(); await connRepo.init();
  for (const s of students) await studentRepo.save(s);
  return { s: makePrayerService(prayers, studentRepo, undefined, connRepo), prayers, studentRepo, connRepo };
}

describe('PrayerService scoping + CRUD', () => {
  it('grade login sees only its own grade + gender prayers in list()', async () => {
    const { s } = await svc([student('ava', 9, 'female'), student('jake', 9, 'male'), student('mia', 10, 'female')]);
    await s.create(ADMIN, { studentId: 'ava', text: 'exams' });
    await s.create(ADMIN, { studentId: 'jake', text: 'boy' });
    await s.create(ADMIN, { studentId: 'mia', text: 'senior' });
    const list = await s.list(G9F);
    expect(list.map((p) => p.student?.id)).toEqual(['ava']);
    expect(list[0]!.student!.firstName).toBe('ava');
  });

  it('grade login is forbidden from creating a prayer out of scope', async () => {
    const { s } = await svc([student('jake', 9, 'male')]);
    await expect(s.create(G9F, { studentId: 'jake', text: 'x' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('create for a missing student throws NotFound', async () => {
    const { s } = await svc([]);
    await expect(s.create(ADMIN, { studentId: 'nope', text: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('setStatus answered stamps answeredAt; back to open clears it', async () => {
    const { s } = await svc([student('ava', 9, 'female')]);
    const p = await s.create(ADMIN, { studentId: 'ava', text: 'x' });
    const ans = await s.setStatus(ADMIN, p.id, { status: 'answered', answerNote: 'praise' });
    expect(ans.status).toBe('answered');
    expect(ans.answeredAt).not.toBeNull();
    expect(ans.answerNote).toBe('praise');
    const reopened = await s.setStatus(ADMIN, p.id, { status: 'open' });
    expect(reopened.answeredAt).toBeNull();
  });

  it('grade login cannot read/edit an out-of-scope prayer by id', async () => {
    const { s } = await svc([student('mia', 10, 'female')]);
    const p = await s.create(ADMIN, { studentId: 'mia', text: 'senior' });
    await expect(s.update(G9F, p.id, { text: 'z' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('update edits text, remove deletes, and empty text is rejected', async () => {
    const { s } = await svc([student('ava', 9, 'female')]);
    const p = await s.create(G9F, { studentId: 'ava', text: 'x', createdByLabel: 'Sarah' });
    expect(p.createdByLabel).toBe('Sarah');
    const upd = await s.update(G9F, p.id, { text: 'updated' });
    expect(upd.text).toBe('updated');
    await expect(s.update(G9F, p.id, { text: '' })).rejects.toThrow();
    await s.remove(G9F, p.id);
    await expect(s.listByStudent(G9F, 'ava')).resolves.toEqual([]);
  });

  it('a general prayer is creatable by any role, but a grade login only sees its own', async () => {
    const { s } = await svc([]);
    const created = await s.create(G9F, { text: 'Pray for the whole youth group' });
    expect(created.studentId).toBeNull();

    // Visible to its own creator and to admin (ministry-wide viewer)...
    for (const viewer of [G9F, ADMIN, DIRECTOR]) {
      const list = await s.list(viewer);
      expect(list.map((p) => p.id)).toContain(created.id);
      expect(list.find((p) => p.id === created.id)!.student).toBeNull();
    }
    // ...but NOT to a different grade, even the same gender, and NOT to a
    // different gender in the same grade.
    for (const viewer of [G8M, G9M]) {
      const list = await s.list(viewer);
      expect(list.map((p) => p.id)).not.toContain(created.id);
    }
  });

  it("a quad's general prayer is visible to the grades within their quad, not outside it", async () => {
    const { s } = await svc([]);
    const created = await s.create(QB79, { text: 'Pray for the boys' });

    // Own quad, and every grade (7-9) + gender (male) within it.
    for (const viewer of [QB79, actor('grade', { grade: 7, gender: 'male' }), actor('grade', { grade: 9, gender: 'male' })]) {
      const list = await s.list(viewer);
      expect(list.map((p) => p.id)).toContain(created.id);
    }
    // Not a different gender in the same bracket, and not a different bracket.
    for (const viewer of [QG79, actor('grade', { grade: 9, gender: 'female' }), QB1012, actor('grade', { grade: 10, gender: 'male' })]) {
      const list = await s.list(viewer);
      expect(list.map((p) => p.id)).not.toContain(created.id);
    }
    // Admin/director still see everything regardless.
    for (const viewer of [ADMIN, DIRECTOR]) {
      expect((await s.list(viewer)).map((p) => p.id)).toContain(created.id);
    }
  });

  it('a director/admin-created general prayer is visible to every gender/grade', async () => {
    const { s } = await svc([]);
    const created = await s.create(DIRECTOR, { text: 'Pray for the whole ministry' });
    for (const viewer of [G9F, G8M, QB79, QG79, QB1012, ADMIN, DIRECTOR]) {
      expect((await s.list(viewer)).map((p) => p.id)).toContain(created.id);
    }
  });

  it('a general prayer can be edited/marked/deleted only within the same scope it is visible in', async () => {
    const { s } = await svc([]);
    const adminGeneral = await s.create(ADMIN, { text: 'general' });
    // Admin's general prayer is ministry-wide, so G9F can act on it too.
    const upd = await s.update(G9F, adminGeneral.id, { text: 'updated general' });
    expect(upd.text).toBe('updated general');
    const ans = await s.setStatus(G9F, adminGeneral.id, { status: 'answered' });
    expect(ans.status).toBe('answered');
    await s.remove(G9F, adminGeneral.id);

    // A grade-scoped general prayer, on the other hand, is out of reach for a
    // different grade/gender, on read AND write.
    const gradeGeneral = await s.create(G9F, { text: 'grade9 girls general' });
    await expect(s.update(G8M, gradeGeneral.id, { text: 'z' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.setStatus(G8M, gradeGeneral.id, { status: 'answered' })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.remove(G8M, gradeGeneral.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a junior leader can create/view a prayer for their own connected student, not for others', async () => {
    const { s, connRepo } = await svc([student('ava', 9, 'female'), student('mia', 10, 'female')]);
    const LEADER = actor('leader', { leaderId: 'leader-1' });
    await connRepo.save({ id: 'c1', studentId: 'ava', leaderId: 'leader-1', assignedByRole: 'admin', createdAt: '2026-07-18T00:00:00.000Z' });

    const p = await s.create(LEADER, { studentId: 'ava', text: 'ava prayer' });
    expect(p.studentId).toBe('ava');
    const list = await s.list(LEADER);
    expect(list.map((x) => x.id)).toContain(p.id);

    await expect(s.create(LEADER, { studentId: 'mia', text: 'not mine' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a junior leader can still create/view general prayers unrestricted (no grade/gender to derive)', async () => {
    const { s } = await svc([]);
    const LEADER = actor('leader', { leaderId: 'leader-1' });
    const p = await s.create(LEADER, { text: 'general from a leader' });
    expect((await s.list(LEADER)).map((x) => x.id)).toContain(p.id);
    expect((await s.list(G9F)).map((x) => x.id)).toContain(p.id); // leader-created = wide open
  });
});
