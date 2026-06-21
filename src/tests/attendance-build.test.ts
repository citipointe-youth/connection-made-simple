import { describe, it, expect } from 'vitest';
import { buildServiceModel, buildGroupModel, normaliseServiceDate } from '../services/attendance-build';

describe('normaliseServiceDate', () => {
  it('passes ISO through and normalises Excel short-dates', () => {
    expect(normaliseServiceDate('2026-02-06')).toBe('2026-02-06');
    expect(normaliseServiceDate('7-Feb-25')).toBe('2025-02-07');
    expect(normaliseServiceDate('not-a-date')).toBeNull();
  });
});

describe('buildServiceModel', () => {
  it('builds sessions, roster and name-keyed attendance with validity', () => {
    const rows = [
      { first_name: 'Ava', last_name: 'Okafor', gender: 'female', grade: 9, '2026-02-06': 'Y', '2026-02-13': '' },
      { first_name: 'Eli', last_name: 'Borowski', gender: 'male', grade: 10, '2026-02-06': 'Y', '2026-02-13': 'Y' },
    ];
    const m = buildServiceModel(rows, 1);
    expect(m.sessions).toHaveLength(2);
    expect(m.roster.map((r) => r.nameKey).sort()).toEqual(['ava okafor', 'eli borowski']);
    // 2026-02-06 has 2 attendees (valid); 2026-02-13 has 1 (>=1 floor, valid too)
    const s06 = m.sessions.find((s) => s.sessionDate === '2026-02-06')!;
    expect(s06.isValid).toBe(true);
    const avaTo06 = m.attendance.find((a) => a.nameKey === 'ava okafor' && a.sessionId === s06.id)!;
    expect(avaTo06.attended).toBe(true);
  });

  it('marks a session invalid when below the attendance floor', () => {
    const rows = [{ first_name: 'Ava', last_name: 'Okafor', gender: 'female', grade: 9, '2026-02-06': 'Y' }];
    const m = buildServiceModel(rows, 100); // floor 100, only 1 attendee
    expect(m.sessions[0]!.isValid).toBe(false);
  });
});

describe('buildGroupModel', () => {
  it('excludes leaders and zero-week members, keeps youth attendance', () => {
    const m = buildGroupModel([{
      name: 'Grade 9 Girls Lifegroup',
      meetings: ['2026-02-09', '2026-02-16'],
      members: [
        { first_name: 'Ava', last_name: 'Okafor', attendance: [true, false] },
        { first_name: 'Mia (Leader)', last_name: 'Stone', attendance: [true, true] },
        { first_name: 'Ghost', last_name: 'Member', attendance: [null, null] },
      ],
    }]);
    expect(m.roster.map((r) => r.nameKey)).toEqual(['ava okafor']);
    expect(m.weeks).toHaveLength(2);
    const ava = m.attendance.filter((a) => a.nameKey === 'ava okafor');
    expect(ava).toHaveLength(2);
    expect(ava.filter((a) => a.attended)).toHaveLength(1);
  });
});
