// Pure helpers for the admin "Apply account layout" action (bug 8, admin bug
// list 2026-07-11): switching Youth Setup's Cohort model between Complex
// (grades-quads) and Simple (none) doesn't touch Accounts on its own — this
// is the explicit, separate, confirm-gated action that does, via
// account.service.ts's planCohortLayout/applyCohortLayout. No repository/I-O
// imports here, same pattern as connection-allocations.ts, so the plan is
// unit-testable without a database.

export type CohortModel = 'grades-quads' | 'none';

export type TargetAccountSpec =
  | { role: 'grade'; username: string; displayName: string; grades: number[]; gender: 'male' | 'female' }
  | { role: 'quad'; username: string; displayName: string; quad: 'g79' | 'b79' | 'g1012' | 'b1012' };

export interface ExistingAccountLite {
  id: string;
  role: string;
  email: string;
  displayName: string;
  status: string;
  // Optional: when supplied, lets planCohortAccountLayout also detect a
  // username-matched account whose actual grades/gender/quad have drifted
  // from what that username's target spec expects (see `mismatched` below).
  // Omit (or leave undefined) to skip that check for a given account —
  // existing callers/tests that don't have this data keep working unchanged.
  grades?: number[] | null;
  gender?: string | null;
  quad?: string | null;
}

export interface CohortLayoutMismatch {
  id: string;
  username: string;
  displayName: string;
  reason: string;
}

export interface CohortLayoutPlan {
  targetCohort: CohortModel;
  toCreate: TargetAccountSpec[];
  toDeactivate: { id: string; username: string; displayName: string }[];
  // Active accounts whose username matches a target exactly — so `toCreate`/
  // `toDeactivate` leave them untouched, per this plan's "never edit a
  // matched account" rule — but whose actual role/grades/gender/quad have
  // drifted from what that username's target spec expects (e.g. a hand-edited
  // account, or leftover fields from before a Structure change). Informational
  // only: surfaced as a warning in Youth Setup, never auto-fixed.
  mismatched: CohortLayoutMismatch[];
}

// "Grade N" | "Grades N–M" — mirrors the SPA's gradeBadgeLabel()/gradesLabel()
// for a contiguous bracket (all brackets built by gradeBrackets() below are
// contiguous, so the non-contiguous ", "-joined case never applies here).
function gradeWordLabel(grades: number[], gradeWord: string): string {
  const g = [...grades].sort((a, b) => a - b);
  const nums = g.length > 1 ? `${g[0]}–${g[g.length - 1]}` : String(g[0]);
  return `${gradeWord}${g.length > 1 ? 's' : ''} ${nums}`;
}

// Split [gradeMin, gradeMax] into brackets, anchored from the TOP down in
// pairs — the default 7-12 range yields [[7,8],[9,10],[11,12]] (bug 8's
// "boys and girls 7/8, 9/10, 11/12"). Anything below the top two pairs folds
// into ONE lowest bracket instead of spawning a separate one: with Grade 6
// included (gradeMin 6), the range 6-12 yields [[6,7,8],[9,10],[11,12]] — the
// 7/8 account widens to 6-7-8, it does NOT become a 4th account (bug 8
// follow-up, 2026-07-11 — "the 7,8 account should include grade 6, not a
// separate grade 6 account"). gradeMax is always 12 in practice (the Youth
// Setup UI no longer exposes it), but this stays generic over both bounds.
export function gradeBrackets(gradeMin: number, gradeMax: number): number[][] {
  const top: number[][] = [];
  let g = gradeMax;
  while (g - 1 >= gradeMin + 2) { top.unshift([g - 1, g]); g -= 2; }
  const lowest: number[] = [];
  for (let n = gradeMin; n <= g; n++) lowest.push(n);
  if (lowest.length) top.unshift(lowest);
  return top;
}

const QUAD_TARGETS: { quad: 'g79' | 'b79' | 'g1012' | 'b1012'; label: string }[] = [
  { quad: 'g79', label: 'Girls Yr 7-9' },
  { quad: 'b79', label: 'Boys Yr 7-9' },
  { quad: 'g1012', label: 'Girls Yr 10-12' },
  { quad: 'b1012', label: 'Boys Yr 10-12' },
];

