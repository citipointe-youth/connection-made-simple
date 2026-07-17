import { describe, it, expect } from 'vitest';
import { InMemoryPrayerRepository } from '../repositories/in-memory';
import type { PrayerRequest } from '../core/entities/prayer';

const mk = (id: string, studentId: string): PrayerRequest => ({
  id, studentId, text: 't', status: 'open', answerNote: null,
  createdByLabel: 'Sarah', createdByRole: 'grade',
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
});
