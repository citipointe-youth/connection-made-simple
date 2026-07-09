import { describe, it, expect, beforeEach } from 'vitest';
import { makeConnectionService } from '../services/connection.service';
import { makeStudentService } from '../services/student.service';
import { makeLeaderService } from '../services/leader.service';
import {
  InMemoryStudentRepository,
  InMemoryLeaderRepository,
  InMemoryConnectionRepository,
  InMemorySettingsRepository,
} from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';
import { BadRequestError, ForbiddenError, ConflictError } from '../core/errors/app-error';

function actor(role: string, opts: { grade?: number; quad?: string; gender?: 'male' | 'female' } = {}): Actor {
  return { id: 'a-test', role: role as any, displayName: 'Test', grade: (opts.grade ?? null) as any, quad: (opts.quad ?? null) as any, gender: opts.gender ?? null };
}

const ADMIN = actor('admin');
const GRADE9 = actor('grade', { grade: 9 });
const G79 = actor('quad', { quad: 'g79' });

async function buildServices() {
  const studentRepo = new InMemoryStudentRepository();
  const leaderRepo = new InMemoryLeaderRepository();
  const connRepo = new InMemoryConnectionRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await studentRepo.init();
  await leaderRepo.init();
  await connRepo.init();
  await settingsRepo.init();

  const studentSvc = makeStudentService(studentRepo);
  const leaderSvc = makeLeaderService(leaderRepo);
  const connSvc = makeConnectionService(connRepo, studentRepo, leaderRepo, settingsRepo);

  // Seed a student in grade 9 female
  const student = await studentSvc.create(ADMIN, {
    firstName: 'Alice', lastName: 'Smith', gender: 'female', grade: 9,
  });
  // Seed a student in grade 8 female (for cross-grade test)
  const student2 = await studentSvc.create(ADMIN, {
    firstName: 'Beth', lastName: 'Jones', gender: 'female', grade: 8,
  });
  // Seed a student grade 9 male
  const student3 = await studentSvc.create(ADMIN, {
    firstName: 'Carlos', lastName: 'Lee', gender: 'male', grade: 9,
  });
  // Seed a female leader
  const leaderF = await leaderSvc.create(ADMIN, {
    fullName: 'Emma Leader', gender: 'female', grades: [9],
  });
  // Seed a male leader
  const leaderM = await leaderSvc.create(ADMIN, {
    fullName: 'James Leader', gender: 'male', grades: [9],
  });

  return { studentSvc, leaderSvc, connSvc, student, student2, student3, leaderF, leaderM };
}

