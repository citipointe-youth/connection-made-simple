-- Multi-grade grade accounts (§5.1a of the generalisation design).
--
-- A grade login could previously manage exactly one grade (`grade`). It can now
-- span one OR more grades via the `grades` jsonb array, with an explicit gender
-- scope (`gender`) set at account creation — the grade7g/grade7b email regex
-- only encodes a single grade number and doesn't generalise to a list.
--
-- Additive and back-compat: existing single-grade accounts keep `grades = null`
-- / `gender = null` and continue to work through the legacy `grade` column and
-- the email-derived gender convention (actorGrades() / deriveActorGender() fall
-- back to them). No backfill — an empty value means "legacy single-grade
-- behaviour", exactly like the pre-generalisation code path.
alter table users
  add column if not exists grades jsonb;

alter table users
  add column if not exists gender text;
