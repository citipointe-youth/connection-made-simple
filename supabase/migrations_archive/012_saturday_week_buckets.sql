-- Migrate lifegroup week_start dates from Monday-bucketed to Saturday-bucketed.
--
-- Previously, each lifegroup week's start date was set to the Monday on or before
-- the meeting date (Mon–Sun weeks). The application now uses Sat–Fri week buckets
-- so that service Fridays and lifegroup Mondays fall in the same week bucket.
-- A Monday is always 2 days after the preceding Saturday, so we subtract 2 days.
--
-- All existing week_start values are Mondays (day_of_week = 1), so the shift is
-- uniform. The import service will write Saturday values for all future imports.

UPDATE lifegroup_weeks
SET week_start = (week_start::date - INTERVAL '2 days')::date
WHERE EXTRACT(DOW FROM week_start::date) = 1; -- 1 = Monday
