import { describe, it, expect } from 'vitest';
import { makeStudentService } from '../services/student.service';
import { InMemoryStudentRepository } from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';
import { ForbiddenError, NotFoundError } from '../core/errors/app-error';

function actor(role: string, opts: { grade?: number; quad?: string; gender?: 'male' | 'female' } = {}): Actor {
  return { id: 'a-test', role: role as any, displayName: 'T', grade: (opts.grade ?? null) as any, quad: (opts.quad ?? null) as any, gender: opts.gender ?? null };
}

const ADMIN = actor('admin');

async function makeService() {
  const repo = new InMemoryStudentRepository();
  await repo.init();
  const svc = makeStudentService(repo);
  // Seed
  const s1 = await svc.create(ADMIN, { firstName: 'Alice', lastName: 'Smith', gender: 'female', grade: 9 });
  const s2 = await svc.create(ADMIN, { firstName: 'Bob', lastName: 'Jones', gender: 'male', grade: 9 });
  const s3 = await svc.create(ADMIN, { firstName: 'Carol', lastName: 'White', gender: 'female', grade: 10 });
  return { svc, s1, s2, s3 };
}

describe('Student Service', () => {
  // TC31 — grade login only sees own grade in list
  it('TC31: grade login sees only own grade', async () => {
    const { svc } = await makeService();
    const results = await svc.list(actor('grade', { grade: 9 }));
    expect(results.every(s => s.grade === 9)).toBe(true);
    expect(results).toHaveLength(2);
  });

  // TC32 — quad g79 female sees grade 7-9 females only
  it('TC32: g79 quad sees only female Yr 7-9', async () => {
    const { svc } = await makeService();
    const results = await svc.list(actor('quad', { quad: 'g79' }));
    expect(results.every(s => s.gender === 'female' && s.grade !== null && s.grade <= 9)).toBe(true);
    expect(results).toHaveLength(1); // only Alice
  });

  // TC33 — admin sees all students
  it('TC33: admin sees all students', async () => {
    const { svc } = await makeService();
    const results = await svc.list(ADMIN);
    expect(results).toHaveLength(3);
  });

  // TC34 — grade login can create student (director required)
  it('TC34: grade cannot create student (director+ required)', async () => {
    const { svc } = await makeService();
    await expect(svc.create(actor('grade', { grade: 9 }), { firstName: 'X', lastName: 'Y', gender: 'male', grade: 9 }))
      .rejects.toThrow(ForbiddenError);
  });

  // TC35 — search returns partial name match
  it('TC35: search finds by partial last name', async () => {
    const { svc } = await makeService();
    const results = await svc.search(ADMIN, 'smi');
    expect(results.some(s => s.lastName === 'Smith')).toBe(true);
  });

  // TC36 — search by full name works
  it('TC36: search finds by first+last name', async () => {
    const { svc } = await makeService();
    const results = await svc.search(ADMIN, 'alice smith');
    expect(results).toHaveLength(1);
    expect(results[0]?.firstName).toBe('Alice');
  });

  // TC37 — delete removes student
  it('TC37: admin can delete student', async () => {
    const { svc, s1 } = await makeService();
    await svc.remove(ADMIN, s1.id);
    await expect(svc.get(ADMIN, s1.id)).rejects.toThrow(NotFoundError);
  });

  // TC38 — update changes fields
  it('TC38: update changes grade', async () => {
    const { svc, s1 } = await makeService();
    const updated = await svc.update(ADMIN, s1.id, { grade: 10 });
    expect(updated.grade).toBe(10);
    // Quad should be recomputed
    expect(updated.quad).toBe('g1012');
  });
});

describe('Student Service — crossGrade (Connect Setup Add Students picker)', () => {
  it('a grade login normally sees only its own grade', async () => {
    const { svc } = await makeService();
    const results = await svc.list(actor('grade', { grade: 9, gender: 'female' }));
    expect(results.map((s) => s.firstName)).toEqual(['Alice']);
  });

  it('crossGrade widens a grade login to other grades of the same gender', async () => {
    const { svc } = await makeService();
    const results = await svc.list(actor('grade', { grade: 9, gender: 'female' }), { crossGrade: true });
    // Alice (Yr 9 girl) + Carol (Yr 10 girl) — Bob (male) still excluded.
    expect(results.map((s) => s.firstName).sort()).toEqual(['Alice', 'Carol']);
  });

  it('crossGrade widens a quad login to the other bracket, same gender only', async () => {
    const { svc } = await makeService();
    const withoutCrossGrade = await svc.list(actor('quad', { quad: 'g79' }));
    expect(withoutCrossGrade.map((s) => s.firstName)).toEqual(['Alice']); // Yr 7-9 girls only
    const withCrossGrade = await svc.list(actor('quad', { quad: 'g79' }), { crossGrade: true });
    // Carol (Yr 10 girl) now included; Bob (male) still excluded regardless of grade.
    expect(withCrossGrade.map((s) => s.firstName).sort()).toEqual(['Alice', 'Carol']);
  });
});
