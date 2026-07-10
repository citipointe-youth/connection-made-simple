import { z } from 'zod';

// Per-deployment configuration: branding, terminology, structure, roles, modules,
// and import dialect. An empty/absent value at any level always means "YS
// Brisbane behaviour" — every default below is the current, unconfigured
// behaviour of the app, verbatim. See CLAUDE.md / the generalisation design doc
// for the full rationale; this file is the single source of truth for defaults
// (repos and the SPA's mirror both read MINISTRY_CONFIG_DEFAULTS, never redeclare
// them).

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex colour (e.g. #1a1af2)');

// 'two-bracket' was dropped 2026-07-10: a medium ministry wanting bracket-sized
// cohorts now just creates broader grade-equivalent accounts (1+ grades each)
// under 'large-graded-au' and skips creating quad accounts — an account-creation
// choice, not a ministryConfig difference. See CLAUDE.md / design doc §5.1a.
export const MINISTRY_PRESETS = ['large-graded-au', 'small-flat', 'micro'] as const;
export type MinistryPreset = (typeof MINISTRY_PRESETS)[number];

export const MinistryConfigSchema = z.object({
  version: z.literal(1).default(1),
  preset: z.enum(MINISTRY_PRESETS).default('large-graded-au'),

  branding: z
    .object({
      ministryName: z.string().max(60).default('Youth Society Brisbane'),
      appName: z.string().max(40).default('YS Connection'),
      shortName: z.string().max(15).default('Connection'),
      accent: hexColour.default('#1a1af2'),
      accentDark: hexColour.default('#1111c9'),
      accentLight: hexColour.default('#ececff'),
      navy: hexColour.default('#0a0a2e'),
      logoSvg: z.string().max(20_000).nullable().default(null),
    })
    .default({}),

  labels: z
    .object({
      smallGroup: z.string().max(40).default('Lifegroup'),
      smallGroupPlural: z.string().max(40).default('Lifegroups'),
      service: z.string().max(40).default('Youth'),
      serviceNight: z.string().max(40).default('Friday Nights'),
      studentTeam: z.string().max(40).default('Student Team'),
      connection: z.string().max(40).default('Connection'),
      groupNameStrip: z.array(z.string()).default(['Brisbane - YS - ']),
    })
    .default({}),

  structure: z
    .object({
      // Only two values (design §5.1a) — grade-equivalent accounts (one or
      // more grades each) are always the base under 'grades-quads'; whether
      // any quad-equivalent rollup accounts exist is an independent,
      // per-account-creation choice, not a cohortModel value.
      cohortModel: z.enum(['grades-quads', 'none']).default('grades-quads'),
      gradeMin: z.number().int().default(7),
      gradeMax: z.number().int().default(12),
      gradeLabel: z.string().max(20).default('Grade'),
      brackets: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            gradeMin: z.number().int(),
            gradeMax: z.number().int(),
          }),
        )
        .default([
          { id: '79', label: 'Yr 7–9', gradeMin: 7, gradeMax: 9 },
          { id: '1012', label: 'Yr 10–12', gradeMin: 10, gradeMax: 12 },
        ]),
      genderPolicy: z.enum(['strict', 'soft', 'off']).default('strict'),
      serviceDayOfWeek: z.number().int().min(0).max(6).default(5),
    })
    .default({}),

  roles: z
    .object({
      model: z.enum(['graded', 'flat']).default('graded'),
      labels: z
        .object({
          admin: z.string().max(30).default('Admin'),
          director: z.string().max(30).default('Director'),
          leader: z.string().max(30).default('Leader'),
          grade: z.string().max(30).default('Grade'),
          quad: z.string().max(30).default('Quad'),
        })
        .default({}),
    })
    .default({}),

  modules: z
    .object({
      connectionAudit: z.boolean().default(true),
      lifegroups: z.boolean().default(true),
      pushNotifications: z.boolean().default(false),
      exportGuides: z.enum(['elvanto', 'hidden']).default('elvanto'),
    })
    .default({}),

  import: z
    .object({
      dateOrder: z.enum(['DMY', 'MDY']).default('DMY'),
      leaderTag: z.string().max(20).default('leader'),
    })
    .default({}),
});

