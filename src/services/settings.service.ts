import { z } from 'zod';
import { assertCan } from './access-control';
import type { ISettingsRepository, IAuditRepository, IUserRepository } from '../repositories/interfaces/entity-repositories';
import type { AppSettings } from '../core/entities/settings';
import type { Actor } from '../core/entities/user';
import type { UserRole } from '../core/types/enums';
import { generateId } from '../utils/id';
import { mergeMinistryConfig } from '../core/ministry-config';
import { invalidateOverviewCache } from './overview.service';
import { invalidateTrendsCache } from './trends.service';
import { invalidateLgStatsCache } from './lifegroup-stats.service';
import { BadRequestError } from '../core/errors/app-error';

// The optional roles a ministry can switch off in Setup (Admin always exists
// and isn't toggleable — see ministry-config.ts). User.role values match these
// names exactly, so no extra mapping is needed to find the accounts a toggle covers.
const OPTIONAL_ROLES: Exclude<UserRole, 'admin'>[] = ['director', 'grade', 'quad', 'leader'];

const SettingsPatchSchema = z.object({
  termGapDays: z.number().int().min(1).optional(),
  validThresholdPct: z.number().min(0).max(100).optional(),
  serviceMinAttendance: z.number().int().min(0).optional(),
  // Validated structurally by mergeMinistryConfig (which re-runs the full
  // MinistryConfigSchema after merging) — accept any partial shape here so a
  // deep-partial patch like {branding:{accent:'#fff'}} isn't rejected up front.
  ministryConfig: z.record(z.unknown()).optional(),
});

export interface SettingsService {
  get(): Promise<AppSettings>;
  update(actor: Actor, input: unknown): Promise<AppSettings>;
}

export function makeSettingsService(
  repo: ISettingsRepository,
  audit: IAuditRepository,
  users: IUserRepository,
): SettingsService {
  return {
    async get() {
      return repo.getSettings();
    },

    async update(actor, input) {
      assertCan(actor, 'admin:manage');
      const patch = SettingsPatchSchema.parse(input);

      const ministryConfigPatch = patch.ministryConfig as Record<string, unknown> | undefined;
      if (ministryConfigPatch) {
        const branding = ministryConfigPatch['branding'] as Record<string, unknown> | undefined;
        // logoImage is a client-baked data URI (crop tool output) — no server-side
        // re-encoding, just a shape check. The Zod schema's .max() already caps size.
        // (Raw-SVG-paste branding was removed 2026-07-12 — see ministry-config.ts.)
        const logoImage = branding ? branding['logoImage'] : undefined;
        if (logoImage !== undefined && logoImage !== null && !(typeof logoImage === 'string' && logoImage.startsWith('data:image/'))) {
          throw new BadRequestError('branding.logoImage must be null or a data:image/... URI');
        }
      }

      const { ministryConfig: _omit, ...scalarPatch } = patch;
      const update: Partial<AppSettings> = { ...scalarPatch };

      // Roles newly turned OFF by this save (compared against the pre-save config) —
      // computed before repo.updateSettings() so we still have both the old and new
      // enabled-map to diff. Deactivation itself runs after the settings write
      // succeeds (below), matching the confirm-then-cascade shape of a live setting.
      let rolesJustDisabled: UserRole[] = [];

      if (ministryConfigPatch !== undefined) {
        const current = await repo.getSettings();
        const merged = mergeMinistryConfig(current.ministryConfig, ministryConfigPatch);
        update.ministryConfig = merged;

        const before = current.ministryConfig.roles?.enabled;
        const after = merged.roles.enabled;
        rolesJustDisabled = OPTIONAL_ROLES.filter((r) => before?.[r] !== false && after[r] === false);
      }

      if (Object.keys(patch).length > 0) {
        await audit.save({
          id: generateId(),
          action: 'settings-update',
          performedBy: actor.displayName,
          performedAt: new Date().toISOString(),
          detail: `Settings updated: ${Object.keys(patch).join(', ')}`,
        });
      }

      const updated = await repo.updateSettings({ ...update, updatedAt: new Date().toISOString() });

      // A role toggled OFF in Setup deactivates every currently-active account of
      // that role — the Accounts screen also hides that role's whole section
      // while disabled (index.html), so a leftover active account there would be
      // both unreachable to manage AND still able to log in. Turning the role
      // back ON later does NOT auto-reactivate these — deliberate: an admin who'd
      // separately deactivated one of these accounts for an unrelated reason
      // shouldn't have that overridden by an unrelated toggle. Re-activation is
      // manual, via the existing per-account lock/unlock in Accounts.
      for (const role of rolesJustDisabled) {
        const accounts = await users.findByRole(role);
        for (const u of accounts) {
          if (u.status !== 'active') continue;
          await users.save({ ...u, status: 'inactive', updatedAt: new Date().toISOString() });
        }
      }

      // Fix for the pre-existing invalidation gap: any settings change (term
      // math, min-attendance floor, or ministryConfig) could affect the three
      // 60s actor-keyed stats caches, which previously had no invalidation
      // hook on this path at all — see design doc / CLAUDE.md's "Settings
      // updates invalidate NO caches" gotcha.
      invalidateOverviewCache();
      invalidateTrendsCache();
      invalidateLgStatsCache();

      return updated;
    },
  };
}
