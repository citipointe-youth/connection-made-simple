-- Structured per-deployment configuration (branding, terminology, structure,
-- roles, modules, import dialect). An empty object is the intended default —
-- every reader treats {} as "YS Brisbane / current behaviour" via
-- MINISTRY_CONFIG_DEFAULTS in src/core/ministry-config.ts, which is the single
-- source of truth for what each key defaults to. No SQL-level per-key defaults
-- are needed here.
alter table app_settings
  add column if not exists ministry_config jsonb not null default '{}'::jsonb;
