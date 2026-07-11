-- One-off cleanup: notification_recipients / notifications / push_subscriptions
-- were created ad hoc via docs/push_subscriptions.sql (NEVER a tracked
-- migration — following supabase/migrations_archive/016_enable_rls_remaining.sql's
-- RLS-enable statements on a truly fresh project would otherwise fail with
-- "relation does not exist", since nothing ever created these tables there).
-- The notifications feature's application code is being retired, so these
-- tables become dead weight. Idempotent no-op on a fresh deployment (never
-- created there); on prod this genuinely drops the orphaned tables and their
-- data. Run once against prod, then move this file to
-- supabase/migrations_archive/ — it has no further purpose after that.
drop table if exists notification_recipients cascade;
drop table if exists notifications cascade;
drop table if exists push_subscriptions cascade;
