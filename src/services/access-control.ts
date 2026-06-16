import type { Actor } from '../core/entities/user';
import type { UserRole } from '../core/types/enums';
import { ForbiddenError } from '../core/errors/app-error';

// All actions in the system
export type Action =
  | 'student:read'            // view student list
  | 'student:read:sensitive'  // view mobile/parent phone
  | 'student:write'           // create/update/delete students
  | 'leader:read'             // view leaders
  | 'leader:write'            // create/update leaders (grade login, director, admin)
  | 'connection:write'        // connect/disconnect students to leaders
  | 'overview:read'           // view ministry-wide overview stats
  | 'atrisk:read'             // view at-risk data
  | 'import:run'              // upload CSV data
  | 'connection:import'       // admin-only: bulk import/export of connection allocations
  | 'admin:manage';           // settings, accounts, year-rollover

const ROLE_PERMISSIONS: Record<UserRole, Set<Action>> = {
  // grade — scoped to their grade; can manage leaders within their grade
  grade: new Set<Action>([
    'student:read',
    'student:read:sensitive',
    'leader:read',
    'leader:write',
    'connection:write',
    'overview:read',
    'atrisk:read',
  ]),
  // quad — full add/edit/allocate within their gender + year bracket
  quad: new Set<Action>([
    'student:read',
    'student:read:sensitive',
    'leader:read',
    'leader:write',
    'connection:write',
    'overview:read',
    'atrisk:read',
  ]),
  // director — ministry-wide access; can import data
  director: new Set<Action>([
    'student:read',
    'student:read:sensitive',
    'student:write',
    'leader:read',
    'leader:write',
    'connection:write',
    'overview:read',
    'atrisk:read',
    'import:run',
  ]),
  // admin — everything including back-office management
  admin: new Set<Action>([
    'student:read',
    'student:read:sensitive',
    'student:write',
    'leader:read',
    'leader:write',
    'connection:write',
    'overview:read',
    'atrisk:read',
    'import:run',
    'connection:import',
    'admin:manage',
  ]),
};

export function can(actor: Actor, action: Action): boolean {
  return ROLE_PERMISSIONS[actor.role]?.has(action) ?? false;
}

export function assertCan(actor: Actor, action: Action): void {
  if (!can(actor, action)) {
    throw new ForbiddenError(`Role '${actor.role}' cannot perform '${action}'`);
  }
}

/**
 * Returns true if the actor can access data for a given grade.
 * - grade: own grade only
 * - quad: all grades within their quad
 * - director/admin: all grades
 */
export function canAccessGrade(actor: Actor, grade: number | null): boolean {
  switch (actor.role) {
    case 'admin':
    case 'director':
      return true;
    case 'grade':
      return actor.grade != null && actor.grade === grade;
    case 'quad': {
      if (!actor.quad || grade == null) return false;
      const isJunior = grade >= 7 && grade <= 9;
      const isSenior = grade >= 10 && grade <= 12;
      if (actor.quad === 'g79' || actor.quad === 'b79') return isJunior;
      if (actor.quad === 'g1012' || actor.quad === 'b1012') return isSenior;
      return false;
    }
    default:
      return false;
  }
}

export function assertCanAccessGrade(actor: Actor, grade: number | null): void {
  if (!canAccessGrade(actor, grade)) {
    throw new ForbiddenError('Access denied to this grade');
  }
}

/**
 * Returns true if the actor's gender scope aligns with the given gender.
 * Quad logins are gender-scoped; grade and above see all genders.
 */
/** The gender a quad login is scoped to (female for g-quads, male for b-quads). */
export function quadGenderOf(quad: string | null | undefined): 'male' | 'female' | null {
  if (quad === 'g79' || quad === 'g1012') return 'female';
  if (quad === 'b79' || quad === 'b1012') return 'male';
  return null;
}

/** The year bracket a quad login is scoped to. */
export function quadGradesOf(quad: string | null | undefined): number[] {
  if (quad === 'g79' || quad === 'b79') return [7, 8, 9];
  if (quad === 'g1012' || quad === 'b1012') return [10, 11, 12];
  return [];
}

/** Normalise a gender string to 'male' | 'female' | other. */
function normGender(g: string | null | undefined): string | null {
  if (!g) return null;
  const s = g.toLowerCase();
  if (s === 'f' || s === 'female') return 'female';
  if (s === 'm' || s === 'male') return 'male';
  return s;
}

/** The gender an actor is scoped to (null = no restriction). */
export function genderScopeOf(actor: Actor): 'male' | 'female' | null {
  if (actor.role === 'quad') return quadGenderOf(actor.quad);
  if (actor.role === 'grade') return actor.gender ?? null; // ungendered grade login = both
  return null; // director/admin
}

export function canAccessGender(actor: Actor, gender: string): boolean {
  const scope = genderScopeOf(actor);
  if (scope == null) return true;
  return normGender(gender) === scope;
}

/** Combined grade + gender access — the canonical student-visibility check. */
export function canAccessStudent(actor: Actor, grade: number | null, gender: string): boolean {
  return canAccessGrade(actor, grade) && canAccessGender(actor, gender);
}
