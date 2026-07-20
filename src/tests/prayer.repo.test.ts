import { describe, it, expect } from 'vitest';
import { InMemoryPrayerRepository } from '../repositories/in-memory';
import type { PrayerRequest } from '../core/entities/prayer';

const mk = (id: string, studentId: string): PrayerRequest => ({
  id, studentId, text: 't', status: 'open', answerNote: null,
  createdByLabel: 'Sarah', createdByRole: 'grade',
  createdByGrades: null, createdByGender: null,
  createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', answeredAt: null,
});

describe('InMemoryPrayerRepository', () => {
  it('findByStudent returns only that student\'s prayers', async () => {
    const repo = new InMemoryPrayerRepository();
    await repo.init();
    await repo.save(mk('p1', 's1'));
    await repo.save(mk('p2', 's1'));
    await repo.save(mk('p3', 's2'));
    const s1 = await repo.findByStudent('s1');
    expect(s1.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('L1 (2026-07-19): findByStudent sorts newest first (created_at desc), matching Supabase', async () => {
    const repo = new InMemoryPrayerRepository();
    await repo.init();
    await repo.save({ ...mk('p1', 's1'), createdAt: '2026-01-01T00:00:00.000Z' });
    await repo.save({ ...mk('p2', 's1'), createdAt: '2026-03-01T00:00:00.000Z' });
    await repo.save({ ...mk('p3', 's1'), createdAt: '2026-02-01T00:00:00.000Z' });
    const rows = await repo.findByStudent('s1');
    expect(rows.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
  });

  it('M1 (2026-07-19): deleteByStudent removes only that student\'s prayers, leaving general ones untouched', async () => {
    const repo = new InMemoryPrayerRepository();
    await repo.init();
    await repo.save(mk('p1', 's1'));
    await repo.save(mk('p2', 's1'));
    await repo.save(mk('p3', 's2'));
    await repo.save({ ...mk('p4', 's1'), studentId: null });
    await repo.deleteByStudent('s1');
    const remaining = await repo.findAll();
    expect(remaining.map((p) => p.id).sort()).toEqual(['p3', 'p4']);
  });
});
