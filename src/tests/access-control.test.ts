import { describe, it, expect } from 'vitest';
import { can, assertCan, canAccessGrade, canAccessGender, canAccessStudent } from '../services/access-control';
import { deriveActorGender } from '../services/auth.service';
import type { Actor, User } from '../core/entities/user';
import { ForbiddenError } from '../core/errors/app-error';

// Test helpers
function actor(role: string, opts: { grade?: number; quad?: string; gender?: 'male' | 'female' | null } = {}): Actor {
  return { id: 'test', role: role as any, displayName: 'Test', grade: (opts.grade ?? null) as any, quad: (opts.quad ?? null) as any, gender: opts.gender ?? null };
}

describe('RBAC — can()', () => {
  // TC01 — grade login can read students
  it('TC01: grade can read students', () => {
    expect(can(actor('grade', { grade: 9 }), 'student:read')).toBe(true);
  });

  // TC02 — grade login can write leaders
  it('TC02: grade can write leaders', () => {
    expect(can(actor('grade', { grade: 9 }), 'leader:write')).toBe(true);
  });

  // TC03 — grade login CANNOT import CSV
  it('TC03: grade cannot import', () => {
    expect(can(actor('grade', { grade: 9 }), 'import:run')).toBe(false);
  });

  // TC04 — grade login CANNOT manage admin
  it('TC04: grade cannot admin:manage', () => {
    expect(can(actor('grade', { grade: 9 }), 'admin:manage')).toBe(false);
  });

  // TC05 — quad login CAN write leaders (scoped to gender + bracket; see leader.service.test)
  it('TC05: quad can write leaders', () => {
    expect(can(actor('quad', { quad: 'g79' }), 'leader:write')).toBe(true);
  });

  // Gendered grade login: own grade + own gender only.
  it('gendered grade login sees only its own gender; ungendered sees both', () => {
    const g7girls = actor('grade', { grade: 7, gender: 'female' });
    expect(canAccessStudent(g7girls, 7, 'female')).toBe(true);
    expect(canAccessStudent(g7girls, 7, 'male')).toBe(false);   // wrong gender
    expect(canAccessStudent(g7girls, 8, 'female')).toBe(false); // wrong grade
    expect(canAccessGender(g7girls, 'female')).toBe(true);
    expect(canAccessGender(g7girls, 'male')).toBe(false);
    // Ungendered grade login (no gender derived) still sees both genders.
    const g7 = actor('grade', { grade: 7, gender: null });
    expect(canAccessStudent(g7, 7, 'male')).toBe(true);
    expect(canAccessStudent(g7, 7, 'female')).toBe(true);
  });

  // deriveActorGender from the email convention.
  it('deriveActorGender reads grade email g/b suffix and quad gender', () => {
    const mk = (role: string, email: string, quad?: string): User =>
      ({ id: 'u', displayName: 'X', email, role: role as any, grade: 7 as any, quad: (quad ?? null) as any, status: 'active', createdAt: '', updatedAt: '' });
    expect(deriveActorGender(mk('grade', 'grade7g@youth.ministry'))).toBe('female');
    expect(deriveActorGender(mk('grade', 'grade7b@youth.ministry'))).toBe('male');
    expect(deriveActorGender(mk('grade', 'grade7@youth.ministry'))).toBeNull(); // no suffix
    expect(deriveActorGender(mk('quad', 'b1012@youth.ministry', 'b1012'))).toBe('male');
    expect(deriveActorGender(mk('admin', 'admin@youth.ministry'))).toBeNull();
  });

  // TC06 — quad login can allocate
  it('TC06: quad can allocate', () => {
    expect(can(actor('quad', { quad: 'g79' }), 'connection:write')).toBe(true);
  });

  // TC07 — director can import
  it('TC07: director can import', () => {
    expect(can(actor('director'), 'import:run')).toBe(true);
  });

  // TC08 — director cannot admin:manage
  it('TC08: director cannot admin:manage', () => {
    expect(can(actor('director'), 'admin:manage')).toBe(false);
  });

  // TC09 — admin can do everything
  it('TC09: admin has all permissions', () => {
    const a = actor('admin');
    expect(can(a, 'admin:manage')).toBe(true);
    expect(can(a, 'import:run')).toBe(true);
    expect(can(a, 'student:write')).toBe(true);
    expect(can(a, 'leader:write')).toBe(true);
  });

  // TC10 — assertCan throws for forbidden
  it('TC10: assertCan throws ForbiddenError', () => {
    expect(() => assertCan(actor('grade', { grade: 7 }), 'admin:manage')).toThrow(ForbiddenError);
  });
});

describe('canAccessGrade()', () => {
  // TC11 — grade login accesses own grade
  it('TC11: grade accesses own grade', () => {
    expect(canAccessGrade(actor('grade', { grade: 9 }), 9)).toBe(true);
  });

  // TC12 — grade login denied other grade
  it('TC12: grade denied other grade', () => {
    expect(canAccessGrade(actor('grade', { grade: 9 }), 10)).toBe(false);
  });

  // TC13 — g79 quad accesses Gr 7
  it('TC13: g79 quad accesses Gr 7', () => {
    expect(canAccessGrade(actor('quad', { quad: 'g79' }), 7)).toBe(true);
  });

  // TC14 — g79 quad denied Gr 10
  it('TC14: g79 quad denied Gr 10', () => {
    expect(canAccessGrade(actor('quad', { quad: 'g79' }), 10)).toBe(false);
  });

  // TC15 — b1012 quad accesses Gr 11
  it('TC15: b1012 quad accesses Gr 11', () => {
    expect(canAccessGrade(actor('quad', { quad: 'b1012' }), 11)).toBe(true);
  });

  // TC16 — director accesses any grade
  it('TC16: director accesses any grade', () => {
    expect(canAccessGrade(actor('director'), 7)).toBe(true);
    expect(canAccessGrade(actor('director'), 12)).toBe(true);
  });

  // TC17 — grade login with null grade returns false
  it('TC17: grade with null grade returns false', () => {
    expect(canAccessGrade(actor('grade', {}), 9)).toBe(false);
  });
});

describe('canAccessGender()', () => {
  // TC18 — g79 quad can access female students
  it('TC18: g79 quad can access female', () => {
    expect(canAccessGender(actor('quad', { quad: 'g79' }), 'female')).toBe(true);
  });

  // TC19 — g79 quad denied male students
  it('TC19: g79 quad denied male', () => {
    expect(canAccessGender(actor('quad', { quad: 'g79' }), 'male')).toBe(false);
  });

  // TC20 — b79 quad can access male students
  it('TC20: b79 quad can access male', () => {
    expect(canAccessGender(actor('quad', { quad: 'b79' }), 'male')).toBe(true);
  });

  // TC21 — grade login can access any gender
  it('TC21: grade can access any gender', () => {
    expect(canAccessGender(actor('grade', { grade: 8 }), 'male')).toBe(true);
    expect(canAccessGender(actor('grade', { grade: 8 }), 'female')).toBe(true);
  });

  // TC22 — director can access any gender
  it('TC22: director can access any gender', () => {
    expect(canAccessGender(actor('director'), 'female')).toBe(true);
    expect(canAccessGender(actor('director'), 'male')).toBe(true);
  });
});
