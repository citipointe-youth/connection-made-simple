import { describe, it, expect } from 'vitest';
import {
  MinistryConfigSchema,
  MINISTRY_CONFIG_DEFAULTS,
  PRESET_CONFIGS,
  mergeMinistryConfig,
  sanitiseLogoSvg,
} from '../core/ministry-config';

describe('MinistryConfigSchema', () => {
  it('parses {} into MINISTRY_CONFIG_DEFAULTS, matching current YS Brisbane behaviour', () => {
    expect(MinistryConfigSchema.parse({})).toEqual(MINISTRY_CONFIG_DEFAULTS);
  });

  it('defaults every branding field to the current hardcoded values', () => {
    expect(MINISTRY_CONFIG_DEFAULTS.branding.ministryName).toBe('Youth Society Brisbane');
    expect(MINISTRY_CONFIG_DEFAULTS.branding.appName).toBe('YS Connection');
    expect(MINISTRY_CONFIG_DEFAULTS.branding.accent).toBe('#1a1af2');
    expect(MINISTRY_CONFIG_DEFAULTS.modules.pushNotifications).toBe(false);
    expect(MINISTRY_CONFIG_DEFAULTS.modules.connectionAudit).toBe(true);
    expect(MINISTRY_CONFIG_DEFAULTS.structure.cohortModel).toBe('grades-quads');
  });

  it('rejects an invalid hex colour', () => {
    expect(() => MinistryConfigSchema.parse({ branding: { accent: 'blue' } })).toThrow();
  });

  it('the large-graded-au preset is a no-op (acceptance criterion #1)', () => {
    const merged = mergeMinistryConfig(MINISTRY_CONFIG_DEFAULTS, PRESET_CONFIGS['large-graded-au']);
    expect(merged).toEqual(MINISTRY_CONFIG_DEFAULTS);
  });
});

describe('mergeMinistryConfig', () => {
  it('deep-merges a partial patch, leaving every other field at its default', () => {
    const merged = mergeMinistryConfig(MINISTRY_CONFIG_DEFAULTS, { branding: { accent: '#ff0000' } });
    expect(merged.branding.accent).toBe('#ff0000');
    expect(merged.branding.ministryName).toBe(MINISTRY_CONFIG_DEFAULTS.branding.ministryName);
    expect(merged.labels).toEqual(MINISTRY_CONFIG_DEFAULTS.labels);
    expect(merged.structure).toEqual(MINISTRY_CONFIG_DEFAULTS.structure);
  });

  it('applies the small-flat preset overrides on top of defaults', () => {
    const merged = mergeMinistryConfig(MINISTRY_CONFIG_DEFAULTS, PRESET_CONFIGS['small-flat']);
    expect(merged.structure.cohortModel).toBe('none');
    expect(merged.roles.model).toBe('flat');
    expect(merged.roles.labels.admin).toBe('Youth Pastor');
    expect(merged.modules.connectionAudit).toBe(false);
    expect(merged.modules.lifegroups).toBe(true);
    // Untouched by the preset — still default
    expect(merged.branding.accent).toBe(MINISTRY_CONFIG_DEFAULTS.branding.accent);
  });

  it('throws when the merged result is invalid', () => {
    expect(() => mergeMinistryConfig(MINISTRY_CONFIG_DEFAULTS, { branding: { accent: 'not-a-colour' } })).toThrow();
  });
});

describe('sanitiseLogoSvg', () => {
  it('strips script tags and event handler attributes', () => {
    const dirty = '<svg><script>alert(1)</script><rect onclick="alert(2)" width="1"/></svg>';
    const clean = sanitiseLogoSvg(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onclick');
  });

  it('leaves a clean SVG untouched', () => {
    const clean = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    expect(sanitiseLogoSvg(clean)).toBe(clean);
  });
});
