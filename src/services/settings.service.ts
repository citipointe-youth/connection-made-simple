import { z } from 'zod';
import { assertCan } from './access-control';
import type { ISettingsRepository, IAuditRepository } from '../repositories/interfaces/entity-repositories';
import type { AppSettings } from '../core/entities/settings';
import type { Actor } from '../core/entities/user';
import { generateId } from '../utils/id';
import { mergeMinistryConfig, sanitiseLogoSvg } from '../core/ministry-config';
import { invalidateOverviewCache } from './overview.service';
import { invalidateTrendsCache } from './trends.service';
import { invalidateLgStatsCache } from './lifegroup-stats.service';

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
): SettingsService {
  return {
    async get() {
      return repo.getSettings();
    },

    async update(actor, input) {
      assertCan(actor, 'admin:manage');
      const patch = SettingsPatchSchema.parse(input);

      let ministryConfigPatch = patch.ministryConfig as Record<string, unknown> | undefined;
      if (ministryConfigPatch) {
        const branding = ministryConfigPatch['branding'] as Record<string, unknown> | undefined;
        if (branding && typeof branding['logoSvg'] === 'string') {
          ministryConfigPatch = {
            ...ministryConfigPatch,
            branding: { ...branding, logoSvg: sanitiseLogoSvg(branding['logoSvg']) },
          };
        }
      }

      const { ministryConfig: _omit, ...scalarPatch } = patch;
      const update: Partial<AppSettings> = { ...scalarPatch };

      if (ministryConfigPatch !== undefined) {
        const current = await repo.getSettings();
        update.ministryConfig = mergeMinistryConfig(current.ministryConfig, ministryConfigPatch);
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