describe('Connection Service', () => {
  // leaderSummary must carry dateOfBirth so My Students shows it without a
  // separate, role-scoped /students lookup (which misses cross-grade students).
  it('leaderSummary includes dateOfBirth for connected students', async () => {
    const { connSvc, studentSvc, leaderSvc } = await buildServices();
    const stud = await studentSvc.create(ADMIN, {
      firstName: 'Dee', lastName: 'Bee', gender: 'female', grade: 9, dateOfBirth: '2009-05-05',
    });
    const leader = await leaderSvc.create(ADMIN, { fullName: 'Lead Er', gender: 'female', grades: [9] });
    await connSvc.assign(ADMIN, { studentId: stud.id, leaderId: leader.id });
    const summary = await connSvc.leaderSummary(ADMIN, leader.id);
    const row = summary.students.find((s) => s.id === stud.id);
    expect(row?.dateOfBirth).toBe('2009-05-05');
  });

  // TC23 — admin can connect any student to any leader
  it('TC23: admin can connect', async () => {
    const { connSvc, student, leaderF } = await buildServices();
    const conn = await connSvc.assign(ADMIN, { studentId: student.id, leaderId: leaderF.id });
    expect(conn.studentId).toBe(student.id);
    expect(conn.leaderId).toBe(leaderF.id);
  });

  // TC24 — grade login can connect own-grade student to same-gender leader
  it('TC24: grade can connect own-grade student', async () => {
    const { connSvc, student, leaderF } = await buildServices();
    const conn = await connSvc.assign(GRADE9, { studentId: student.id, leaderId: leaderF.id });
    expect(conn).toBeDefined();
  });

  // TC25 — cross-grade connection allowed when genders match
  it('TC25: grade can cross-grade connect when genders match', async () => {
    const { connSvc, student2, leaderF } = await buildServices();
    // student2 is grade 8 female, leaderF is female — grade 9 login doing cross-grade
    const conn = await connSvc.assign(GRADE9, { studentId: student2.id, leaderId: leaderF.id });
    expect(conn).toBeDefined();
  });

  // TC26 — cross-grade connection rejected when genders mismatch
  it('TC26: cross-grade fails when genders mismatch', async () => {
    const { connSvc, student2, leaderM } = await buildServices();
    // student2 female, leaderM male — cross-grade should fail
    await expect(connSvc.assign(GRADE9, { studentId: student2.id, leaderId: leaderM.id }))
      .rejects.toThrow(BadRequestError);
  });

  // TC27 — duplicate connection is rejected
  it('TC27: duplicate connection rejected', async () => {
    const { connSvc, student, leaderF } = await buildServices();
    await connSvc.assign(ADMIN, { studentId: student.id, leaderId: leaderF.id });
    await expect(connSvc.assign(ADMIN, { studentId: student.id, leaderId: leaderF.id }))
      .rejects.toThrow(ConflictError);
  });

  // TC28 — unassign removes connection
  it('TC28: unassign removes connection', async () => {
    const { connSvc, student, leaderF } = await buildServices();
    await connSvc.assign(ADMIN, { studentId: student.id, leaderId: leaderF.id });
    await connSvc.unassign(ADMIN, student.id, leaderF.id);
    const remaining = await connSvc.listByStudent(ADMIN, student.id);
    expect(remaining).toHaveLength(0);
  });

  // TC29 — quad login cannot write connections (no connection:write)
  // Note: quad DOES have connection:write per spec, so this should succeed
  it('TC29: quad can connect students in their scope', async () => {
    const { connSvc, student, leaderF } = await buildServices();
    // student is female grade 9 — in g79 scope? No — g79 is grades 7-9. Let's verify.
    const conn = await connSvc.assign(G79, { studentId: student.id, leaderId: leaderF.id });
    expect(conn).toBeDefined();
  });

  // TC30 — leader summary returns correct students
  it('TC30: leaderSummary returns assigned students', async () => {
    const { connSvc, student, student3, leaderF, leaderM } = await buildServices();
    await connSvc.assign(ADMIN, { studentId: student.id, leaderId: leaderF.id });
    await connSvc.assign(ADMIN, { studentId: student3.id, leaderId: leaderM.id });
    const summary = await connSvc.leaderSummary(ADMIN, leaderF.id);
    expect(summary.students).toHaveLength(1);
    expect(summary.students[0]?.fullName).toBe('Alice Smith');
  });
});

describe('Connection Service — listAll crossGrade (Connect Setup Add Students picker)', () => {
  it('normally hides a cross-grade connection from listAll', async () => {
    const { connSvc, student2, leaderF } = await buildServices();
    // student2 is Yr 8 female; leaderF is female — allowed by assign()'s cross-grade
    // exception, but a plain Yr-9-scoped listAll() shouldn't surface it.
    await connSvc.assign(ADMIN, { studentId: student2.id, leaderId: leaderF.id });
    const GRADE9F = actor('grade', { grade: 9, gender: 'female' });
    const seen = await connSvc.listAll(GRADE9F);
    expect(seen).toHaveLength(0);
  });

  it('crossGrade surfaces it, but still enforces the actor\'s own gender scope', async () => {
    const { connSvc, student2, student3, leaderF, leaderM } = await buildServices();
    await connSvc.assign(ADMIN, { studentId: student2.id, leaderId: leaderF.id }); // Yr 8 female
    await connSvc.assign(ADMIN, { studentId: student3.id, leaderId: leaderM.id }); // Yr 9 male
    const GRADE9F = actor('grade', { grade: 9, gender: 'female' });
    const seen = await connSvc.listAll(GRADE9F, { crossGrade: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.studentId).toBe(student2.id);
  });
});
