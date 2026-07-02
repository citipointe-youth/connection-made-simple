import { describe, it, expect } from 'vitest';
import { makeAdminService } from '../services/admin.service';
import {
  InMemoryUserRepository,
  InMemoryStudentRepository,
  InMemoryLeaderRepository,
  InMemoryConnectionRepository,
  InMemoryServiceSessionRepository,
  InMemoryServiceAttendanceRepository,
  InMemoryLifegroupRepository,
  InMemoryLifegroupWeekRepository,
  InMemoryLifegroupAttendanceRepository,
  InMemoryImportRepository,
  InMemorySnapshotRepository,
  InMemoryAuditRepository,
} from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';
import { BadRequestError, ForbiddenError } from '../core/errors/app-error';

function actor(role: string): Actor {
  return { id: 'a-test', role: role as any, displayName: 'Test', grade: null as any, quad: null as any };
}

const ADMIN = actor('admin');
const DIRECTOR = actor('director');
const CONFIRM = 'I understand this cannot be undone';

async function buildService() {
  const users = new InMemoryUserRepository();
  const students = new InMemoryStudentRepository();
  const leaders = new InMemoryLeaderRepository();
  const connections = new InMemoryConnectionRepository();
  const serviceSessions = new InMemoryServiceSessionRepository();
  const serviceAttendance = new InMemoryServiceAttendanceRepository();
  const lifegroups = new InMemoryLifegroupRepository();
  const lifegroupWeeks = new InMemoryLifegroupWeekRepository();
  const lifegroupAttendance = new InMemoryLifegroupAttendanceRepository();
  const imports = new InMemoryImportRepository();
  const snapshots = new InMemorySnapshotRepository();
  const audit = new InMemoryAuditRepository();
  await Promise.all([
    users.init(), students.init(), leaders.init(), connections.init(),
    serviceSessions.init(), serviceAttendance.init(), lifegroups.init(),
    lifegroupWeeks.init(), lifegroupAttendance.init(), imports.init(),
    snapshots.init(), audit.init(),
  ]);

  await students.save({
    id: 's1', firstName: 'Alice', lastName: 'Smith', gender: 'female', grade: 9,
    quad: 'g79', mobile: null, parentPhone: null, dateOfBirth: null,
    svcAttended: 0, svcTotal: 0, grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
    prevSvcAttended: 0, prevSvcTotal: 0, prevGrpAttended: 0, prevGrpTotal: 0,
    atRiskStatus: 'new', dataSource: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  const svc = makeAdminService(
    users, students, leaders, connections, serviceSessions, serviceAttendance,
    lifegroups, lifegroupWeeks, lifegroupAttendance, imports, snapshots, audit,
  );
  return { svc, students };
}

describe('Admin Service — wipe guard', () => {
  it('reset without force/confirmWipe throws BadRequestError and touches no data', async () => {
    const { svc, students } = await buildService();
    await expect(svc.reset(ADMIN)).rejects.toBeInstanceOf(BadRequestError);
    expect((await students.findAll()).length).toBe(1);
  });

  it('reset with force:true but wrong confirmWipe throws BadRequestError', async () => {
    const { svc, students } = await buildService();
    await expect(svc.reset(ADMIN, { force: true, confirmWipe: 'nope' })).rejects.toBeInstanceOf(BadRequestError);
    expect((await students.findAll()).length).toBe(1);
  });

  it('reset with force:true + correct confirmWipe wipes data', async () => {
    const { svc, students } = await buildService();
    await svc.reset(ADMIN, { force: true, confirmWipe: CONFIRM });
    expect((await students.findAll()).length).toBe(0);
  });

  it('clearServiceGroupData without force/confirmWipe throws BadRequestError and touches no data', async () => {
    const { svc, students } = await buildService();
    await expect(svc.clearServiceGroupData(ADMIN)).rejects.toBeInstanceOf(BadRequestError);
    const [s] = await students.findAll();
    expect(s?.atRiskStatus).toBe('new');
  });

  it('clearServiceGroupData with force:true + correct confirmWipe resets student aggregates', async () => {
    const { svc, students } = await buildService();
    await svc.clearServiceGroupData(ADMIN, { force: true, confirmWipe: CONFIRM });
    const [s] = await students.findAll();
    expect(s).toBeTruthy();
    expect(s?.svcAttended).toBe(0);
  });

  it('non-admin actor is still rejected regardless of force/confirmWipe', async () => {
    const { svc } = await buildService();
    await expect(svc.reset(DIRECTOR, { force: true, confirmWipe: CONFIRM })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
