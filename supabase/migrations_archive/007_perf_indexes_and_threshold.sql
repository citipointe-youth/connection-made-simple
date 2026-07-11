-- Performance indexes + corrected "valid session" threshold default.
--
-- 1. Secondary indexes for the lookups that previously did full table scans.
--    (Composite PKs/uniques already cover their leading column, so we only add
--    indexes for the *trailing* / non-key columns we filter on.)

-- connections: unique(student_id, leader_id) covers student_id lookups but not
-- leader_id — findByLeader was scanning the whole table.
create index if not exists idx_connections_leader_id on connections (leader_id);

-- service_attendance: PK is (student_id, session_id); add session_id for findBySession.
create index if not exists idx_service_attendance_session_id on service_attendance (session_id);

-- lifegroup_attendance: PK is (student_id, week_id). Add the other foreign keys
-- so the per-lifegroup and per-week reads (student profile, "My Students",
-- per-lifegroup unique/average) don't scan the table.
create index if not exists idx_lifegroup_attendance_lifegroup_id on lifegroup_attendance (lifegroup_id);
create index if not exists idx_lifegroup_attendance_week_id on lifegroup_attendance (week_id);

-- 2. "Valid session threshold" now means: ignore weeks below this % of the
--    MEDIAN week (holidays/camps) when averaging attendance. The old default of
--    50 (interpreted against the mean) discarded normal low weeks and inflated
--    the average. 25% of the median drops only near-empty weeks.
alter table app_settings
  alter column valid_threshold_pct set default 25;

update app_settings
  set valid_threshold_pct = 25
  where id = 'global';
