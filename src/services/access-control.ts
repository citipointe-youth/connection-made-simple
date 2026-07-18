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
  | 'admin:manage'            // settings, accounts, year-rollover
  | 'prayer:read'             // view prayer requests in scope
  | 'prayer:write'            // add/edit/mark/delete a prayer in scope
  | 'prayer:import';          // admin-only: bulk CSV import/export of prayers

const ROLE_PERMISSIONS: Record<UserRole, Set<Action>> = {
  // leader (junior leader, §5.2) — read-only, scoped to their OWN connected
  // students. Can view students (incl. phone for call sheets), their at-risk
  // health, and leader records. No connection:write, no leader:write, no
  // overview:read (no ministry-wide stats), no import/admin.
  leader: new Set<Action>([
    'student:read',
    'student:read:sensitive',
    'leader:read',
    'atrisk:read',
    'prayer:read',
    'prayer:write',
  ]),
  // grade — scoped to their grade; can manage leaders within their grade
  grade: new Set<Action>([
    'student:read',
    'student:read:sensitive',
    'leader:read',
    'leader:write',
    'connection:write',
    'overview:read',
    'atrisk:read',
    'prayer:read',
    'prayer:write',
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
    'prayer:read',
    'prayer:write',
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
    'prayer:read',
    'prayer:write',
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
    'prayer:read',
    'prayer:write',
    'prayer:import',
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
 * A junior-leader (§5.2) may only act on their OWN linked leader record. Used to
 * lock leaderId-parameterised read paths (own connections, own follow-up) so a
 * `leader` login can't pass another leader's id. No-op for every other role.
 */
export function assertLeaderSelf(actor: Actor, leaderId: string): void {
  if (actor.role === 'leader' && actor.leaderId !== leaderId) {
    throw new ForbiddenError('Junior leaders can only view their own connections');
  }
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
 * - grade: own grade(s) only — a Simple-ministry grade login is scoped to its
 *   assigned (broader) bracket exactly the same way a Complex-ministry one is
 *   scoped to a single grade; cohortModel only changes how many grades an
 *   account is assigned (via the account layout it was created with), never
 *   whether the assignment is enforced (bug 8 follow-up, 2026-07-11 — an
 *   earlier version of this function bypassed grade scoping entirely under
 *   'none', which made Simple's per-bracket accounts purely cosmetic).
 * - quad: all grades within their quad (not used under a Simple layout, which
 *   has no quad accounts, but scoped the same way if one exists)
 * - director/admin: all grades
 */
// `structure` param kept (unused here) for call-site symmetry with
// canAccessGender/genderScopeOf below, which do read it.
export function canAccessGrade(actor: Actor, grade: number | null, structure?: StructureScope): boolean {
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
  // Gender scoping is governed by genderPolicy alone — cohortModel used to
  // also force this off under 'none' ("nothing may be excluded by grade OR
  // gender"), but that made a Simple ministry's own boys/girls-bracket
  // accounts non-functional as scoping (bug 8 follow-up, 2026-07-11): a
  // grade login's assigned gender is enforced exactly the same under Simple
  // as under Complex now. cohortModel only changes account LAYOUT (broad
  // brackets + no quads, vs one account per grade + quad rollups), never
  // whether an account's own grades/gender are enforced.
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

/**
 * The grade+gender "domain" a general (no-student) prayer inherits from its
 * creator, captured at creation time (prayer.service.ts's `create()`) since we
 * don't keep a live reference to the creating user. `grades: null` + `gender:
 * null` together mean "no boundary" (admin/director, or a junior leader — see
 * below) — a general prayer created by one of those is visible to everyone.
 */
export function generalPrayerCreatorScope(
  actor: Actor,
  structure?: StructureScope,
): { grades: number[] | null; gender: 'male' | 'female' | null } {
  if (actor.role === 'grade') {
    const grades = actorGrades(actor);
    return { grades: grades.length ? grades : null, gender: genderScopeOf(actor, structure) };
  }
  if (actor.role === 'quad') {
    const grades = quadGradesOf(actor.quad);
    return { grades: grades.length ? grades : null, gender: genderScopeOf(actor, structure) };
  }
  // admin/director have no grade/gender boundary of their own (ministry-wide).
  // A junior `leader` is bound to one Leader record, not a grade/gender cohort —
  // there's no meaningful boundary to derive, so it's left wide open too (same
  // as before this scoping existed; unchanged on purpose, not asked for).
  return { grades: null, gender: null };
}

/**
 * Can `actor` see a general (no-student) prayer created by someone with the
 * given creator scope (from `generalPrayerCreatorScope`)? admin/director/leader
 * viewers always can. A grade/quad viewer can see it only if their own
 * grade+gender domain overlaps the creator's — e.g. a quad's general prayer is
 * visible to the grade logins within that quad's bracket+gender (and to other
 * quads/grades that happen to share both), but not to a different gender or a
 * non-overlapping grade bracket.
 */
export function canAccessGeneralPrayer(
  actor: Actor,
  createdByGrades: number[] | null,
  createdByGender: 'male' | 'female' | null,
  structure?: StructureScope,
): boolean {
  if (actor.role === 'admin' || actor.role === 'director' || actor.role === 'leader') return true;
  if (createdByGrades == null && createdByGender == null) return true;
  const viewerGrades = actor.role === 'quad' ? quadGradesOf(actor.quad) : actorGrades(actor);
  if (!(createdByGrades ?? []).some((g) => viewerGrades.includes(g))) return false;
  const viewerGender = genderScopeOf(actor, structure);
  if (createdByGender != null && viewerGender != null && createdByGender !== viewerGender) return false;
  return true;
}
