import { z } from 'zod';
import { assertCan } from './access-control';
import type { ISettingsRepository, IAuditRepository } from '../repositories/interfaces/entity-repositories';
import type { AppSettings } from '../core/entities/settings';
import type { Actor } from '../core/entities/user';
import { generateId } from '../utils/id';

const SettingsPatchSchema = z.object({
  ministryName: z.string().min(1).optional(),
  termGapDays: z.number().int().min(1).optional(),
  regRateNumerator: z.number().int().min(1).optional(),
  regRateDenominator: z.number().int().min(1).optional(),
  riskRateNumerator: z.number().int().min(1).optional(),
  riskRateDenominator: z.number().int().min(1).optional(),
  validThresholdPct: z.number().min(0).max(100).optional(),
  serviceMinAttendance: z.number().int().min(0).optional(),
  serviceName: z.string().min(1).optional(),
  lifegroupName: z.string().min(1).optional(),
  connectionLockDate: z.string().nullable().optional(),
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
      const current = await repo.getSettings();

      // Log lock date changes specifically
      if (patch.connectionLockDate !== undefined && patch.connectionLockDate !== current.connectionLockDate) {
        const detail = patch.connectionLockDate
          ? `Connection lock date set to ${patch.connectionLockDate}`
          : 'Connection lock date cleared';
        await audit.save({
          id: generateId(),
          action: 'lock-date-set',
          performedBy: actor.displayName,
          performedAt: new Date().toISOString(),
          detail,
        });
      } else if (Object.keys(patch).length > 0) {
        await audit.save({
          id: generateId(),
          action: 'settings-update',
          performedBy: actor.displayName,
          performedAt: new Date().toISOString(),
          detail: `Settings updated: ${Object.keys(patch).join(', ')}`,
        });
      }

      return repo.updateSettings({ ...patch, updatedAt: new Date().toISOString() });
    },
  };
}
