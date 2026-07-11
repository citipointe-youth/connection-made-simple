-- The `leader` (junior leader) role (§5.2 of the generalisation design).
--
-- A junior-leader account is bound to one Leader record via `leader_id` and sees
-- ONLY that leader's connected students. Additive and back-compat: every existing
-- account leaves this null (no account is a `leader` until an admin creates one),
-- so pre-generalisation behaviour is unchanged. No FK constraint — leader records
-- are import-managed and can be recreated (New Year Refresh), and a dangling
-- leader_id simply yields an empty connection set, never an error.
alter table users
  add column if not exists leader_id text;
