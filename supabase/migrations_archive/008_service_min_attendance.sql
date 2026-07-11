-- A "valid service" is a Friday whose TOTAL ministry attendance is >= this
-- threshold. Sessions below it are disregarded entirely (not counted in any
-- average or attendance-rate denominator) — treated like a week the ministry
-- didn't meet. Default 100.
alter table app_settings
  add column if not exists service_min_attendance int not null default 100;
