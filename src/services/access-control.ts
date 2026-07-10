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
 * The effective set of grades a grade login manages (§5.1a). Prefers the new
 * multi-grade `grades` array; falls back to the legacy single `grade` so old
 * tokens and existing single-grade seeded accounts behave identically. Returns
 * [] for a grade login with no grade at all, and for non-grade roles (their
 * grade access is decided elsewhere in canAccessGrade).
 */
export function actorGrades(actor: Actor): number[] {
  if (actor.grades && actor.grades.length > 0) return actor.grades;
  return actor.grade != null ? [actor.grade] : [];
}

/**
 * Structure config relevant to scoping (§5.1/§5.2 of the generalisation design).
 * Passed by services from `settings.ministryConfig.structure`. Optional at every
 * call site so the existing tests (which don't pass it) and any not-yet-migrated
 * caller keep today's YS Brisbane behaviour: undefined ⇒ grades-quads + strict.
 */
export interface StructureScope {
  cohortModel?: 'grades-quads' | 'none';
  genderPolicy?: 'strict' | 'soft' | 'off';
}

/**
 * Returns true if the actor can access data for a given grade.
 * - grade: own grade only
 * - quad: all grades within their quad
 * - director/admin: all grades
 * Under cohortModel 'none' there is no cohorting at all, so every login can
 * access every grade (nothing is scoped/excluded by grade).
 */
export function canAccessGrade(actor: Actor, grade: number | null, structure?: StructureScope): boolean {
  if (structure?.cohortModel === 'none') return true;
  switch (actor.role) {
    case 'admin':
    case 'director':
      return true;
    case 'grade':
      // Multi-grade grade accounts (§5.1a): access any of the actor's grades.
      // actorGrades() falls back to [actor.grade] for legacy single-grade
      // accounts, so this is byte-identical for YS Brisbane's existing logins.
      return grade != null && actorGrades(actor).includes(grade);
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

/**
 * The gender an actor is scoped to (null = no restriction). Under a non-strict
 * genderPolicy ('soft' or 'off') gender never scopes reads for anyone — the
 * existing ungendered-login seam promoted to a deployment-wide policy.
 */
export function genderScopeOf(actor: Actor, structure?: StructureScope): 'male' | 'female' | null {
  // cohortModel 'none' means no cohorting at all — nothing may be excluded by
  // grade OR gender (the design's "known trap": 'none' must never hide anyone),
  // so gender scoping is off regardless of genderPolicy.
  if (structure?.cohortModel === 'none') return null;
  if (structure && structure.genderPolicy && structure.genderPolicy !== 'strict') return null;
  if (actor.role === 'quad') return quadGenderOf(actor.quad);
  if (actor.role === 'grade') return actor.gender ?? null; // ungendered grade login = both
  return null; // director/admin
}

export function canAccessGender(actor: Actor, gender: string, structure?: StructureScope): boolean {
  const scope = genderScopeOf(actor, structure);
  if (scope == null) return true;
  return normGender(gender) === scope;
}

/** Combined grade + gender access — the canonical student-visibility check. */
export function canAccessStudent(actor: Actor, grade: number | null, gender: string, structure?: StructureScope): boolean {
  return canAccessGrade(actor, grade, structure) && canAccessGender(actor, gender, structure);
}
