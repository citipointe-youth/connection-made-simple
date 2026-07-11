import { hashPassword } from './utils/crypto';
import { generateId } from './utils/id';
import type { Repositories } from './container';
import type { User } from './core/entities/user';
import type { Student } from './core/entities/student';
import type { Leader } from './core/entities/leader';

export async function seedDemoData(repos: Repositories): Promise<void> {
  const existing = await repos.users.findAll();
  if (existing.length > 0) return; // Already seeded

  const pw = await hashPassword('demo1234');
  const now = new Date().toISOString();

  const users: User[] = [
    {
      id: generateId(), displayName: 'Admin', email: 'admin',
      role: 'admin', grade: null, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Director', email: 'director',
      role: 'director', grade: null, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Girls Yr 7–9 Quad', email: 'g79',
      role: 'quad', grade: null, quad: 'g79',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Boys Yr 7–9 Quad', email: 'b79',
      role: 'quad', grade: null, quad: 'b79',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Girls Yr 10–12 Quad', email: 'g1012',
      role: 'quad', grade: null, quad: 'g1012',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Boys Yr 10–12 Quad', email: 'b1012',
      role: 'quad', grade: null, quad: 'b1012',
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 7', email: 'grade7',
      role: 'grade', grade: 7, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 8', email: 'grade8',
      role: 'grade', grade: 8, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 9', email: 'grade9',
      role: 'grade', grade: 9, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 10', email: 'grade10',
      role: 'grade', grade: 10, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 11', email: 'grade11',
      role: 'grade', grade: 11, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
    {
      id: generateId(), displayName: 'Grade 12', email: 'grade12',
      role: 'grade', grade: 12, quad: null,
      status: 'active', passwordHash: pw, createdAt: now, updatedAt: now,
    },
  ];
  for (const u of users) await repos.users.save(u);

  // Demo leaders
  const leaders: Leader[] = [
    { id: generateId(), fullName: 'Sarah Mitchell', gender: 'female', grades: [7, 8], active: true, createdByGrade: 7, smsTemplate: null, createdAt: now, updatedAt: now },
    { id: generateId(), fullName: 'Emma Clarke', gender: 'female', grades: [9], active: true, createdByGrade: 9, smsTemplate: null, createdAt: now, updatedAt: now },
    { id: generateId(), fullName: 'James Thompson', gender: 'male', grades: [7, 8], active: true, createdByGrade: 7, smsTemplate: null, createdAt: now, updatedAt: now },
    { id: generateId(), fullName: 'Michael Roberts', gender: 'male', grades: [9], active: true, createdByGrade: 9, smsTemplate: null, createdAt: now, updatedAt: now },
    { id: generateId(), fullName: 'Rachel Green', gender: 'female', grades: [10, 11], active: true, createdByGrade: 10, smsTemplate: null, createdAt: now, updatedAt: now },
    { id: generateId(), fullName: 'David Kim', gender: 'male', grades: [10, 11], active: true, createdByGrade: 10, smsTemplate: null, createdAt: now, updatedAt: now },
    { id: generateId(), fullName: 'Natasha Brown', gender: 'female', grades: [12], active: true, createdByGrade: 12, smsTemplate: null, createdAt: now, updatedAt: now },
    { id: generateId(), fullName: 'Chris Wilson', gender: 'male', grades: [12], active: true, createdByGrade: 12, smsTemplate: null, createdAt: now, updatedAt: now },
  ];
  for (const l of leaders) await repos.leaders.save(l);

  // Demo students
  const studentData = [
    // Grade 7 girls
    { fn: 'Olivia', ln: 'Harris', g: 'female', gr: 7, svcA: 8, svcT: 10, grpA: 5, grpT: 6, ar: 'regular' },
    { fn: 'Ava', ln: 'Martinez', g: 'female', gr: 7, svcA: 3, svcT: 10, grpA: 2, grpT: 6, ar: 'atrisk' },
    { fn: 'Mia', ln: 'Taylor', g: 'female', gr: 7, svcA: 9, svcT: 10, grpA: 6, grpT: 6, ar: 'regular' },
    // Grade 7 boys
    { fn: 'Liam', ln: 'Anderson', g: 'male', gr: 7, svcA: 7, svcT: 10, grpA: 4, grpT: 6, ar: 'regular' },
    { fn: 'Noah', ln: 'White', g: 'male', gr: 7, svcA: 1, svcT: 10, grpA: 0, grpT: 6, ar: 'stopped' },
    // Grade 8 girls
    { fn: 'Isabella', ln: 'Jackson', g: 'female', gr: 8, svcA: 6, svcT: 10, grpA: 4, grpT: 6, ar: 'regular' },
    { fn: 'Sophia', ln: 'Lee', g: 'female', gr: 8, svcA: 4, svcT: 10, grpA: 2, grpT: 6, ar: 'declining' },
    // Grade 8 boys
    { fn: 'William', ln: 'Garcia', g: 'male', gr: 8, svcA: 8, svcT: 10, grpA: 5, grpT: 6, ar: 'regular' },
    { fn: 'James', ln: 'Thomas', g: 'male', gr: 8, svcA: 2, svcT: 10, grpA: 1, grpT: 6, ar: 'atrisk' },
    // Grade 9 girls
    { fn: 'Charlotte', ln: 'Moore', g: 'female', gr: 9, svcA: 9, svcT: 10, grpA: 6, grpT: 6, ar: 'regular' },
    { fn: 'Amelia', ln: 'Johnson', g: 'female', gr: 9, svcA: 5, svcT: 10, grpA: 3, grpT: 6, ar: 'watch' },
    // Grade 9 boys
    { fn: 'Benjamin', ln: 'Davis', g: 'male', gr: 9, svcA: 7, svcT: 10, grpA: 5, grpT: 6, ar: 'regular' },
    { fn: 'Mason', ln: 'Wilson', g: 'male', gr: 9, svcA: 0, svcT: 10, grpA: 0, grpT: 6, ar: 'stopped' },
    // Grade 10 girls
    { fn: 'Harper', ln: 'Evans', g: 'female', gr: 10, svcA: 8, svcT: 10, grpA: 5, grpT: 6, ar: 'regular' },
    { fn: 'Evelyn', ln: 'Brown', g: 'female', gr: 10, svcA: 3, svcT: 10, grpA: 1, grpT: 6, ar: 'atrisk' },
    // Grade 10 boys
    { fn: 'Ethan', ln: 'Turner', g: 'male', gr: 10, svcA: 6, svcT: 10, grpA: 4, grpT: 6, ar: 'regular' },
    { fn: 'Alexander', ln: 'Hill', g: 'male', gr: 10, svcA: 9, svcT: 10, grpA: 6, grpT: 6, ar: 'regular' },
    // Grade 11 girls
    { fn: 'Abigail', ln: 'Walker', g: 'female', gr: 11, svcA: 7, svcT: 10, grpA: 4, grpT: 6, ar: 'regular' },
    { fn: 'Emily', ln: 'Young', g: 'female', gr: 11, svcA: 2, svcT: 10, grpA: 1, grpT: 6, ar: 'declining' },
    // Grade 11 boys
    { fn: 'Jackson', ln: 'Scott', g: 'male', gr: 11, svcA: 8, svcT: 10, grpA: 5, grpT: 6, ar: 'regular' },
    { fn: 'Sebastian', ln: 'Allen', g: 'male', gr: 11, svcA: 1, svcT: 10, grpA: 0, grpT: 6, ar: 'stopped' },
    // Grade 12 girls
    { fn: 'Elizabeth', ln: 'Sanchez', g: 'female', gr: 12, svcA: 9, svcT: 10, grpA: 6, grpT: 6, ar: 'regular' },
    { fn: 'Camila', ln: 'Clark', g: 'female', gr: 12, svcA: 6, svcT: 10, grpA: 4, grpT: 6, ar: 'regular' },
    // Grade 12 boys
    { fn: 'Henry', ln: 'Rodriguez', g: 'male', gr: 12, svcA: 5, svcT: 10, grpA: 3, grpT: 6, ar: 'watch' },
    { fn: 'Owen', ln: 'Lewis', g: 'male', gr: 12, svcA: 10, svcT: 10, grpA: 6, grpT: 6, ar: 'regular' },
  ];

  const { computeQuad } = await import('./core/types/enums');
  for (const d of studentData) {
    const gender = d.g as 'male' | 'female' | 'other';
    const student: Student = {
      id: generateId(),
      firstName: d.fn, lastName: d.ln,
      gender, grade: d.gr,
      quad: computeQuad(d.gr, d.g),
      mobile: null, parentPhone: null, dateOfBirth: null,
      svcAttended: d.svcA, svcTotal: d.svcT,
      grpAttended: d.grpA, grpTotal: d.grpT,
      grpMetWeeks: d.grpT,
      prevSvcAttended: 0, prevSvcTotal: 0,
      prevGrpAttended: 0, prevGrpTotal: 0,
      atRiskStatus: d.ar as 'regular' | 'declining' | 'atrisk' | 'stopped' | 'watch' | 'new' | null,
      dataSource: 'seed', createdAt: now, updatedAt: now,
    };
    await repos.students.save(student);
  }
}
