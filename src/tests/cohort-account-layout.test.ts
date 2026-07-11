import { describe, it, expect } from 'vitest';
import { gradeBrackets, buildTargetAccounts, planCohortAccountLayout } from '../services/cohort-account-layout';

describe('gradeBrackets', () => {
  it('splits the default 7-12 range into 2-grade brackets, anchored from the top (bug 8: 7/8, 9/10, 11/12)', () => {
    expect(gradeBrackets(7, 12)).toEqual([[7, 8], [9, 10], [11, 12]]);
  });

  it('Grade 6 included: widens the LOWEST bracket to 3 grades instead of adding a 4th bracket (bug 8 follow-up)', () => {
    expect(gradeBrackets(6, 12)).toEqual([[6, 7, 8], [9, 10], [11, 12]]);
  });

  it('an odd-sized range folds the leftover grade into the lowest bracket, not a trailing singleton', () => {
    expect(gradeBrackets(7, 11)).toEqual([[7, 8, 9], [10, 11]]);
  });

  it('handles a single-grade range', () => {
    expect(gradeBrackets(9, 9)).toEqual([[9]]);
  });
});

describe('buildTargetAccounts', () => {
  it('Simple (none) yields exactly 6 grade-bracket accounts, boys+girls per bracket', () => {
    const targets = buildTargetAccounts('none', 7, 12, 'Grade');
    expect(targets).toHaveLength(6);
    expect(targets).toEqual([
      { role: 'grade', username: 'grade78g', displayName: 'Grades 7–8 Girls', grades: [7, 8], gender: 'female' },
      { role: 'grade', username: 'grade78b', displayName: 'Grades 7–8 Boys', grades: [7, 8], gender: 'male' },
      { role: 'grade', username: 'grade910g', displayName: 'Grades 9–10 Girls', grades: [9, 10], gender: 'female' },
      { role: 'grade', username: 'grade910b', displayName: 'Grades 9–10 Boys', grades: [9, 10], gender: 'male' },
      { role: 'grade', username: 'grade1112g', displayName: 'Grades 11–12 Girls', grades: [11, 12], gender: 'female' },
      { role: 'grade', username: 'grade1112b', displayName: 'Grades 11–12 Boys', grades: [11, 12], gender: 'male' },
    ]);
  });

  it('respects the "Year" grade word', () => {
    const targets = buildTargetAccounts('none', 9, 9, 'Year');
    expect(targets[0]?.displayName).toBe('Year 9 Girls');
  });

  it('Complex (grades-quads) yields one account per grade per gender plus the 4 quads', () => {
    const targets = buildTargetAccounts('grades-quads', 7, 12, 'Grade');
    expect(targets.filter((t) => t.role === 'grade')).toHaveLength(12);
    expect(targets.filter((t) => t.role === 'quad')).toHaveLength(4);
    expect(targets[0]).toEqual({ role: 'grade', username: 'grade7g', displayName: 'Grade 7 Girls', grades: [7], gender: 'female' });
    expect(targets).toContainEqual({ role: 'quad', username: 'g79', displayName: 'Girls Yr 7-9', quad: 'g79' });
  });
});