// The full target account set for a cohort model — 'none' (Simple) is the 6
// grade-bracket accounts; 'grades-quads' (Complex) is one account per grade
// per gender plus the 4 quads (mirrors the app's own seed layout).
export function buildTargetAccounts(
  targetCohort: CohortModel,
  gradeMin: number,
  gradeMax: number,
  gradeWord: string,
): TargetAccountSpec[] {
  const out: TargetAccountSpec[] = [];
  const genders: { gender: 'male' | 'female'; label: string; suffix: 'g' | 'b' }[] = [
    { gender: 'female', label: 'Girls', suffix: 'g' },
    { gender: 'male', label: 'Boys', suffix: 'b' },
  ];
  if (targetCohort === 'none') {
    for (const bracket of gradeBrackets(gradeMin, gradeMax)) {
      for (const g of genders) {
        out.push({
          role: 'grade',
          username: `grade${bracket.join('')}${g.suffix}`,
          displayName: `${gradeWordLabel(bracket, gradeWord)} ${g.label}`,
          grades: bracket,
          gender: g.gender,
        });
      }
    }
  } else {
    for (let grade = gradeMin; grade <= gradeMax; grade++) {
      for (const g of genders) {
        out.push({
          role: 'grade',
          username: `grade${grade}${g.suffix}`,
          displayName: `${gradeWordLabel([grade], gradeWord)} ${g.label}`,
          grades: [grade],
          gender: g.gender,
        });
      }
    }
    for (const q of QUAD_TARGETS) {
      out.push({ role: 'quad', username: q.quad, displayName: q.label, quad: q.quad });
    }
  }
  return out;
}

function sameGradeSet(a: number[] | null | undefined, b: number[]): boolean {
  if (!a || a.length !== b.length) return false;
  const as = [...a].sort((x, y) => x - y);
  const bs = [...b].sort((x, y) => x - y);
  return as.every((v, i) => v === bs[i]);
}

// Compares a username-matched existing account against the target spec that
// username maps to. Only compares a field when the caller actually supplied
// it (undefined = "not checked, don't flag") — see ExistingAccountLite. A
// role mismatch alone is reported without also comparing grades/gender/quad,
// since those comparisons wouldn't mean anything across different roles.
function findMismatchReason(existingAcct: ExistingAccountLite, target: TargetAccountSpec): string | null {
  if (existingAcct.role !== target.role) {
    return `expected role "${target.role}", found "${existingAcct.role}"`;
  }
  const reasons: string[] = [];
  if (target.role === 'grade') {
    if (existingAcct.grades !== undefined && !sameGradeSet(existingAcct.grades, target.grades)) {
      reasons.push(`expected grades [${target.grades.join(',')}], found [${(existingAcct.grades || []).join(',')}]`);
    }
    if (existingAcct.gender !== undefined && existingAcct.gender !== target.gender) {
      reasons.push(`expected gender "${target.gender}", found "${existingAcct.gender ?? 'none'}"`);
    }
  } else if (existingAcct.quad !== undefined && existingAcct.quad !== target.quad) {
    reasons.push(`expected quad "${target.quad}", found "${existingAcct.quad ?? 'none'}"`);
  }
  return reasons.length ? reasons.join('; ') : null;
}

// Diff the target account set against what already exists. Accounts are
// matched by username (case-insensitive) only — an existing account with a
// matching username is left completely alone (never edited/reactivated),
// whatever its current role/grades/gender/status; a grade/quad account whose
// username ISN'T part of the target set is flagged for deactivation, never
// deletion, matching the rest of this app's "never delete accounts
// automatically" convention (see the orphaned-accounts note in
// _youthSetupBody, public/index.html). `mismatched` is a separate,
// informational-only list of matched accounts whose role/grades/gender/quad
// have drifted from what their username implies — never auto-fixed, same
// "never silently edit" rule as everything else here.
export function planCohortAccountLayout(
  targetCohort: CohortModel,
  gradeMin: number,
  gradeMax: number,
  gradeWord: string,
  existing: ExistingAccountLite[],
): CohortLayoutPlan {
  const targets = buildTargetAccounts(targetCohort, gradeMin, gradeMax, gradeWord);
  const existingUsernames = new Set(existing.map((u) => u.email.toLowerCase()));
  const targetUsernames = new Set(targets.map((t) => t.username.toLowerCase()));
  const targetsByUsername = new Map(targets.map((t) => [t.username.toLowerCase(), t]));

  const toCreate = targets.filter((t) => !existingUsernames.has(t.username.toLowerCase()));
  const toDeactivate = existing
    .filter((u) => (u.role === 'grade' || u.role === 'quad') && u.status === 'active' && !targetUsernames.has(u.email.toLowerCase()))
    .map((u) => ({ id: u.id, username: u.email, displayName: u.displayName }));

  const mismatched: CohortLayoutMismatch[] = [];
  for (const u of existing) {
    if ((u.role !== 'grade' && u.role !== 'quad') || u.status !== 'active') continue;
    const target = targetsByUsername.get(u.email.toLowerCase());
    if (!target) continue;
    const reason = findMismatchReason(u, target);
    if (reason) mismatched.push({ id: u.id, username: u.email, displayName: u.displayName, reason });
  }

  return { targetCohort, toCreate, toDeactivate, mismatched };
}
