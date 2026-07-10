import { describe, it, expect } from 'vitest';
import { makeSettingsService } from '../services/settings.service';
import { invalidateOverviewCache, makeOverviewService } from '../services/overview.service';
import { invalidateTrendsCache } from '../services/trends.service';
import { invalidateLgStatsCache } from '../services/lifegroup-stats.service';
import { InMemorySettingsRepository, InMemoryAuditRepository, InMemoryStudentRepository, InMemoryLeaderRepository, InMemoryConnectionRepository } from '../repositories/in-memory';
import { MINISTRY_CONFIG_DEFAULTS } from '../core/ministry-config';
import type { Actor } from '../core/entities/user';

function actor(role: string): Actor {
  return { id: 'a-test', role: role as any, displayName: 'T', grade: null as any, quad: null as any };
}

const ADMIN = actor('admin');
const GRADE = actor('grade');

async function makeService() {
  invalidateOverviewCache();
  invalidateTrendsCache();
  invalidateLgStatsCache();
  const repo = new InMemorySettingsRepository();
  const audit = new InMemoryAuditRepository();
  await Promise.all([repo.init(), audit.init()]);
  return { repo, audit, service: makeSettingsService(repo, audit) };
}

describe('SettingsService', () => {
  it('get() returns ministryConfig defaulted to MINISTRY_CONFIG_DEFAULTS', async () => {
    const { service } = await makeService();
    const settings = await service.get();
    expect(settings.ministryConfig).toEqual(MINISTRY_CONFIG_DEFAULTS);
  });

  it('rejects a ministryConfig patch from a non-admin actor', async () => {
    const { service } = await makeService();
    await expect(
      service.update(GRADE, { ministryConfig: { branding: { accent: '#ff0000' } } }),
    ).rejects.toThrow();
  });

  it('PATCH with only ministryConfig.branding.accent leaves every other field at default, and existing scalar fields untouched', async () => {
    const { service } = await makeService();
    const before = await service.get();
    const updated = await service.update(ADMIN, { ministryConfig: { branding: { accent: '#ff0000' } } });

    expect(updated.ministryConfig.branding.accent).toBe('#ff0000');
    expect(updated.ministryConfig.branding.ministryName).toBe(MINISTRY_CONFIG_DEFAULTS.branding.ministryName);
    expect(updated.ministryConfig.labels).toEqual(MINISTRY_CONFIG_DEFAULTS.labels);
    expect(updated.termGapDays).toBe(before.termGapDays);
    expect(updated.serviceMinAttendance).toBe(before.serviceMinAttendance);
  });

  it('a second partial patch merges onto the first, not onto the defaults', async () => {
    const { service } = await makeService();
    await service.update(ADMIN, { ministryConfig: { branding: { accent: '#ff0000' } } });
    const second = await service.update(ADMIN, { ministryConfig: { labels: { smallGroup: 'Small Group' } } });

    expect(second.ministryConfig.branding.accent).toBe('#ff0000'); // preserved from the first patch
    expect(second.ministryConfig.labels.smallGroup).toBe('Small Group');
  });

  it('PATCH with termGapDays alone (no ministryConfig) still works exactly as before', async () => {
    const { service } = await makeService();
    const updated = await service.update(ADMIN, { termGapDays: 21 });
    expect(updated.termGapDays).toBe(21);
    expect(updated.ministryConfig).toEqual(MINISTRY_CONFIG_DEFAULTS);
  });

  it('sanitises a logoSvg patch', async () => {
    const { service } = await makeService();
    const updated = await service.update(ADMIN, {
      ministryConfig: { branding: { logoSvg: '<svg><script>alert(1)</script></svg>' } },
    });
    expect(updated.ministryConfig.branding.logoSvg).not.toContain('<script');
  });

  it('invalidates the overview/trends/lifegroup-stats caches on every update', async () => {
    const studentRepo = new InMemoryStudentRepository();
    const leaderRepo = new InMemoryLeaderRepository();
    const connRepo = new InMemoryConnectionRepository();
    await Promise.all([studentRepo.init(), leaderRepo.init(), connRepo.init()]);
    const overviewSvc = makeOverviewService(studentRepo, leaderRepo, connRepo);

    const { service } = await makeService();

    const first = await overviewSvc.getStats(ADMIN);
    expect(first.ministryTotal).toBe(0);

    // Write a connectable student directly via the repo, bypassing overview's
    // own invalidation hooks — simulates the cache staying warm across an
    // unrelated settings change.
    await studentRepo.save({
      id: 's1', firstName: 'A', lastName: 'B', gender: 'female', grade: 9,
      quad: null, mobile: null, parentPhone: null, dateOfBirth: null,
      svcAttended: 1, svcTotal: 1, grpAttended: 0, grpTotal: 0, grpMetWeeks: 0,
      prevSvcAttended: 0, prevSvcTotal: 0, prevGrpAttended: 0, prevGrpTotal: 0,
      atRiskStatus: null, dataSource: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const stillCached = await overviewSvc.getStats(ADMIN);
    expect(stillCached.ministryTotal).toBe(0);

    await service.update(ADMIN, { termGapDays: 20 });

    const afterSettingsUpdate = await overviewSvc.getStats(ADMIN);
    expect(afterSettingsUpdate.ministryTotal).toBe(1); // fresh — proves settings.update() invalidated it
  });
});