describe('planCohortAccountLayout', () => {
  it('everything to create when there are no existing accounts', () => {
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', []);
    expect(plan.toCreate).toHaveLength(6);
    expect(plan.toDeactivate).toHaveLength(0);
  });

  it('an existing account with a matching username is left alone (not re-created, not touched)', () => {
    const existing = [{ id: 'u1', role: 'grade', email: 'grade78g', displayName: 'Custom Name', status: 'active' }];
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', existing);
    expect(plan.toCreate.some((t) => t.username === 'grade78g')).toBe(false);
    expect(plan.toDeactivate).toHaveLength(0);
  });

  it('flags an active grade/quad account outside the target set for deactivation, never deletion', () => {
    const existing = [
      { id: 'u1', role: 'quad', email: 'g79', displayName: 'Girls Yr 7-9', status: 'active' },
      { id: 'u2', role: 'admin', email: 'admin', displayName: 'Admin', status: 'active' },
    ];
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', existing);
    expect(plan.toDeactivate).toEqual([{ id: 'u1', username: 'g79', displayName: 'Girls Yr 7-9' }]);
    // admin is never touched by this plan (only grade/quad roles are in scope)
  });

  it('an already-inactive out-of-target account is not re-flagged', () => {
    const existing = [{ id: 'u1', role: 'quad', email: 'g79', displayName: 'Girls Yr 7-9', status: 'inactive' }];
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', existing);
    expect(plan.toDeactivate).toHaveLength(0);
  });

  it('username matching is case-insensitive', () => {
    const existing = [{ id: 'u1', role: 'grade', email: 'GRADE78G', displayName: 'Legacy', status: 'active' }];
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', existing);
    expect(plan.toCreate.some((t) => t.username === 'grade78g')).toBe(false);
  });

  it('switching back to Complex flags the Simple-layout bracket accounts for deactivation', () => {
    const existing = [
      { id: 'u1', role: 'grade', email: 'grade78g', displayName: 'Grades 7–8 Girls', status: 'active' },
      { id: 'u2', role: 'grade', email: 'grade78b', displayName: 'Grades 7–8 Boys', status: 'active' },
    ];
    const plan = planCohortAccountLayout('grades-quads', 7, 12, 'Grade', existing);
    expect(plan.toDeactivate.map((d) => d.username).sort()).toEqual(['grade78b', 'grade78g']);
    expect(plan.toCreate).toHaveLength(16); // 12 grade + 4 quad, none pre-existing
  });

  it('mismatched is empty when the account data does not include grades/gender/quad (not checked)', () => {
    const existing = [{ id: 'u1', role: 'grade', email: 'grade78g', displayName: 'Custom Name', status: 'active' }];
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', existing);
    expect(plan.mismatched).toHaveLength(0);
  });

  it('flags a username-matched grade account whose actual grades/gender diverge from the target, without touching toCreate/toDeactivate', () => {
    const existing = [
      { id: 'u1', role: 'grade', email: 'grade78g', displayName: 'Grades 7–8 Girls', status: 'active', grades: [9, 10], gender: 'male' },
    ];
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', existing);
    expect(plan.toCreate.some((t) => t.username === 'grade78g')).toBe(false);
    expect(plan.toDeactivate).toHaveLength(0);
    expect(plan.mismatched).toHaveLength(1);
    expect(plan.mismatched[0]).toMatchObject({ id: 'u1', username: 'grade78g' });
    expect(plan.mismatched[0]?.reason).toContain('expected grades [7,8], found [9,10]');
    expect(plan.mismatched[0]?.reason).toContain('expected gender "female", found "male"');
  });

  it('flags a username-matched quad account whose actual quad diverges from the target', () => {
    const existing = [{ id: 'u1', role: 'quad', email: 'g79', displayName: 'Girls Yr 7-9', status: 'active', quad: 'b1012' }];
    const plan = planCohortAccountLayout('grades-quads', 7, 12, 'Grade', existing);
    expect(plan.mismatched).toEqual([{ id: 'u1', username: 'g79', displayName: 'Girls Yr 7-9', reason: 'expected quad "g79", found "b1012"' }]);
  });

  it('flags a role mismatch (username matches a grade target but the account is a quad, or vice versa)', () => {
    const existing = [{ id: 'u1', role: 'quad', email: 'grade78g', displayName: 'Oddly-named quad', status: 'active' }];
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', existing);
    expect(plan.mismatched).toEqual([{ id: 'u1', username: 'grade78g', displayName: 'Oddly-named quad', reason: 'expected role "grade", found "quad"' }]);
  });

  it('a correctly-matching account is never flagged', () => {
    const existing = [
      { id: 'u1', role: 'grade', email: 'grade78g', displayName: 'Grades 7–8 Girls', status: 'active', grades: [7, 8], gender: 'female' },
      { id: 'u2', role: 'quad', email: 'g79', displayName: 'Girls Yr 7-9', status: 'active', quad: 'g79' },
    ];
    expect(planCohortAccountLayout('none', 7, 12, 'Grade', [existing[0]!]).mismatched).toHaveLength(0);
    expect(planCohortAccountLayout('grades-quads', 7, 12, 'Grade', [existing[1]!]).mismatched).toHaveLength(0);
  });

  it('an inactive mismatched account is not flagged (not currently in use)', () => {
    const existing = [{ id: 'u1', role: 'grade', email: 'grade78g', displayName: 'Stale', status: 'inactive', grades: [9, 10], gender: 'male' }];
    const plan = planCohortAccountLayout('none', 7, 12, 'Grade', existing);
    expect(plan.mismatched).toHaveLength(0);
  });
});
