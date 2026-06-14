import { describe, it, expect, beforeEach } from 'vitest';
import { makeAtRiskService, computeStatus } from '../services/atrisk.service';
import { makeStudentService } from '../services/student.service';
import { InMemoryStudentRepository, InMemorySettingsRepository } from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';

function actor(role: string, opts: { grade?: number; quad?: string } = {}): Actor {
  return { id: 'a-test', role: role as any, displayName: 'T', grade: (opts.grade ?? null) as any, quad: (opts.quad ?? null) as any };
}

const ADMIN = actor('admin');

async function makeServices() {
  const studentRepo = new InMemoryStudentRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await studentRepo.init();
  await settingsRepo.init();
  const studentSvc = makeStudentService(studentRepo);
  const atRiskSvc = makeAtRiskService(studentRepo, settingsRepo);

  // Seed students with known attendance
  const s1 = await studentSvc.create(ADMIN, { firstName: 'Alice', lastName: 'Smith', gender: 'female', grade: 9 });
  // Set attendance directly for testing
  const updated = await studentRepo.findById(s1.id);
  if (updated) {
    await studentRepo.save({ ...updated, svcAttended: 0, svcTotal: 8, grpAttended: 0, grpTotal: 6 }); // stopped
  }

  const s2 = await studentSvc.create(ADMIN, { firstName: 'Bob', lastName: 'Jones', gender: 'male', grade: 9 });
  const s2Full = await studentRepo.findById(s2.id);
  if (s2Full) {
    await studentRepo.save({ ...s2Full, svcAttended: 2, svcTotal: 8, grpAttended: 1, grpTotal: 6 }); // atrisk (2/8 = 25% < 50%)
  }

  const s3 = await studentSvc.create(ADMIN, { firstName: 'Carol', lastName: 'White', gender: 'female', grade: 10 });
  const s3Full = await studentRepo.findById(s3.id);
  if (s3Full) {
    await studentRepo.save({ ...s3Full, svcAttended: 5, svcTotal: 8, grpAttended: 4, grpTotal: 6 }); // declining (5/8=62.5%, below 75% reg)
  }

  const s4 = await studentSvc.create(ADMIN, { firstName: 'Dave', lastName: 'Black', gender: 'male', grade: 10 });
  const s4Full = await studentRepo.findById(s4.id);
  if (s4Full) {
    await studentRepo.save({ ...s4Full, svcAttended: 7, svcTotal: 8, grpAttended: 5, grpTotal: 6 }); // regular
  }

  return { atRiskSvc, studentSvc, studentRepo, settingsRepo, s1, s2, s3, s4 };
}

describe('At-Risk Service — dynamic computation', () => {
  // TC39 — stopped student is flagged
  it('TC39: student with 0 attendance and 8 sessions = stopped', async () => {
    const { atRiskSvc } = await makeServices();
    const list = await atRiskSvc.list(ADMIN);
    const found = list.find(e => e.fullName === 'Alice Smith');
    expect(found).toBeDefined();
    expect(found?.status).toBe('stopped');
  });

  // TC40 — at-risk student is flagged
  it('TC40: student below risk threshold = atrisk', async () => {
    const { atRiskSvc } = await makeServices();
    const list = await atRiskSvc.list(ADMIN);
    const found = list.find(e => e.fullName === 'Bob Jones');
    expect(found).toBeDefined();
    expect(found?.status).toBe('atrisk');
  });

  // TC41 — declining student is flagged
  it('TC41: student below regular threshold = declining', async () => {
    const { atRiskSvc } = await makeServices();
    const list = await atRiskSvc.list(ADMIN);
    const found = list.find(e => e.fullName === 'Carol White');
    expect(found).toBeDefined();
    expect(found?.status).toBe('declining');
  });

  // TC42 — regular student is NOT in at-risk list
  it('TC42: regular student excluded from at-risk list', async () => {
    const { atRiskSvc } = await makeServices();
    const list = await atRiskSvc.list(ADMIN);
    const found = list.find(e => e.fullName === 'Dave Black');
    expect(found).toBeUndefined();
  });

  // TC43 — recompute updates stored status
  it('TC43: recompute updates student atRiskStatus in repo', async () => {
    const { atRiskSvc, studentRepo, s4 } = await makeServices();
    const result = await atRiskSvc.recompute(actor('director'));
    expect(result.updated).toBeGreaterThanOrEqual(0);
    // s4 has 7/8 (87.5%) service — should be regular
    const s = await studentRepo.findById(s4.id);
    expect(s?.atRiskStatus).toBe('regular');
  });

  // TC44 — grade login sees only own grade in at-risk
  it('TC44: grade login only sees own grade at-risk', async () => {
    const { atRiskSvc } = await makeServices();
    const list = await atRiskSvc.list(actor('grade', { grade: 9 }));
    expect(list.every(e => e.grade === 9)).toBe(true);
  });

  // TC45 — g79 quad sees only female Yr 7-9 at-risk
  it('TC45: g79 quad sees only female Yr 7-9 at-risk', async () => {
    const { atRiskSvc } = await makeServices();
    const list = await atRiskSvc.list(actor('quad', { quad: 'g79' }));
    expect(list.every(e => e.gender === 'female' && e.grade !== null && e.grade <= 9)).toBe(true);
  });

  // TC46 — stopped is sorted before atrisk
  it('TC46: stopped sorted before atrisk', async () => {
    const { atRiskSvc } = await makeServices();
    const list = await atRiskSvc.list(ADMIN);
    const stoppedIdx = list.findIndex(e => e.status === 'stopped');
    const atriskIdx = list.findIndex(e => e.status === 'atrisk');
    if (stoppedIdx >= 0 && atriskIdx >= 0) {
      expect(stoppedIdx).toBeLessThan(atriskIdx);
    }
  });
});

describe('At-Risk — settings thresholds', () => {
  // TC47 — changing risk threshold changes who is flagged
  it('TC47: changing risk threshold changes at-risk list', async () => {
    const { atRiskSvc, settingsRepo } = await makeServices();
    // Lower risk threshold to 10% — 2/8 = 25% > 10%, so Bob goes from atrisk → declining
    await settingsRepo.updateSettings({ riskRateNumerator: 1, riskRateDenominator: 10 });
    const list = await atRiskSvc.list(ADMIN);
    const bob = list.find(e => e.fullName === 'Bob Jones');
    // 25% > 10% risk threshold but < 75% regular → should now be declining
    expect(bob?.status).toBe('declining');
  });
});

describe('computeStatus — stopped requires attending NEITHER stream', () => {
  const S = { riskRateNumerator: 1, riskRateDenominator: 2, regRateNumerator: 3, regRateDenominator: 4 };
  it('0 service but attended a lifegroup -> NOT stopped (declining/at-risk)', () => {
    // svc 0/8, grp 3/6 (50%): attended a group, so not stopped.
    expect(computeStatus(0, 8, 3, 6, S)).not.toBe('stopped');
  });
  it('attended neither (with data) -> stopped', () => {
    expect(computeStatus(0, 8, 0, 6, S)).toBe('stopped');
  });
  it('0 service, no group data -> stopped (attended nothing)', () => {
    expect(computeStatus(0, 8, 0, 0, S)).toBe('stopped');
  });
});
