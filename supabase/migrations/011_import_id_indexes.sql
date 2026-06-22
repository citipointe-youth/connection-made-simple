-- 011: covering indexes for the import_id foreign keys.
--
-- service_sessions.import_id and lifegroup_weeks.import_id had no covering index
-- (flagged by the Supabase performance advisor, lint 0001_unindexed_foreign_keys).
-- These speed up findByImport() and the delete-by-import subqueries used during CSV
-- import and replace-data, and clear the lint. Additive only — indexes never change
-- query results, just access cost, with a tiny write overhead on import (rare).
create index if not exists idx_service_sessions_import_id on public.service_sessions (import_id);
create index if not exists idx_lifegroup_weeks_import_id  on public.lifegroup_weeks  (import_id);
