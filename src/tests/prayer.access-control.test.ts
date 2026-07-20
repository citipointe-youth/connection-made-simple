import { describe, it, expect } from 'vitest';
import { can, canAccessGeneralPrayer, generalPrayerCreatorScope } from '../services/access-control';
import type { Actor } from '../core/entities/user';

const A = (role: string, opts: { grade?: number; gender?: string; quad?: string } = {}): Actor =>
  ({ id: 'a', role: role as any, displayName: 'T',
     grade: (opts.grade ?? null) as any, gender: (opts.gender ?? null) as any, quad: (opts.quad ?? null) as any });

describe('Prayer RBAC', () => {
  it('all five roles can read and write prayers', () => {
    for (const r of ['leader', 'grade', 'quad', 'director', 'admin']) {
      expect(can(A(r), 'prayer:read')).toBe(true);
      expect(can(A(r), 'prayer:write')).toBe(true);
    }
  });
  it('only admin can import prayers', () => {
    expect(can(A('admin'), 'prayer:import')).toBe(true);
    for (const r of ['leader', 'grade', 'quad', 'director']) {
      expect(can(A(r), 'prayer:import')).toBe(false);
    }
  });
});

describe('generalPrayerCreatorScope', () => {
  it('grade/quad creators get their own bracket+gender; admin/director/leader get no boundary', () => {
    expect(generalPrayerCreatorScope(A('grade', { grade: 9, gender: 'female' }))).toEqual({ grades: [9], gender: 'female' });
    expect(generalPrayerCreatorScope(A('quad', { quad: 'b79' }))).toEqual({ grades: [7, 8, 9], gender: 'male' });
    expect(generalPrayerCreatorScope(A('admin'))).toEqual({ grades: null, gender: null });
    expect(generalPrayerCreatorScope(A('director'))).toEqual({ grades: null, gender: null });
    expect(generalPrayerCreatorScope(A('leader'))).toEqual({ grades: null, gender: null });
  });
});

describe('canAccessGeneralPrayer', () => {
  const G9F = A('grade', { grade: 9, gender: 'female' });
  const G9M = A('grade', { grade: 9, gender: 'male' });
  const G8M = A('grade', { grade: 8, gender: 'male' });
  const QB79 = A('quad', { quad: 'b79' });
  const QB1012 = A('quad', { quad: 'b1012' });

  it('a wide-open (admin/director/leader) creator scope is visible to everyone', () => {
    for (const viewer of [G9F, QB79, A('admin'), A('director'), A('leader')]) {
      expect(canAccessGeneralPrayer(viewer, null, null)).toBe(true);
    }
  });
  it("admin/director viewers see everything regardless of the creator's scope", () => {
    for (const viewer of [A('admin'), A('director')]) {
      expect(canAccessGeneralPrayer(viewer, [9], 'female')).toBe(true);
    }
  });
  it('H2 (2026-07-19): a leader viewer sees only unscoped (null/null) general prayers, not a grade/quad-scoped one', () => {
    expect(canAccessGeneralPrayer(A('leader'), null, null)).toBe(true);
    expect(canAccessGeneralPrayer(A('leader'), [9], 'female')).toBe(false);
    expect(canAccessGeneralPrayer(A('leader'), [7, 8, 9], 'male')).toBe(false);
  });
  it('a grade-scoped prayer is visible only within the same grade+gender', () => {
    expect(canAccessGeneralPrayer(G9F, [9], 'female')).toBe(true);
    expect(canAccessGeneralPrayer(G9M, [9], 'female')).toBe(false); // same grade, different gender
    expect(canAccessGeneralPrayer(G8M, [9], 'female')).toBe(false); // different grade
  });
  it("a quad-scoped prayer is visible to grades within that quad's bracket+gender", () => {
    expect(canAccessGeneralPrayer(A('grade', { grade: 7, gender: 'male' }), [7, 8, 9], 'male')).toBe(true);
    expect(canAccessGeneralPrayer(A('grade', { grade: 9, gender: 'male' }), [7, 8, 9], 'male')).toBe(true);
    expect(canAccessGeneralPrayer(A('grade', { grade: 9, gender: 'female' }), [7, 8, 9], 'male')).toBe(false);
    expect(canAccessGeneralPrayer(A('grade', { grade: 10, gender: 'male' }), [7, 8, 9], 'male')).toBe(false);
    expect(canAccessGeneralPrayer(QB1012, [7, 8, 9], 'male')).toBe(false); // non-overlapping bracket
  });

  it('L2: a null grades axis imposes no grade boundary (symmetric with the gender branch)', () => {
    // grades null, gender set — e.g. an ungendered grade login's general prayer
    // (actorGrades non-empty, genderScopeOf null). Any grade may view it as
    // long as gender matches (or the viewer is ungendered too).
    expect(canAccessGeneralPrayer(A('grade', { grade: 9, gender: 'female' }), null, 'female')).toBe(true);
    expect(canAccessGeneralPrayer(A('grade', { grade: 9, gender: 'male' }), null, 'female')).toBe(false);
    // grades set, gender null — grade must still overlap; any gender passes.
    expect(canAccessGeneralPrayer(A('grade', { grade: 9, gender: 'male' }), [9], null)).toBe(true);
    expect(canAccessGeneralPrayer(A('grade', { grade: 8, gender: 'male' }), [9], null)).toBe(false);
    // both null is still the pre-existing "wide open" shortcut.
    expect(canAccessGeneralPrayer(A('grade', { grade: 9, gender: 'female' }), null, null)).toBe(true);
  });
});
