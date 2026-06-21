import { describe, it, expect } from 'vitest';
import { makeConnectionAuditService } from '../services/connection-audit.service';
import { InMemoryConnectionAuditRepository, InMemorySettingsRepository } from '../repositories/in-memory';
import type { Actor } from '../core/entities/user';
import { ForbiddenError } from '../core/errors/app-error';

function actor(role: string): Actor {
  return { id: 'a', role: role as any, displayName: 'T', grade: null as any, quad: null as any };
}

async function svc() {
  const repo = new InMemoryConnectionAuditRepository();
  const settings = new InMemorySettingsRepository();
  await repo.init();
  await settings.init();
  await settings.updateSettings({ serviceMinAttendance: 1 }); // tiny test data
  return makeConnectionAuditService(repo, settings);
}

// A minimal YTD service upload: 3 Fridays, two in Term 1 and one after a gap in
// Term 2, plus one student attending all three. Group/CRM uploads empty.
function uploadPayload() {
  return {
    service: {
      rows: [
        { first_name: 'Ava', last_name: 'Okafor', gender: 'female', grade: 9,
          '2026-02-06': 'Y', '2026-02-13': 'Y', '2026-04-24': 'Y' },
      ],
    },
    group: { groups: [] },
    team: [], connect: [], decision: [], flows: [],
  };
}

describe('ConnectionAuditService', () => {
  it('rejects non-director/admin upload', async () => {
    const s = await svc();
    await expect(s.upload(actor('grade'), uploadPayload())).rejects.toThrow(ForbiddenError);
  });

  it('director upload computes terms and stores one row per year', async () => {
    const s = await svc();
    const a = await s.upload(actor('director'), uploadPayload());
    expect(a.year).toBe(2026);
    expect(a.id).toBe('2026');
    expect(a.snapshot.terms.map((t) => t.key)).toEqual(['2026-T1', '2026-T2']);
    // The latest term is flagged in progress (mid-term / YTD).
    expect(a.snapshot.perTerm['2026-T2']!.inProgress).toBe(true);
    expect(a.snapshot.perTerm['2026-T1']!.inProgress).toBe(false);
    // Ava attended both T1 services and the single T2 service.
    const ava = a.snapshot.students[0]!;
    expect(a.snapshot.perTerm['2026-T1']!.byStudent[ava.id]!.svcAttended).toBe(2);
    expect(a.snapshot.perTerm['2026-T2']!.byStudent[ava.id]!.svcAttended).toBe(1);
    const list = await s.list(actor('admin'));
    expect(list).toHaveLength(1);
    expect(list[0]!.year).toBe(2026);
  });

  it('re-upload overwrites the same year (latest-per-year)', async () => {
    const s = await svc();
    await s.upload(actor('director'), uploadPayload());
    await s.upload(actor('director'), uploadPayload());
    const list = await s.list(actor('admin'));
    expect(list).toHaveLength(1);
  });

  it('get returns the stored audit; remove deletes it', async () => {
    const s = await svc();
    await s.upload(actor('director'), uploadPayload());
    expect(await s.get(actor('admin'), 2026)).not.toBeNull();
    await s.remove(actor('admin'), 2026);
    expect(await s.get(actor('admin'), 2026)).toBeNull();
  });
});