export type MinistryConfig = z.infer<typeof MinistryConfigSchema>;

// The inclusive list of grade numbers a deployment uses (structure.gradeMin..
// gradeMax). Replaces the hardcoded [7..12] iterations in the aggregate
// builders and the import range check. Defaults yield [7,8,9,10,11,12].
export function gradeRange(structure: { gradeMin: number; gradeMax: number }): number[] {
  const out: number[] = [];
  for (let g = structure.gradeMin; g <= structure.gradeMax; g++) out.push(g);
  return out;
}

// Applying the schema to {} yields every default in one nested object — this IS
// the canonical "empty config" value. Exported as a plain object (not a getter)
// so callers can deep-equal against it in tests without re-invoking Zod.
export const MINISTRY_CONFIG_DEFAULTS: MinistryConfig = MinistryConfigSchema.parse({});

// Per-preset overrides applied on top of the defaults when an admin picks a
// preset in the Youth Ministry Setup wizard. `large-graded-au` is intentionally
// `{}` — it IS the default, so picking it is always a no-op (acceptance
// criterion #1). serviceMinAttendance is scaled here too even though it lives
// on AppSettings, not inside ministryConfig — see PRESET_SERVICE_MIN_ATTENDANCE.
export const PRESET_CONFIGS: Record<MinistryPreset, Record<string, unknown>> = {
  'large-graded-au': {},
  'small-flat': {
    preset: 'small-flat',
    structure: { cohortModel: 'none', genderPolicy: 'soft' },
    roles: {
      model: 'flat',
      labels: { admin: 'Youth Pastor', director: 'Senior Leader', leader: 'Junior Leader' },
    },
    modules: { connectionAudit: false, lifegroups: true },
  },
  micro: {
    preset: 'micro',
    structure: { cohortModel: 'none', genderPolicy: 'off' },
    roles: {
      model: 'flat',
      labels: { admin: 'Youth Pastor', director: 'Senior Leader', leader: 'Junior Leader' },
    },
    modules: { connectionAudit: false, lifegroups: false, exportGuides: 'hidden' },
  },
};

// serviceMinAttendance defaults to 100 (a whole-ministry Friday-attendance floor)
// which computes zero valid services for a small ministry. Presets scale it —
// see design doc 03 §6.2 point 7 / doc 01's "one default breaks small ministries"
// finding. Applied by the Setup wizard's preset step alongside PRESET_CONFIGS,
// as a second field in the same PATCH /settings call.
export const PRESET_SERVICE_MIN_ATTENDANCE: Record<MinistryPreset, number> = {
  'large-graded-au': 100,
  'small-flat': 10,
  micro: 0,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge a partial patch onto a base value. Arrays and primitives in the
// patch fully replace the base value at that key; plain objects merge key-by-key.
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = isPlainObject(base) ? { ...(base as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject((base as Record<string, unknown> | undefined)?.[k])
      ? deepMerge((base as Record<string, unknown>)[k], v)
      : v;
  }
  return out as T;
}

// Deep-merge an arbitrary (already-validated-shape-agnostic) patch onto a full
// base config, then re-validate the merged result end to end. This is the ONLY
// path that should ever produce a stored MinistryConfig from a partial PATCH —
// callers must not merge configs by hand.
export function mergeMinistryConfig(base: MinistryConfig, patch: unknown): MinistryConfig {
  const merged = deepMerge(base, patch);
  return MinistryConfigSchema.parse(merged);
}

// Admin-supplied logo SVG is rendered via innerHTML in the SPA (brandMark()) —
// this is a blunt denylist, not a real HTML/SVG parser, but it's cheap
// defence-in-depth for what is otherwise admin-only, audit-logged input.
const DANGEROUS_SVG_RE = /<script[\s\S]*?<\/script>|<foreignObject[\s\S]*?<\/foreignObject>|\son\w+\s*=\s*(["']).*?\1/gi;
export function sanitiseLogoSvg(svg: string): string {
  return svg.replace(DANGEROUS_SVG_RE, '');
}
