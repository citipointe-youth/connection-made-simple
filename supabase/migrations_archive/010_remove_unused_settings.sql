-- Remove unused / retired settings columns from app_settings.
--   ministry_name, service_name, lifegroup_name  — cosmetic, never read by the app.
--   connection_lock_date                          — the connection-lock feature was removed.
--   reg_rate_*, risk_rate_*                        — at-risk thresholds replaced by the
--                                                    dynamic rising/declining model (computed
--                                                    from attendance, no thresholds).
-- Kept: term_gap_days, valid_threshold_pct, service_min_attendance.
alter table app_settings drop column if exists ministry_name;
alter table app_settings drop column if exists service_name;
alter table app_settings drop column if exists lifegroup_name;
alter table app_settings drop column if exists connection_lock_date;
alter table app_settings drop column if exists reg_rate_numerator;
alter table app_settings drop column if exists reg_rate_denominator;
alter table app_settings drop column if exists risk_rate_numerator;
alter table app_settings drop column if exists risk_rate_denominator;
