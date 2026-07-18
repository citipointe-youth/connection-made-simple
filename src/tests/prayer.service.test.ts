import { describe, it, expect } from 'vitest';
import { makePrayerService } from '../services/prayer.service';
import { InMemoryPrayerRepository, InMemoryStudentRepository } from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';
import type { Student } from '../core/entities/student';
import { ForbiddenError, NotFoundError } from '../core/errors/app-error';

const actor = (role: string, opts: { grade?: number; gender?: string; quad?: string } = {}): Actor =>
  ({ id: 'a', role: role as any, displayName: 'T',
     grade: (opts.grade ?? null) as any, gender: (opts.gender ?? null) as any, quad: (opts.quad ?? null) as any });

const ADMIN = actor('admin');
const G9F = actor('grade', { grade: 9, gender: 'female' });

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
  await prayers.init(); await studentRepo.init();
  for (const s of students) await studentRepo.save(s);
  return { s: makePrayerService(prayers, studentRepo), prayers, studentRepo };
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

  it('a general prayer (no student) is creatable by any role and visible to everyone', async () => {
    const { s } = await svc([student('ava', 9, 'female')]);
    const created = await s.create(G9F, { text: 'Pray for the whole youth group' });
    expect(created.studentId).toBeNull();

    const asGrade = await s.list(G9F);
    const asAdmin = await s.list(ADMIN);
    const asOtherGrade = await s.list(actor('grade', { grade: 12, gender: 'male' }));
    for (const list of [asGrade, asAdmin, asOtherGrade]) {
      expect(list.map((p) => p.id)).toContain(created.id);
      expect(list.find((p) => p.id === created.id)!.student).toBeNull();
    }
  });

  it('a general prayer can be edited, marked answered, and deleted without scope checks', async () => {
    const { s } = await svc([]);
    const p = await s.create(ADMIN, { text: 'general' });
    const upd = await s.update(G9F, p.id, { text: 'updated general' });
    expect(upd.text).toBe('updated general');
    const ans = await s.setStatus(G9F, p.id, { status: 'answered' });
    expect(ans.status).toBe('answered');
    await s.remove(G9F, p.id);
    await expect(s.list(ADMIN)).resolves.toEqual([]);
  });
});
