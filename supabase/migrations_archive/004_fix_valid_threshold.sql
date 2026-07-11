-- Fix valid_threshold_pct: change default from 10% to 50%.
-- The TypeScript DEFAULT_SETTINGS already uses 50, but the SQL column default
-- was set to 10 in migration 001. Any settings row created before this migration
-- may still have the old value of 10.

alter table app_settings
  alter column valid_threshold_pct set default 50;

-- Update the singleton settings row if it still holds the old default.
update app_settings
  set valid_threshold_pct = 50
  where id = 'global'
    and valid_threshold_pct = 10;
