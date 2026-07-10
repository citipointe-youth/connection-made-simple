import { describe, it, expect } from 'vitest';
import { makeManifestController } from '../api/controllers/manifest.controller';
import { MINISTRY_CONFIG_DEFAULTS, mergeMinistryConfig } from '../core/ministry-config';
import type { HttpRequest } from '../api/http/types';
import type { SettingsService } from '../services/settings.service';

function req(): HttpRequest {
  return { ctx: null, params: {}, query: {}, body: undefined };
}

describe('manifest controller', () => {
  it('reflects branding.appName/shortName/accent from settings', async () => {
    const settings = {
      get: async () => ({
        id: 'global', termGapDays: 14, validThresholdPct: 25, serviceMinAttendance: 100,
        ministryConfig: mergeMinistryConfig(MINISTRY_CONFIG_DEFAULTS, {
          branding: { appName: 'Test Youth App', shortName: 'TYA', accent: '#ff0000' },
        }),
        updatedAt: new Date().toISOString(),
      }),
    } as unknown as SettingsService;

    const ctrl = makeManifestController({ settings });
    const manifest = await ctrl.get(req()) as any;

    expect(manifest.name).toBe('Test Youth App');
    expect(manifest.short_name).toBe('TYA');
    expect(manifest.theme_color).toBe('#ff0000');
    expect(manifest.display).toBe('standalone');
    expect(Array.isArray(manifest.icons)).toBe(true);
  });

  it('defaults to the current YS Brisbane identity when ministryConfig is untouched', async () => {
    const settings = {
      get: async () => ({
        id: 'global', termGapDays: 14, validThresholdPct: 25, serviceMinAttendance: 100,
        ministryConfig: MINISTRY_CONFIG_DEFAULTS,
        updatedAt: new Date().toISOString(),
      }),
    } as unknown as SettingsService;

    const ctrl = makeManifestController({ settings });
    const manifest = await ctrl.get(req()) as any;

    expect(manifest.name).toBe('YS Connection');
    expect(manifest.short_name).toBe('Connection');
    expect(manifest.theme_color).toBe('#1a1af2');
  });
});
